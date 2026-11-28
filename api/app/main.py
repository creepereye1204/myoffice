"""rhwp office API — 파일 저장소 + ONLYOFFICE 연동 + HWP 저장.

인증 모델: 계정(회원가입/로그인) → 세션 토큰을 Authorization: Bearer 로 보낸다.
각 계정은 내부 저장 폴더(ws)를 하나 가진다. 파일 공유는 (1) 특정 사용자에게 보기/편집 권한,
(2) 링크(X-Share 토큰, 로그인 없이) 두 가지. 관리자는 ADMIN_USERNAME/ADMIN_PASSWORD 로 자동 생성.
ONLYOFFICE 서버가 호출하는 내부 경로(/internal/*)는 HMAC 서명으로 보호한다.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import secrets
import shutil
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal, Optional
from urllib.parse import quote, urlsplit

import httpx
import jwt
from fastapi import Depends, FastAPI, File, Header, HTTPException, Query, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.exception_handlers import http_exception_handler
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from prometheus_client import Counter, Histogram, start_http_server
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import MutableHeaders
from starlette.exceptions import HTTPException as StarletteHTTPException

from .admin_dashboard import AdminDashboard
from .error_reporting import CLIENT_BATCH, ErrorLogs, RequestErrors, remember_document, scrub
from .feedback_images import prepare_feedback_images, read_feedback_request

DATA_DIR = Path(os.environ.get("DATA_DIR", "/data"))
error_logs = ErrorLogs(DATA_DIR / "logs")
TEMPLATE_DIR = Path(os.environ.get("TEMPLATE_DIR", "/app/templates"))
JWT_SECRET = os.environ["JWT_SECRET"]
SIGN_SECRET = os.environ["SIGN_SECRET"].encode()
# 브라우저가 보는 ONLYOFFICE 주소 / API 컨테이너가 보는 ONLYOFFICE 주소
DS_PUBLIC_PATH = "/office/"  # 프론트 nginx가 ONLYOFFICE를 프록시하는 경로 (도메인 무관)
DS_INTERNAL_URL = os.environ.get("DS_INTERNAL_URL", "http://onlyoffice/").rstrip("/") + "/"
# ONLYOFFICE 컨테이너가 이 API에 닿는 주소 (도커 네트워크 내부)
API_INTERNAL_URL = os.environ.get("API_INTERNAL_URL", "http://api:8000").rstrip("/")
CORS_ORIGINS = [o.strip() for o in os.environ.get("CORS_ORIGINS", "https://www.myoffice.p-e.kr").split(",") if o.strip()]
MAX_FILE_BYTES = int(os.environ.get("MAX_FILE_MB", "50")) * 1024 * 1024
MAX_WS_BYTES = int(os.environ.get("MAX_WORKSPACE_MB", "500")) * 1024 * 1024
MAX_FILES = int(os.environ.get("MAX_FILES", "300"))

TIME_BUCKETS = (0, .001, .0025, .005, .01, .025, .05, .1, .25, .5, 1, 2.5, 5, 10, 20, 30, 60, 120)
BYTE_BUCKETS = (0, 512, 1024, 4096, 16384, 65536, 262144, 1048576, 4194304, 16777216, 67108864, 500000000)
HTTP_DURATION = Histogram("myoffice_http_request_duration_seconds", "응답 헤더까지 걸린 시간",
                          ["method", "route", "status"], buckets=TIME_BUCKETS)
HTTP_RESPONSE_BYTES = Histogram("myoffice_http_response_bytes", "응답 본문 바이트", ["route"], buckets=BYTE_BUCKETS)
HTTP_REQUEST_BYTES = Histogram("myoffice_http_request_bytes", "읽은 요청 본문 바이트", ["route"], buckets=BYTE_BUCKETS)
OO_CONVERT = Histogram("myoffice_oo_convert_seconds", "문서 변환과 결과 다운로드 시간", ["to"], buckets=TIME_BUCKETS)
OO_FORCESAVE = Histogram("myoffice_oo_forcesave_seconds", "강제 저장 확인 시간", ["result"], buckets=TIME_BUCKETS)
RUM_SEGMENTS = ("dns", "connect", "tls", "ttfb", "download", "total")
RUM_DURATION = Histogram("myoffice_rum_segment_seconds", "브라우저 구간별 시간",
                         ["kind", "segment", "page"], buckets=TIME_BUCKETS)
RUM_TRANSFER = Histogram("myoffice_rum_transfer_bytes", "브라우저 전송 바이트",
                         ["kind", "page"], buckets=BYTE_BUCKETS)
RUM_RESOURCES = Counter("myoffice_rum_resources_total", "브라우저 리소스 수", ["kind", "cached", "page"])
FEEDBACK_TOTAL = Counter("myoffice_feedback_total", "접수한 의견 수", ["kind"])
HTTP_METHODS = {"GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "CONNECT", "TRACE"}
TIMING_ORIGINS = ", ".join(origin for origin in CORS_ORIGINS if origin != "*")


class HTTPMetrics:
    """본문을 미리 읽거나 버퍼링하지 않고 ASGI 메시지를 계측한다."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        started = time.perf_counter()
        elapsed = None
        status = 500
        request_bytes = response_bytes = 0

        async def counted_receive():
            nonlocal request_bytes
            message = await receive()
            if message["type"] == "http.request":
                request_bytes += len(message.get("body", b""))
            return message

        async def counted_send(message):
            nonlocal elapsed, status, response_bytes
            if message["type"] == "http.response.start":
                status = message["status"]
                elapsed = time.perf_counter() - started
                if TIMING_ORIGINS:
                    MutableHeaders(scope=message)["Timing-Allow-Origin"] = TIMING_ORIGINS
            await send(message)
            if message["type"] == "http.response.body" and scope["method"] != "HEAD":
                response_bytes += len(message.get("body", b""))

        try:
            await self.app(scope, counted_receive, counted_send)
        finally:
            route = getattr(scope.get("route"), "path", "other")
            method = scope["method"] if scope["method"] in HTTP_METHODS else "OTHER"
            HTTP_DURATION.labels(method, route, status).observe(
                elapsed if elapsed is not None else time.perf_counter() - started
            )
            HTTP_REQUEST_BYTES.labels(route).observe(request_bytes)
            HTTP_RESPONSE_BYTES.labels(route).observe(response_bytes)


# 형식별 분류
WORD = {"docx", "doc", "odt", "rtf", "txt"}
CELL = {"xlsx", "xls", "ods", "csv"}
SLIDE = {"pptx", "ppt", "odp"}
HWP = {"hwp", "hwpx"}
PDF = {"pdf"}
ALLOWED = WORD | CELL | SLIDE | HWP | PDF
OO_EDITABLE = {"docx", "xlsx", "pptx", "odt", "ods", "odp", "txt", "csv"}
NEW_TYPES = {"docx", "xlsx", "pptx", "hwp", "hwpx"}
# 한셀/한쇼: 고유 형식(.cell/.show)은 공개 엔진이 없어 xlsx/pptx(한셀·한쇼에서 바로 열림)로 만든다
APP_NEW = {"hcell": "xlsx", "hshow": "pptx"}
APP_EXT = {"hcell": {"xlsx", "xls", "ods", "csv"}, "hshow": {"pptx", "ppt", "odp"}}
HANCOM_NATIVE = {"cell", "show", "nxl", "hcdt", "hsdt"}

WS_RE = re.compile(r"^[A-Za-z0-9_-]{32,64}$")
ID_RE = re.compile(r"^[a-f0-9]{32}$")

from app.accounts import Accounts  # noqa: E402
from app.rooms import Rooms  # noqa: E402

