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
from pathlib import Path
from typing import Optional
from urllib.parse import quote, urlsplit

import httpx
import jwt
from fastapi import Depends, FastAPI, File, Header, HTTPException, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel

DATA_DIR = Path(os.environ.get("DATA_DIR", "/data"))
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


from contextlib import asynccontextmanager  # noqa: E402


@asynccontextmanager
async def lifespan(_app):
    import asyncio
    task = asyncio.create_task(autosave_loop())
    yield
    task.cancel()


app = FastAPI(lifespan=lifespan, title="rhwp office API", docs_url=None, redoc_url=None, openapi_url=None)
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "X-Share", "X-Client", "X-Base-Version", "Content-Type"],
    expose_headers=["Content-Disposition", "X-File-Version"],
    max_age=600,
)


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
    return json.loads(p.read_text())


def write_meta(ws: str, meta: dict) -> None:
    d = file_dir(ws, meta["id"])
    tmp = d / "meta.json.tmp"
    tmp.write_text(json.dumps(meta, ensure_ascii=False))
    tmp.replace(d / "meta.json")


def content_path(ws: str, meta: dict) -> Path:
    return file_dir(ws, meta["id"]) / f"content.{meta['ext']}"


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
    tmp = path.with_suffix(path.suffix + ".tmp")
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


def current_user(authorization: Optional[str] = Header(None)) -> dict:
    u = accounts.session_user(bearer(authorization))
    if not u:
        raise HTTPException(401, "로그인이 필요합니다")
    return u


def optional_user(authorization: Optional[str] = Header(None)) -> Optional[dict]:
    return accounts.session_user(bearer(authorization))


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


SIGNUPS_PER_HOUR = int(os.environ.get("SIGNUPS_PER_IP_HOUR", "20"))


def too_many(key: str, limit: int = 10, window: int = 600) -> bool:
    now = time.time()
    lst = [t for t in _fails.get(key, []) if now - t < window]
    _fails[key] = lst
    return len(lst) >= limit


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


def access(fid: str, authorization: Optional[str] = Header(None), x_share: Optional[str] = Header(None)) -> Access:
    return resolve_access(fid, accounts.session_user(bearer(authorization)), x_share)


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
    return FileResponse(content_path(a.ws, meta), media_type="application/octet-stream",
                        headers={"X-File-Version": str(meta["version"]), "Cache-Control": "no-store",
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
    return FileResponse(content_path(ws, meta), filename=meta["name"],
                        media_type="application/octet-stream")


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
    return FileResponse(content_path(ws, meta), media_type="application/octet-stream")


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
    if status in (2, 6):  # 2: 편집 종료 후 저장, 6: 강제 저장
        try:
            meta = read_meta(ws, fid)
        except HTTPException:  # 편집 중에 파일(또는 계정)이 지워졌으면 저장할 곳이 없다 → 정상 처리
            return {"error": 0}
        url = payload.get("url")
        if not url:
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


async def flush_onlyoffice(ws: str, fid: str) -> dict:
    """편집 중인 Office 문서면 강제 저장을 요청하고 잠깐 기다려 최신 내용으로 만든다."""
    meta = read_meta(ws, fid)
    key = f"{fid}_{meta['version']}"
    if key not in active_docs:
        return meta
    body = {"c": "forcesave", "key": key}
    body["token"] = jwt.encode(dict(body), JWT_SECRET, algorithm="HS256")
    try:
        async with httpx.AsyncClient(timeout=10) as c:
            res = (await c.post(f"{DS_INTERNAL_URL}command", json=body)).json()
        if res.get("error") == 0:  # 저장 시작됨 → 콜백으로 파일이 바뀔 때까지 최대 8초
            import asyncio
            before = meta["modified"], meta["size"]
            for _ in range(32):
                await asyncio.sleep(0.25)
                m = read_meta(ws, fid)
                if (m["modified"], m["size"]) != before:
                    return m
    except Exception:
        pass
    return read_meta(ws, fid)


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
    from fastapi.responses import Response
    return Response(data, media_type="application/pdf" if to == "pdf" else "application/octet-stream",
                    headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(name)}"})


# ---------------------------------------------------------------- 실시간 (WebSocket)
@app.websocket("/ws/files/{fid}")
async def file_socket(sock: WebSocket, fid: str, uid: str = "", name: str = "",
                      t: Optional[str] = None, s: Optional[str] = None):
    """접속자 표시 + HWP 편집 잠금 + 저장 알림.
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
    try:
        while True:
            msg = await sock.receive_json()
            t = msg.get("type")
            if t == "ping":
                await sock.send_json({"type": "pong"})
            elif t == "name":
                await rooms.rename_user(fid, uid, clean_user(uid, msg.get("name"))[1])
            elif t == "release":
                await rooms.release(fid, uid)
            elif t == "request":
                await rooms.request_lock(fid, uid)
    except (WebSocketDisconnect, RuntimeError, ValueError):
        pass
    finally:
        await rooms.leave(fid, uid, sock)