accounts = Accounts(DATA_DIR / "app.db")
ADMIN_USERNAME = os.environ.get("ADMIN_USERNAME", "admin")
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD")
if ADMIN_PASSWORD and not accounts.by_username(ADMIN_USERNAME):
    _adm = accounts.create_user(ADMIN_USERNAME, ADMIN_PASSWORD, "관리자", is_admin=True)
    (DATA_DIR / "ws" / _adm["ws"]).mkdir(parents=True, exist_ok=True)


def _adopt_orphans() -> None:
    """계정 도입 전(익명 작업공간) 파일을 관리자 계정으로 옮긴다 — 잃어버리지 않게."""
    adm = accounts.by_username(ADMIN_USERNAME)
    root = DATA_DIR / "ws"
    if not adm or not root.is_dir():
        return
    target = root / adm["ws"]
    target.mkdir(parents=True, exist_ok=True)
    for d in root.iterdir():
        if d.is_dir() and d.name != adm["ws"] and not accounts.by_ws(d.name):
            for f in d.iterdir():
                if f.is_dir() and not (target / f.name).exists():
                    f.rename(target / f.name)
            try:
                d.rmdir()
            except OSError:
                pass
    for sh in (DATA_DIR / "shares").glob("*.json") if (DATA_DIR / "shares").is_dir() else []:
        try:
            j = json.loads(sh.read_text())
            if not accounts.by_ws(j["ws"]):
                j["ws"] = adm["ws"]
                sh.write_text(json.dumps(j))
        except Exception:
            pass


_adopt_orphans()

rooms = Rooms()
AUTOSAVE_SEC = int(os.environ.get("AUTOSAVE_SEC", "30"))
# ONLYOFFICE에서 열려 있는 문서 key → 마지막 활동 시각. 주기적으로 forcesave 명령을 보내
# 편집 중에도 저장소에 반영한다 (기본 동작은 모두 닫을 때만 저장).
active_docs: dict[str, float] = {}


async def autosave_loop():
    import asyncio
    while True:
        await asyncio.sleep(AUTOSAVE_SEC)
        now = time.time()
        for key, seen in list(active_docs.items()):
            if now - seen > 6 * 3600:
                active_docs.pop(key, None)
                continue
            body = {"c": "forcesave", "key": key}
            body["token"] = jwt.encode(dict(body), JWT_SECRET, algorithm="HS256")
            try:
                async with httpx.AsyncClient(timeout=20) as c:
                    res = (await c.post(f"{DS_INTERNAL_URL}command", json=body)).json()
                # 0: 저장 시작, 4: 바뀐 것 없음, 1: 그런 key 없음(세션 종료)
                if res.get("error") == 1:
                    active_docs.pop(key, None)
            except Exception:
                pass


@asynccontextmanager
async def lifespan(_app):
    import asyncio
    # 재시작 시 이전 리스너를 닫아 같은 포트를 다시 쓸 수 있게 한다.
    server, _ = start_http_server(9000)
    await asyncio.to_thread(error_logs.prune)
    task = asyncio.create_task(autosave_loop())
    prune_task = asyncio.create_task(error_logs.prune_daily())
    try:
        yield
    finally:
        task.cancel()
        prune_task.cancel()
        server.shutdown()
        server.server_close()


app = FastAPI(lifespan=lifespan, title="rhwp office API", docs_url=None, redoc_url=None, openapi_url=None)


@app.exception_handler(StarletteHTTPException)
async def track_http_exception(request: Request, exc: StarletteHTTPException):
    if exc.status_code >= 500:
        request.state.error_log_http_exception = exc
    return await http_exception_handler(request, exc)


# ---------------------------------------------------------------- helpers
def doc_type(ext: str) -> str:
    if ext in WORD:
        return "word"
    if ext in CELL:
        return "cell"
    if ext in SLIDE:
        return "slide"
    if ext in PDF:
        return "pdf"
    return "hwp"


def sign(*parts: str) -> str:
    return hmac.new(SIGN_SECRET, "|".join(parts).encode(), hashlib.sha256).hexdigest()


def check_sig(sig: str, *parts: str) -> None:
    if not hmac.compare_digest(sig or "", sign(*parts)):
        raise HTTPException(403, "bad signature")


def ws_dir(ws: str) -> Path:
    return DATA_DIR / "ws" / ws


def file_dir(ws: str, fid: str) -> Path:
    return ws_dir(ws) / fid


def read_meta(ws: str, fid: str) -> dict:
    if not ID_RE.match(fid):
        raise HTTPException(404, "not found")
    p = file_dir(ws, fid) / "meta.json"
    if not p.exists():
        raise HTTPException(404, "not found")
    meta = json.loads(p.read_text())
    remember_document(meta)
    return meta


def write_meta(ws: str, meta: dict) -> None:
    d = file_dir(ws, meta["id"])
    tmp = d / f"meta.json.{secrets.token_hex(4)}.tmp"
    tmp.write_text(json.dumps(meta, ensure_ascii=False))
    tmp.replace(d / "meta.json")


def content_path(ws: str, meta: dict) -> Path:
    return file_dir(ws, meta["id"]) / f"content.{meta['ext']}"


def file_bytes_response(ws: str, meta: dict, filename: Optional[str] = None, headers: Optional[dict] = None):
    """파일을 한 번에 읽어서 보낸다. FileResponse 는 크기를 먼저 재고 나중에 읽어서, 그 사이 저장(파일 교체)이
    끼어들면 'Content-Length 불일치'로 전송이 끊긴다 (변환기 다운로드 실패 code -4 의 원인)."""
    from fastapi.responses import Response
    h = dict(headers or {})
    if filename:
        h["Content-Disposition"] = f"attachment; filename*=UTF-8''{quote(filename)}"
    return Response(content_path(ws, meta).read_bytes(), media_type="application/octet-stream", headers=h)


def ws_usage(ws: str) -> tuple[int, int]:
    total, count = 0, 0
    d = ws_dir(ws)
    if d.exists():
        for f in d.glob("*/content.*"):
            total += f.stat().st_size
            count += 1
    return total, count


def clean_name(name: str, ext: str) -> str:
    name = re.sub(r"[\\/\x00-\x1f<>:\"|?*]", "_", (name or "").strip())[:120].strip(". ") or "제목 없음"
    if not name.lower().endswith("." + ext):
        name = f"{name}.{ext}"
    return name


def public(meta: dict) -> dict:
    return {
        "id": meta["id"],
        "name": meta["name"],
        "ext": meta["ext"],
        "type": doc_type(meta["ext"]),
        "size": meta["size"],
        "version": meta["version"],
        "created": meta["created"],
        "modified": meta["modified"],
        "editable": meta["ext"] in OO_EDITABLE or meta["ext"] in HWP,
        "app": meta.get("app") if meta.get("app") in APP_EXT and meta["ext"] in APP_EXT[meta["app"]] else None,
        "shared": bool(meta.get("share")),
    }


def store_bytes(ws: str, meta: dict, data: bytes) -> dict:
    if len(data) > MAX_FILE_BYTES:
        raise HTTPException(413, f"파일이 너무 큽니다 (최대 {MAX_FILE_BYTES // 1048576}MB)")
    path = content_path(ws, meta)
    old = path.stat().st_size if path.exists() else 0
    used, _ = ws_usage(ws)
    if used - old + len(data) > MAX_WS_BYTES:
        raise HTTPException(413, "작업공간 저장 용량을 초과했습니다")
    tmp = path.with_suffix(f"{path.suffix}.{secrets.token_hex(4)}.tmp")  # 동시에 두 번 저장돼도 서로 안 섞이게
    tmp.write_bytes(data)
    tmp.replace(path)
    meta["size"] = len(data)
    meta["modified"] = int(time.time())
    return meta


def create_file(ws: str, name: str, ext: str, data: bytes, app: Optional[str] = None) -> dict:
    _, count = ws_usage(ws)
    if count >= MAX_FILES:
        raise HTTPException(413, f"파일 개수 한도({MAX_FILES})를 넘었습니다")
    fid = uuid.uuid4().hex
    file_dir(ws, fid).mkdir(parents=True)
    now = int(time.time())
    meta = {"id": fid, "name": clean_name(name, ext), "ext": ext, "size": 0,
            "version": 1, "created": now, "modified": now}
    if app:
        meta["app"] = app
    try:
        store_bytes(ws, meta, data)
    except HTTPException:
        shutil.rmtree(file_dir(ws, fid), ignore_errors=True)
        raise
    write_meta(ws, meta)
    return meta


def bearer(authorization: Optional[str]) -> Optional[str]:
    return authorization[7:] if authorization and authorization.startswith("Bearer ") else None


def optional_user(request: Request, authorization: Optional[str] = Header(None)) -> Optional[dict]:
    u = accounts.session_user(bearer(authorization))
    if u:
        request.state.error_log_uid = u["id"]
    return u


def current_user(u: Optional[dict] = Depends(optional_user)) -> dict:
    if not u:
        raise HTTPException(401, "로그인이 필요합니다")
    return u


def admin_user(u: dict = Depends(current_user)) -> dict:
    if not u["is_admin"]:
        raise HTTPException(403, "관리자만 할 수 있습니다")
    return u


def workspace(u: dict = Depends(current_user)) -> str:
    d = ws_dir(u["ws"])
    d.mkdir(parents=True, exist_ok=True)
    return u["ws"]


# ---------------------------------------------------------------- public API
@app.get("/api/health")
def health():
    return {"ok": True}


# ---------------------------------------------------------------- 계정
USERNAME_RE = re.compile(r"^[a-z0-9_]{3,20}$")
_fails: dict[str, list[float]] = {}


def client_ip(request: Request) -> str:
    xff = request.headers.get("x-forwarded-for", "")
    if xff:
        return xff.split(",")[-1].strip()
    return request.client.host if request.client else ""


# 브라우저 형식과 종류만 받고 임의 문자열을 라벨로 쓰지 않는다.
RumKind = Literal["page", "app", "rhwp-wasm", "rhwp-font", "rhwp-other", "oo-sdk", "oo-font",
                  "oo-other", "api", "analytics", "other"]
RumSample = tuple[Optional[int], Optional[int], Optional[int], Optional[int], Optional[int], int, int, int, bool]
RumSums = tuple[int, int, int, int, int, int, int, int]
RUM_BODY_LIMIT = 64 * 1024
_rum_minute = -1
_rum_requests: dict[str, int] = {}


class RumGroup(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    count: int = Field(ge=1, le=200)
    sums: RumSums
    samples: list[RumSample] = Field(min_length=1, max_length=200)


class RumPayload(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    page: Literal["home", "edit"]
    fileType: Optional[Literal["word", "cell", "slide", "hwp", "pdf"]] = None
    groups: dict[RumKind, RumGroup] = Field(min_length=1, max_length=11)


@app.post("/api/rum", status_code=204)
async def collect_rum(request: Request):
    global _rum_minute
    minute = int(time.monotonic() // 60)
    if minute != _rum_minute:
        _rum_requests.clear()
        _rum_minute = minute
    ip = client_ip(request)
    count = _rum_requests.get(ip, 0)
    if count >= 30 or (ip not in _rum_requests and len(_rum_requests) >= 10000):
        raise HTTPException(429, "too many samples")
    _rum_requests[ip] = count + 1

    content_type = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    if content_type not in {"text/plain", "application/json"}:
        raise HTTPException(415, "unsupported media type")
    body = bytearray()
    async for chunk in request.stream():
        if len(body) + len(chunk) > RUM_BODY_LIMIT:
            raise HTTPException(413, "payload too large")
        body.extend(chunk)
    try:
        payload = RumPayload.model_validate_json(body)
    except ValidationError:
        raise HTTPException(422, "invalid samples") from None

    if (payload.fileType is not None and payload.page != "edit"
            or sum(group.count for group in payload.groups.values()) > 200):
        raise HTTPException(422, "invalid samples")
    for group in payload.groups.values():
        sums = tuple(sum(value or 0 for value in column) for column in zip(*(row[:8] for row in group.samples)))
        if group.count != len(group.samples) or group.sums != sums:
            raise HTTPException(422, "invalid group totals")

    for kind, group in payload.groups.items():
        for sample in group.samples:
            for segment, ms in zip(RUM_SEGMENTS, sample[:6]):
                if ms is not None:
                    RUM_DURATION.labels(kind, segment, payload.page).observe(min(120000, max(0, ms)) / 1000)
            transfer, encoded = (min(500000000, max(0, value)) for value in sample[6:8])
            RUM_TRANSFER.labels(kind, payload.page).observe(transfer)
            cached = transfer == 0 and encoded > 0
            RUM_RESOURCES.labels(kind, "true" if cached else "false", payload.page).inc()
    return Response(status_code=204)


SIGNUPS_PER_HOUR = int(os.environ.get("SIGNUPS_PER_IP_HOUR", "20"))


def too_many(key: str, limit: int = 10, window: int = 600) -> bool:
    now = time.time()
    lst = [t for t in _fails.get(key, []) if now - t < window]
    _fails[key] = lst
    return len(lst) >= limit


FeedbackKind = Literal["bug", "suggestion", "other"]
FeedbackStatus = Literal["new", "read", "done"]


class FeedbackError(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    kind: Literal["js", "promise", "api", "toast", "editor"]
    message: str = Field(min_length=1, max_length=500)


class Feedback(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    kind: FeedbackKind
    message: str = Field(min_length=5, max_length=2000)
    email: str | None = Field(default=None, max_length=254)
    page: Literal["home", "edit", "login", "admin", "other"]
    file_type: Literal["docx", "doc", "odt", "rtf", "txt", "xlsx", "xls", "ods", "csv",
                       "pptx", "ppt", "odp", "hwp", "hwpx", "pdf"] | None = None
    ua: str | None = Field(default=None, max_length=160)
    screen: str | None = Field(default=None, pattern=r"^[0-9]{1,6}x[0-9]{1,6}$")
    build: str | None = Field(default=None, max_length=100)
    session_id: uuid.UUID | None = None
    errors: list[FeedbackError] = Field(default_factory=list, max_length=5)


class FeedbackPatch(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    status: FeedbackStatus


_feedback_window = -1


def feedback_rate_keys(request, uid):
    global _feedback_window
    now = time.time()
    window = int(now // 600)
    if _feedback_window != window:
        _feedback_window = window
        for key, timestamps in _fails.copy().items():
            if key.startswith("feedback:") and (not timestamps or now - timestamps[-1] >= 600):
                _fails.pop(key, None)
    keys = [f"feedback:ip:{client_ip(request)}"]
    if uid is not None:
        keys.append(f"feedback:user:{uid}")
    if any(too_many(key, limit=5, window=600) for key in keys):
        raise HTTPException(429, "의견을 너무 자주 보냈습니다. 잠시 후 다시 시도해 주세요")
    return keys


@app.post("/api/feedback", status_code=201)
async def submit_feedback(request: Request, user: dict | None = Depends(optional_user)):
    raw, uploads = await read_feedback_request(request)
    try:
        body = Feedback.model_validate_json(raw)
    except ValidationError:
        raise HTTPException(422, "의견 입력 내용을 확인해 주세요") from None
    message = body.message.strip()
    if len(message) < 5:
        raise HTTPException(422, "내용을 5자 이상 입력해 주세요")
    email = (body.email or "").strip() or None
    if email and not re.fullmatch(
        r"[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*"
        r"@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+",
        email, re.I | re.ASCII,
    ):
        raise HTTPException(422, "이메일 주소를 확인해 주세요")
    if body.errors and not body.session_id:
        raise HTTPException(422, "오류 기록의 세션 ID가 필요합니다")
    uid = user["id"] if user else None
    keys = feedback_rate_keys(request, uid)
    images = []
    if uploads:
        images = await run_in_threadpool(prepare_feedback_images, uploads)
        # 이미지 변환 중에 처리된 제출까지 포함해 저장 직전에 다시 확인한다.
        keys = feedback_rate_keys(request, uid)
    errors = [{"kind": item.kind, "message": scrub(item.message, 500)} for item in body.errors]
    fid = accounts.add_feedback((
        uid, body.kind, message, email, body.page, body.file_type if body.page == "edit" else None,
        scrub(body.ua, 160) if body.ua else None, body.screen, scrub(body.build, 100) if body.build else None,
        str(body.session_id) if body.session_id else None, json.dumps(errors, ensure_ascii=False),
    ), images)
    now = time.time()
    for key in keys:
        _fails[key].append(now)
    FEEDBACK_TOTAL.labels(body.kind).inc()
    return {"id": fid}


@app.get("/api/admin/feedback")
def admin_feedback(status: FeedbackStatus | None = None, kind: FeedbackKind | None = None,
                   limit: int = Query(25, ge=1, le=100), offset: int = Query(0, ge=0, le=2**63 - 1),
                   _: dict = Depends(admin_user)):
    return accounts.list_feedback(status, kind, limit, offset)


@app.get("/api/admin/feedback/{fid}/images/{n}")
def admin_feedback_image(fid: int, n: int, _: dict = Depends(admin_user)):
    image = accounts.get_feedback_image(fid, n) if 0 < fid < 2**63 and 1 <= n <= 3 else None
    if image is None:
        raise HTTPException(404, "첨부 이미지를 찾을 수 없습니다")
    data, mime, ext = image
    return Response(data, media_type=mime, headers={
        "Content-Disposition": f'inline; filename="image-{n}.{ext}"',
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'",
        "Cache-Control": "no-store",
    })


@app.patch("/api/admin/feedback/{fid}", status_code=204)
def admin_patch_feedback(fid: int, body: FeedbackPatch, _: dict = Depends(admin_user)):
    if not 0 < fid < 2**63 or not accounts.update_feedback(fid, body.status):
        raise HTTPException(404, "의견을 찾을 수 없습니다")
    return Response(status_code=204)


@app.delete("/api/admin/feedback/{fid}", status_code=204)
def admin_delete_feedback(fid: int, _: dict = Depends(admin_user)):
    if not 0 < fid < 2**63 or not accounts.delete_feedback(fid):
        raise HTTPException(404, "의견을 찾을 수 없습니다")
    return Response(status_code=204)


_client_error_window = -1


@app.post("/api/client-errors", status_code=204)
async def collect_client_errors(request: Request):
    global _client_error_window
    content_type = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    if content_type not in {"text/plain", "application/json"}:
        raise HTTPException(415, "unsupported media type")
    body = bytearray()
    async for chunk in request.stream():
        if len(body) + len(chunk) > 64 * 1024:
            raise HTTPException(413, "payload too large")
        body.extend(chunk)
    try:
        items = CLIENT_BATCH.validate_json(body)
    except ValidationError:
        raise HTTPException(422, "invalid error records") from None

    # 만료된 IP 항목을 주기적으로 제거하고 한 배치의 레코드 수로 제한한다.
    now = time.time()
    window = int(now // 600)
    if _client_error_window != window:
        _client_error_window = window
        for key, timestamps in _fails.copy().items():
            if key.startswith("client-errors:") and (not timestamps or now - timestamps[-1] >= 600):
                _fails.pop(key, None)
    key = f"client-errors:{client_ip(request)}"
    if too_many(key, limit=61 - len(items)):
        raise HTTPException(429, "too many error records")
    _fails[key].extend([now] * len(items))
    user = optional_user(request, request.headers.get("authorization"))
    error_logs.client(items, user["id"] if user else None)
    return Response(status_code=204)


def me_out(u: dict) -> dict:
    return {"id": u["id"], "username": u["username"], "name": u["name"], "isAdmin": bool(u["is_admin"])}


class Signup(BaseModel):
    username: str
    password: str
    name: str


@app.post("/api/auth/signup")
def signup(body: Signup, request: Request):
    if accounts.setting("signup", "open") != "open":
        raise HTTPException(403, "지금은 회원가입을 받지 않습니다")
    username = body.username.strip().lower()
    if not USERNAME_RE.match(username):
        raise HTTPException(400, "아이디는 영문 소문자·숫자·밑줄 3~20자입니다")
    if len(body.password) < 8 or len(body.password) > 200:
        raise HTTPException(400, "비밀번호는 8자 이상이어야 합니다")
    name = re.sub(r"[\x00-\x1f<>]", "", body.name.strip())[:30]
    if not name:
        raise HTTPException(400, "이름을 입력하세요")
    ip = client_ip(request)
    if too_many(f"signup:{ip}", SIGNUPS_PER_HOUR, 3600):
        raise HTTPException(429, "가입 시도가 너무 많습니다. 잠시 후 다시 시도하세요")
    if accounts.by_username(username):
        raise HTTPException(409, "이미 있는 아이디입니다")
    u = accounts.create_user(username, body.password, name)
    _fails.setdefault(f"signup:{ip}", []).append(time.time())
    ws_dir(u["ws"]).mkdir(parents=True, exist_ok=True)
    return {"token": accounts.new_session(u["id"]), "user": me_out(u)}


class Login(BaseModel):
    username: str
    password: str


@app.post("/api/auth/login")
def login(body: Login, request: Request):
    username = body.username.strip().lower()
    ip = client_ip(request)
    keys = (f"login:{ip}", f"login:{username}")
    # 아이디당 10회, IP당 50회 실패 / 10분
    if too_many(keys[0], 50) or too_many(keys[1], 10):
        raise HTTPException(429, "로그인 시도가 너무 많습니다. 10분 뒤 다시 시도하세요")
    u = accounts.by_username(username)
    if not u or not accounts.check_password(u, body.password[:200]):
        for k in keys:
            _fails.setdefault(k, []).append(time.time())
        raise HTTPException(401, "아이디 또는 비밀번호가 맞지 않습니다")
    if u["disabled"]:
        raise HTTPException(403, "사용이 중지된 계정입니다. 관리자에게 문의하세요")
    return {"token": accounts.new_session(u["id"]), "user": me_out(u)}


@app.post("/api/auth/logout")
def logout(authorization: Optional[str] = Header(None)):
    t = bearer(authorization)
    if t:
        accounts.end_session(t)
    return {"ok": True}


@app.get("/api/auth/me")
def me(u: dict = Depends(current_user)):
    return me_out(u)


@app.get("/api/auth/config")
def auth_config():
    return {"signup": accounts.setting("signup", "open") == "open"}


class PasswordChange(BaseModel):
    old: str
    new: str


@app.post("/api/auth/password")
def change_password(body: PasswordChange, u: dict = Depends(current_user)):
    if not accounts.check_password(u, body.old[:200]):
        raise HTTPException(400, "현재 비밀번호가 맞지 않습니다")
    if len(body.new) < 8 or len(body.new) > 200:
        raise HTTPException(400, "새 비밀번호는 8자 이상이어야 합니다")
    accounts.set_password(u["id"], body.new)
    return {"token": accounts.new_session(u["id"])}


class NameChange(BaseModel):
    name: str


@app.patch("/api/auth/me")
def change_name(body: NameChange, u: dict = Depends(current_user)):
    name = re.sub(r"[\x00-\x1f<>]", "", body.name.strip())[:30]
    if not name:
        raise HTTPException(400, "이름을 입력하세요")
    accounts.update_user(u["id"], name=name)
    return me_out(accounts.user(u["id"]))


# ---------------------------------------------------------------- 관리자
dashboard = AdminDashboard(accounts, DATA_DIR, APP_EXT, ALLOWED, DS_INTERNAL_URL,
                           os.getenv("APP_VERSION") or app.version)


@app.get("/api/admin/overview")
async def admin_overview(_: dict = Depends(admin_user)):
    # 실시간 방은 WebSocket과 같은 이벤트 루프에서 집계한다.
    live = rooms.active_counts()
    return await run_in_threadpool(dashboard.overview, live)


@app.get("/api/admin/documents")
def admin_documents(_: dict = Depends(admin_user)):
    documents, _ = dashboard.document_data()
    return documents


@app.get("/api/admin/errors")
def admin_errors(days: Literal["1", "7", "30"] = "7", tests: Literal["0", "1"] = "0",
                 _: dict = Depends(admin_user)):
    return dashboard.errors(int(days), tests == "1")


@app.get("/api/admin/status")
def admin_status(_: dict = Depends(admin_user)):
    return dashboard.status()


@app.get("/api/admin/users")
def admin_users(_: dict = Depends(admin_user)):
    out = []
    for u in accounts.users():
        used, count = ws_usage(u["ws"])
        out.append({**me_out(u), "disabled": bool(u["disabled"]), "created": u["created"],
                    "lastLogin": u["last_login"], "used": used, "files": count})
    return {"users": out, "signup": accounts.setting("signup", "open") == "open"}


class AdminCreate(BaseModel):
    username: str
    password: str
    name: str
    isAdmin: bool = False


@app.post("/api/admin/users")
def admin_create_user(body: AdminCreate, _: dict = Depends(admin_user)):
    username = body.username.strip().lower()
    if not USERNAME_RE.match(username):
        raise HTTPException(400, "아이디는 영문 소문자·숫자·밑줄 3~20자입니다")
    if len(body.password) < 8:
        raise HTTPException(400, "비밀번호는 8자 이상이어야 합니다")
    name = re.sub(r"[\x00-\x1f<>]", "", body.name.strip())[:30] or username
    if accounts.by_username(username):
        raise HTTPException(409, "이미 있는 아이디입니다")
    u = accounts.create_user(username, body.password, name, is_admin=body.isAdmin)
    ws_dir(u["ws"]).mkdir(parents=True, exist_ok=True)
    return me_out(u)


class AdminUserPatch(BaseModel):
    disabled: Optional[bool] = None
    isAdmin: Optional[bool] = None
    password: Optional[str] = None


@app.patch("/api/admin/users/{uid}")
def admin_patch_user(uid: int, body: AdminUserPatch, me_: dict = Depends(admin_user)):
    u = accounts.user(uid)
    if not u:
        raise HTTPException(404, "없는 사용자")
    if uid == me_["id"] and (body.disabled or body.isAdmin is False):
        raise HTTPException(400, "자기 자신은 중지하거나 관리자 권한을 뺄 수 없습니다")
    if body.password is not None:
        if len(body.password) < 8:
            raise HTTPException(400, "비밀번호는 8자 이상")
        accounts.set_password(uid, body.password)
    fields = {}
    if body.disabled is not None:
        fields["disabled"] = int(body.disabled)
    if body.isAdmin is not None:
        fields["is_admin"] = int(body.isAdmin)
    accounts.update_user(uid, **fields)
    return {"ok": True}


@app.delete("/api/admin/users/{uid}")
def admin_delete_user(uid: int, me_: dict = Depends(admin_user)):
    u = accounts.user(uid)
    if not u:
        raise HTTPException(404, "없는 사용자")
    if uid == me_["id"]:
        raise HTTPException(400, "자기 자신은 삭제할 수 없습니다")
    for m in ws_dir(u["ws"]).glob("*/meta.json"):
        try:
            sh = json.loads(m.read_text()).get("share")
            if sh:
                share_path(sh["token"]).unlink(missing_ok=True)
        except Exception:
            pass
    accounts.revoke_owner(u["ws"])
    accounts.delete_user(uid)
    shutil.rmtree(ws_dir(u["ws"]), ignore_errors=True)
    return {"ok": True}


class Settings(BaseModel):
    signup: bool


@app.put("/api/admin/settings")
def admin_settings(body: Settings, _: dict = Depends(admin_user)):
    accounts.set_setting("signup", "open" if body.signup else "closed")
    return {"signup": body.signup}


@app.get("/api/workspaces/me")
def ws_info(ws: str = Depends(workspace)):
    used, count = ws_usage(ws)
    return {"used": used, "quota": MAX_WS_BYTES, "files": count, "maxFiles": MAX_FILES,
            "maxFileSize": MAX_FILE_BYTES}


@app.get("/api/files")
def list_files(ws: str = Depends(workspace)):
    out = []
    for m in ws_dir(ws).glob("*/meta.json"):
        try:
            out.append(public(json.loads(m.read_text())))
        except Exception:
            continue
    out.sort(key=lambda x: x["modified"], reverse=True)
    return out


class NewFile(BaseModel):
    type: str
    name: Optional[str] = None


DEFAULT_NAMES = {"docx": "새 워드", "xlsx": "새 엑셀", "pptx": "새 파워포인트",
                 "hwp": "새 한글", "hwpx": "새 한글", "hcell": "새 한셀", "hshow": "새 한쇼"}


@app.post("/api/files/new")
def new_file(body: NewFile, ws: str = Depends(workspace)):
    kind = body.type.lower()
    app = kind if kind in APP_NEW else None
    ext = APP_NEW.get(kind, kind)
    if ext not in NEW_TYPES:
        raise HTTPException(400, "지원하지 않는 형식")
    data = (TEMPLATE_DIR / f"blank.{ext}").read_bytes()
    return public(create_file(ws, body.name or DEFAULT_NAMES[kind], ext, data, app))


@app.post("/api/files/upload")
async def upload(file: UploadFile = File(...), ws: str = Depends(workspace)):
    name = file.filename or "upload"
    ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
    if ext in HANCOM_NATIVE:
        raise HTTPException(400, f"한셀/한쇼 고유 형식(.{ext})은 열 수 없습니다. 한셀·한쇼에서 xlsx/pptx로 저장한 뒤 올려 주세요")
    if ext not in ALLOWED:
        raise HTTPException(400, f"지원하지 않는 형식입니다: .{ext}")
    data = await file.read(MAX_FILE_BYTES + 1)
    return public(create_file(ws, name, ext, data))


# ---------------------------------------------------------------- 파일 접근 (소유자 / 공유 링크)
SHARE_RE = re.compile(r"^[A-Za-z0-9_-]{20,64}$")


def share_path(token: str) -> Path:
    return DATA_DIR / "shares" / f"{token}.json"


def load_share(token: Optional[str]) -> Optional[dict]:
    if not token or not SHARE_RE.match(token):
        return None
    p = share_path(token)
    if not p.exists():
        return None
    sh = json.loads(p.read_text())
    try:
        meta = read_meta(sh["ws"], sh["fid"])
    except HTTPException:
        return None
    if (meta.get("share") or {}).get("token") != token:  # 해제된 링크
        return None
    return sh


class Access(BaseModel):
    ws: str
    fid: str
    role: str  # owner | edit | view


RANK = {"view": 1, "edit": 2, "owner": 3}


def resolve_access(fid: str, user: Optional[dict], share_token: Optional[str]) -> Access:
    """권한이 여러 경로(소유/사용자 공유/링크)로 겹치면 가장 높은 것."""
    if not ID_RE.match(fid):
        raise HTTPException(404, "not found")
    best: Optional[Access] = None
    if user:
        if (file_dir(user["ws"], fid) / "meta.json").exists():
            return Access(ws=user["ws"], fid=fid, role="owner")
        g = accounts.grant_for(fid, user["id"])
        if g and (file_dir(g["owner_ws"], fid) / "meta.json").exists():
            best = Access(ws=g["owner_ws"], fid=fid, role=g["role"])
    if share_token:
        sh = load_share(share_token)
        if not sh or sh["fid"] != fid:
            if not best:
                raise HTTPException(403, "공유 링크가 유효하지 않습니다")
        else:
            mode = read_meta(sh["ws"], fid)["share"]["mode"]
            if not best or RANK[mode] > RANK[best.role]:
                best = Access(ws=sh["ws"], fid=fid, role=mode)
    if best:
        return best
    if user:
        raise HTTPException(404, "not found")
    raise HTTPException(401, "로그인이 필요합니다")


def access(fid: str, request: Request, u: Optional[dict] = Depends(optional_user),
           x_share: Optional[str] = Header(None)) -> Access:
    a = resolve_access(fid, u, x_share)
    request.state.log_private_values.extend((a.fid, a.ws))
    return a


def owner(a: Access = Depends(access)) -> Access:
    if a.role != "owner":
        raise HTTPException(403, "소유자만 할 수 있습니다")
    return a


def can_edit(a: Access) -> bool:
    return a.role in ("owner", "edit")


@app.get("/api/shared/{token}")
def shared_info(token: str):
    sh = load_share(token)
    if not sh:
        raise HTTPException(404, "공유 링크가 없거나 해제되었습니다")
    meta = read_meta(sh["ws"], sh["fid"])
    return {**public(meta), "role": meta["share"]["mode"]}


@app.get("/api/files/{fid}")
def get_file(a: Access = Depends(access)):
    meta = read_meta(a.ws, a.fid)
    out = {**public(meta), "role": a.role}
    if a.role == "owner" and meta.get("share"):
        out["share"] = meta["share"]
    return out


class ShareReq(BaseModel):
    mode: str = "edit"


@app.post("/api/files/{fid}/share")
def share(body: ShareReq, a: Access = Depends(owner)):
    if body.mode not in ("edit", "view"):
        raise HTTPException(400, "mode")
    meta = read_meta(a.ws, a.fid)
    token = (meta.get("share") or {}).get("token") or secrets.token_urlsafe(24)
    meta["share"] = {"token": token, "mode": body.mode}
    share_path(token).parent.mkdir(parents=True, exist_ok=True)
    share_path(token).write_text(json.dumps({"ws": a.ws, "fid": a.fid}))
    write_meta(a.ws, meta)
    return meta["share"]


class GrantReq(BaseModel):
    username: str
    role: str = "edit"


def grants_out(fid: str) -> list:
    return [{"username": g["username"], "name": g["name"], "role": g["role"]} for g in accounts.grants_of_file(fid)]


@app.get("/api/files/{fid}/grants")
def list_grants(a: Access = Depends(owner)):
    return grants_out(a.fid)


@app.post("/api/files/{fid}/grants")
def add_grant(body: GrantReq, a: Access = Depends(owner)):
    if body.role not in ("edit", "view"):
        raise HTTPException(400, "role")
    target = accounts.by_username(body.username.strip().lower())
    if not target or target["disabled"]:
        raise HTTPException(404, "그런 아이디의 사용자가 없습니다")
    if target["ws"] == a.ws:
        raise HTTPException(400, "자기 자신에게는 공유할 수 없습니다")
    accounts.grant(a.fid, a.ws, target["id"], body.role)
    return grants_out(a.fid)


@app.delete("/api/files/{fid}/grants/{username}")
def del_grant(username: str, a: Access = Depends(owner)):
    target = accounts.by_username(username.lower())
    if target:
        accounts.revoke(a.fid, target["id"])
    return grants_out(a.fid)


@app.get("/api/shared-with-me")
def shared_with_me(u: dict = Depends(current_user)):
    out = []
    for g in accounts.grants_to_user(u["id"]):
        try:
            meta = read_meta(g["owner_ws"], g["fid"])
        except HTTPException:
            continue
        out.append({**public(meta), "role": g["role"], "owner": g["owner_name"]})
    out.sort(key=lambda x: x["modified"], reverse=True)
    return out


@app.delete("/api/files/{fid}/share")
def unshare(a: Access = Depends(owner)):
    meta = read_meta(a.ws, a.fid)
    if meta.get("share"):
        share_path(meta["share"]["token"]).unlink(missing_ok=True)
        meta.pop("share")
        write_meta(a.ws, meta)
    return {"ok": True}


class Rename(BaseModel):
    name: str


@app.patch("/api/files/{fid}")
async def rename(body: Rename, a: Access = Depends(access)):
    if not can_edit(a):
        raise HTTPException(403, "보기 전용입니다")
    meta = read_meta(a.ws, a.fid)
    meta["name"] = clean_name(body.name, meta["ext"])
    write_meta(a.ws, meta)
    await rooms.broadcast(a.fid, {"type": "renamed", "name": meta["name"]})
    return public(meta)


@app.delete("/api/files/{fid}")
def delete(a: Access = Depends(owner)):
    meta = read_meta(a.ws, a.fid)
    if meta.get("share"):
        share_path(meta["share"]["token"]).unlink(missing_ok=True)
    accounts.revoke_file(a.fid)
    shutil.rmtree(file_dir(a.ws, a.fid), ignore_errors=True)
    return {"ok": True}


@app.get("/api/files/{fid}/content")
def content(a: Access = Depends(access)):
    meta = read_meta(a.ws, a.fid)
    return file_bytes_response(a.ws, meta, headers={"X-File-Version": str(meta["version"]), "Cache-Control": "no-store",
                                                    "Access-Control-Expose-Headers": "X-File-Version"})


@app.put("/api/files/{fid}/content")
async def put_content(request: Request, a: Access = Depends(access),
                      x_client: Optional[str] = Header(None), x_base_version: Optional[int] = Header(None)):
    """rhwp 편집기 저장 (HWP/HWPX 바이너리 그대로). 편집 잠금을 가진 사람만 저장할 수 있다."""
    if not can_edit(a):
        raise HTTPException(403, "보기 전용입니다")
    meta = read_meta(a.ws, a.fid)
    if meta["ext"] not in HWP:
        raise HTTPException(400, "이 형식은 ONLYOFFICE에서 저장됩니다")
    holder = rooms.lock_holder(a.fid)
    if holder and holder != x_client:
        raise HTTPException(409, "다른 사람이 편집 중입니다")
    if x_base_version is not None and x_base_version != meta["version"]:
        raise HTTPException(409, "그 사이 다른 사람이 저장했습니다. 최신 내용을 다시 불러오세요")
    data = await request.body()
    if not data:
        raise HTTPException(400, "empty body")
    store_bytes(a.ws, meta, data)
    meta["version"] += 1
    write_meta(a.ws, meta)
    by = rooms.name_of(a.fid, x_client)
    await rooms.broadcast(a.fid, {"type": "saved", "version": meta["version"], "by": by}, exclude=x_client)
    return public(meta)


@app.get("/api/files/{fid}/download-link")
def download_link(a: Access = Depends(access)):
    """브라우저 다운로드용 단기 서명 링크 (헤더를 붙일 수 없는 <a href> 용)."""
    meta = read_meta(a.ws, a.fid)
    exp = str(int(time.time()) + 300)
    return {"url": f"/dl/{a.ws}/{a.fid}?exp={exp}&sig={sign('dl', a.ws, a.fid, exp)}", "name": meta["name"]}


@app.get("/dl/{ws}/{fid}")
def download(ws: str, fid: str, exp: str, sig: str):
    check_sig(sig, "dl", ws, fid, exp)
    if int(exp) < time.time():
        raise HTTPException(403, "link expired")
    meta = read_meta(ws, fid)
    return file_bytes_response(ws, meta, filename=meta["name"])


# ---------------------------------------------------------------- ONLYOFFICE
def clean_user(uid: Optional[str], name: Optional[str]) -> tuple[str, str]:
    uid = uid if uid and re.fullmatch(r"[A-Za-z0-9_-]{2,40}", uid) else secrets.token_hex(8)
    name = re.sub(r"[\x00-\x1f<>]", "", (name or "").strip())[:30] or "손님"
    return uid, name


@app.get("/api/files/{fid}/onlyoffice")
def onlyoffice_config(mobile: bool = False, uid: Optional[str] = None, name: Optional[str] = None,
                      a: Access = Depends(access), user: Optional[dict] = Depends(optional_user)):
    ws, fid = a.ws, a.fid
    meta = read_meta(ws, fid)
    ext = meta["ext"]
    if ext in HWP:
        raise HTTPException(400, "HWP는 rhwp 편집기로 엽니다")
    editable = ext in OO_EDITABLE and can_edit(a)
    if user:  # 계정 사용자는 기기·탭이 달라도 같은 사람으로
        uid, name = f"u{user['id']}", user["name"]
    uid, name = clean_user(uid, name)
    # 같은 key = 같은 공동 편집 세션 (ONLYOFFICE가 WebSocket으로 실시간 병합)
    key = f"{fid}_{meta['version']}"
    config = {
        "document": {
            "fileType": ext,
            "key": key,
            "title": meta["name"],
            "url": f"{API_INTERNAL_URL}/internal/dl/{ws}/{fid}?sig={sign('oo-dl', ws, fid)}",
            "permissions": {"edit": editable, "download": True, "print": True,
                            "comment": editable, "review": editable, "chat": True},
        },
        "documentType": doc_type(ext),
        "editorConfig": {
            "mode": "edit" if editable else "view",
            "lang": "ko",
            "region": "ko-KR",
            "callbackUrl": f"{API_INTERNAL_URL}/internal/callback/{ws}/{fid}?sig={sign('oo-cb', ws, fid)}",
            "user": {"id": uid, "name": name},
            "coEditing": {"mode": "fast", "change": True},
            "customization": {"forcesave": True, "autosave": True, "compactHeader": False,
                              "hideRightMenu": False, "uiTheme": "theme-classic-light"},
        },
        "type": "mobile" if mobile else "desktop",
        "width": "100%",
        "height": "100%",
    }
    config["token"] = jwt.encode(config, JWT_SECRET, algorithm="HS256")
    if editable:
        active_docs[key] = time.time()
    # 상대 경로: 페이지와 같은 출처의 /office/ 로 로드 → ONLYOFFICE가 그 호스트 기준으로 URL 생성
    return {"config": config, "apiUrl": f"{DS_PUBLIC_PATH}web-apps/apps/api/documents/api.js"}


@app.get("/internal/dl/{ws}/{fid}")
def oo_download(ws: str, fid: str, sig: str):
    check_sig(sig, "oo-dl", ws, fid)
    meta = read_meta(ws, fid)
    return file_bytes_response(ws, meta)


def to_internal(url: str) -> str:
    """ONLYOFFICE가 준 공개 URL(https://<www 도메인>/office/...)을 내부 주소로 바꾼다."""
    parts = urlsplit(url)
    if parts.path.startswith(DS_PUBLIC_PATH):
        rest = parts.path[len(DS_PUBLIC_PATH):] + (f"?{parts.query}" if parts.query else "")
        return DS_INTERNAL_URL + rest
    return url


@app.post("/internal/callback/{ws}/{fid}")
async def oo_callback(ws: str, fid: str, sig: str, request: Request):
    check_sig(sig, "oo-cb", ws, fid)
    body = await request.json()
    token = body.get("token")
    if not token:
        auth = request.headers.get("Authorization", "")
        token = auth[7:] if auth.startswith("Bearer ") else None
    if not token:
        return JSONResponse({"error": 1, "message": "no token"}, status_code=403)
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=["HS256"])
    except jwt.PyJWTError:
        return JSONResponse({"error": 1, "message": "bad token"}, status_code=403)
    payload = payload.get("payload", payload)  # 헤더 토큰이면 payload 안에 들어있다
    status = payload.get("status")
    key = payload.get("key")
    if key and status == 1:
        active_docs[key] = time.time()
    elif key and status in (2, 3, 4):
        active_docs.pop(key, None)
    if status in (3, 7):
        error_logs.server(request.scope, 200, message=f"ONLYOFFICE 저장 콜백 오류 ({status})")
    if status in (2, 6):  # 2: 편집 종료 후 저장, 6: 강제 저장
        try:
            meta = read_meta(ws, fid)
        except HTTPException:  # 편집 중에 파일(또는 계정)이 지워졌으면 저장할 곳이 없다 → 정상 처리
            return {"error": 0}
        request.state.log_private_values.extend((fid, ws, sig))
        url = payload.get("url")
        if not url:
            error_logs.server(request.scope, 200, message="ONLYOFFICE 저장 결과 주소 없음")
            return {"error": 1}
        async with httpx.AsyncClient(timeout=120) as c:
            r = None
            for u in (to_internal(url), url):
                try:
                    r = await c.get(u)
                    if r.status_code == 200:
                        break
                except httpx.HTTPError:
                    r = None
            if r is None or r.status_code != 200:
                error_logs.server(request.scope, 200, message="ONLYOFFICE 저장 결과 다운로드 실패")
                return {"error": 1}
        new_ext = (payload.get("filetype") or meta["ext"]).lower()
        if new_ext != meta["ext"] and new_ext in ALLOWED:
            content_path(ws, meta).unlink(missing_ok=True)
            meta["ext"] = new_ext
            meta["name"] = clean_name(meta["name"].rsplit(".", 1)[0], new_ext)
        store_bytes(ws, meta, r.content)
        if status == 2:
            meta["version"] += 1  # 세션이 끝났으니 다음 편집은 새 key
        write_meta(ws, meta)
        # 편집기 자체 저장(Ctrl+S 등)이 저장소에 반영됐음을 편집 화면에 알림 → '저장했습니다'
        await rooms.broadcast(fid, {"type": "oo-saved", "forcesavetype": payload.get("forcesavetype")})
    return {"error": 0}


class Convert(BaseModel):
    to: str


CONVERT_TARGETS = {
    "word": {"docx", "pdf", "odt", "txt"},
    "cell": {"xlsx", "pdf", "ods", "csv"},
    "slide": {"pptx", "pdf", "odp"},
    "hwp": {"docx", "pdf"},
    "pdf": {"docx"},
}


async def convert_bytes(ws: str, fid: str, meta: dict, to: str) -> bytes:
    if to not in CONVERT_TARGETS[doc_type(meta["ext"])] or to == meta["ext"]:
        raise HTTPException(400, "지원하지 않는 변환")
    req = {
        "async": False,
        "filetype": meta["ext"],
        "outputtype": to,
        "key": f"{fid}_{meta['version']}_{to}_{secrets.token_hex(4)}",
        "title": meta["name"],
        "url": f"{API_INTERNAL_URL}/internal/dl/{ws}/{fid}?sig={sign('oo-dl', ws, fid)}",
    }
    req["token"] = jwt.encode(req, JWT_SECRET, algorithm="HS256")
    with OO_CONVERT.labels(to).time():
        async with httpx.AsyncClient(timeout=180) as c:
            r = await c.post(f"{DS_INTERNAL_URL}converter", json=req, headers={"Accept": "application/json"})
            res = r.json()
            if res.get("error") or not res.get("endConvert"):
                raise HTTPException(502, f"변환 실패 (code {res.get('error')})")
            f = await c.get(to_internal(res["fileUrl"]))
            if f.status_code != 200:
                f = await c.get(res["fileUrl"])
            f.raise_for_status()
    return f.content


async def forcesave(ws: str, fid: str, wait: float = 8) -> tuple[dict, bool]:
    started = time.perf_counter()
    result = "error"
    try:
        meta, saved = await _forcesave(ws, fid, wait)
        result = "saved" if saved else "unconfirmed"
        return meta, saved
    finally:
        OO_FORCESAVE.labels(result).observe(time.perf_counter() - started)


async def _forcesave(ws: str, fid: str, wait: float = 8) -> tuple[dict, bool]:
    """편집 중인 Office 문서면 강제 저장을 요청하고 파일이 바뀔 때까지 기다린다.
    돌려주는 값: (최신 메타, 저장소가 최신인지). 열려 있지 않거나 바뀐 게 없으면(error 4) 이미 최신."""
    import asyncio
    meta = read_meta(ws, fid)
    key = f"{fid}_{meta['version']}"
    if key not in active_docs:
        return meta, True
    body = {"c": "forcesave", "key": key}
    body["token"] = jwt.encode(dict(body), JWT_SECRET, algorithm="HS256")
    try:
        async with httpx.AsyncClient(timeout=10) as c:
            res = (await c.post(f"{DS_INTERNAL_URL}command", json=body)).json()
    except Exception:
        return meta, False
    if res.get("error") == 4:
        return meta, True
    if res.get("error") != 0:
        return meta, False
    def stamp():
        m = read_meta(ws, fid)
        try:
            return m, (m["version"], content_path(ws, m).stat().st_mtime_ns)
        except FileNotFoundError:
            return m, (m["version"], 0)
    _, before = stamp()
    for _ in range(int(wait / 0.25)):  # 콜백(status 6)으로 파일이 바뀔 때까지
        await asyncio.sleep(0.25)
        m, now = stamp()
        if now != before:
            return m, True
    return read_meta(ws, fid), False


async def flush_onlyoffice(ws: str, fid: str) -> dict:
    """변환·내보내기 전에 편집 중인 내용을 반영 (실패해도 진행)."""
    return (await forcesave(ws, fid))[0]


@app.post("/api/files/{fid}/save")
async def save_now(a: Access = Depends(access)):
    """편집 화면의 Ctrl+S — 열려 있는 Office 문서를 바로 저장소에 반영 (자동 저장을 기다리지 않음).
    saved=false 면 확인하지 못한 것 (화면에 '저장 실패'로 알림)."""
    if not can_edit(a):
        raise HTTPException(403, "보기 전용입니다")
    meta, saved = await forcesave(a.ws, a.fid, wait=15)
    return {**public(meta), "saved": saved}


@app.post("/api/files/{fid}/convert")
async def convert(body: Convert, a: Access = Depends(owner)):
    """ONLYOFFICE 변환 서비스로 다른 형식 사본을 만든다 (예: HWP→DOCX, DOCX→PDF)."""
    meta = await flush_onlyoffice(a.ws, a.fid)
    to = body.to.lower()
    data = await convert_bytes(a.ws, a.fid, meta, to)
    base = meta["name"].rsplit(".", 1)[0]
    return public(create_file(a.ws, base, to, data, meta.get("app")))


@app.post("/api/files/{fid}/export")
async def export(body: Convert, a: Access = Depends(access)):
    """저장하지 않고 바로 내려받기 (편집기의 'PDF로 다운로드'). 보기 권한이면 충분."""
    meta = await flush_onlyoffice(a.ws, a.fid)
    to = body.to.lower()
    data = await convert_bytes(a.ws, a.fid, meta, to)
    name = f"{meta['name'].rsplit('.', 1)[0]}.{to}"
    return Response(data, media_type="application/pdf" if to == "pdf" else "application/octet-stream",
                    headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(name)}"})


# ---------------------------------------------------------------- 실시간 (WebSocket)
@app.websocket("/ws/files/{fid}")
async def file_socket(sock: WebSocket, fid: str, uid: str = "", name: str = "",
                      t: Optional[str] = None, s: Optional[str] = None):
    """접속자 표시 + 마우스 포인터 + HWP 편집 잠금 + 저장 알림.
    (Office 문서의 글자 단위 공동 편집은 ONLYOFFICE 자체 WebSocket이 처리한다.)"""
    origin = sock.headers.get("origin")
    if origin and origin not in CORS_ORIGINS:
        await sock.close(code=4403)
        return
    user = accounts.session_user(t)
    try:
        a = resolve_access(fid, user, s)
    except HTTPException:
        await sock.close(code=4401)
        return
    uid, name = clean_user(f"u{user['id']}" if user else uid, user["name"] if user else name)
    await sock.accept()
    await rooms.join(fid, uid, name, sock, editor=can_edit(a))
    grace = None  # 갑자기 끊김: 편집 잠금을 잠시 유지
    next_cursor = 0.0
    try:
        while True:
            raw = await sock.receive_text()
            msg = json.loads(raw)
            if not isinstance(msg, dict):
                continue
            t = msg.get("type")
            if t == "bye":  # 창을 닫음 → 잠금을 바로 넘김
                grace = 0
                break
            if t == "ping":
                await sock.send_json({"type": "pong"})
            elif t == "cursor":
                now = time.monotonic()
                if now >= next_cursor and len(raw) <= 256 and await rooms.cursor(fid, uid, msg):
                    next_cursor = now + 0.04
            elif t == "name":
                await rooms.rename_user(fid, uid, clean_user(uid, msg.get("name"))[1])
            elif t == "release":
                await rooms.release(fid, uid)
            elif t == "request":
                await rooms.request_lock(fid, uid)
    except (WebSocketDisconnect, RuntimeError, ValueError):
        pass
    finally:
        await rooms.leave(fid, uid, sock, grace=grace)


# FastAPI가 생성하는 서버 오류 응답에도 CORS와 요청 ID를 적용하고 계측한다.
app = CORSMiddleware(
    app,
    allow_origins=CORS_ORIGINS,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "X-Share", "X-Client", "X-Base-Version", "Content-Type", "X-Request-ID"],
    expose_headers=["Content-Disposition", "X-File-Version", "X-Request-ID"],
    max_age=600,
)
app = HTTPMetrics(RequestErrors(app, error_logs))
