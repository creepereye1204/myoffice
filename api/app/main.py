"""rhwp office API — 파일 저장소 + ONLYOFFICE 연동 + HWP 저장.

인증 모델: 익명 워크스페이스. 브라우저가 처음 들어오면 POST /api/workspaces 로
추측 불가능한 토큰을 받고(localStorage 보관), 이후 모든 요청에 X-Workspace 헤더로 보낸다.
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
from fastapi import Depends, FastAPI, File, Header, HTTPException, Request, UploadFile
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

app = FastAPI(title="rhwp office API", docs_url=None, redoc_url=None, openapi_url=None)
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["X-Workspace", "Content-Type"],
    expose_headers=["Content-Disposition"],
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


def workspace(x_workspace: Optional[str] = Header(None)) -> str:
    if not x_workspace or not WS_RE.match(x_workspace) or not ws_dir(x_workspace).is_dir():
        raise HTTPException(401, "workspace required")
    return x_workspace


# ---------------------------------------------------------------- public API
@app.get("/api/health")
def health():
    return {"ok": True}


@app.post("/api/workspaces")
def new_workspace():
    ws = secrets.token_urlsafe(32)
    ws_dir(ws).mkdir(parents=True)
    return {"workspace": ws}


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


@app.get("/api/files/{fid}")
def get_file(fid: str, ws: str = Depends(workspace)):
    return public(read_meta(ws, fid))


class Rename(BaseModel):
    name: str


@app.patch("/api/files/{fid}")
def rename(fid: str, body: Rename, ws: str = Depends(workspace)):
    meta = read_meta(ws, fid)
    meta["name"] = clean_name(body.name, meta["ext"])
    write_meta(ws, meta)
    return public(meta)


@app.delete("/api/files/{fid}")
def delete(fid: str, ws: str = Depends(workspace)):
    read_meta(ws, fid)
    shutil.rmtree(file_dir(ws, fid), ignore_errors=True)
    return {"ok": True}


@app.get("/api/files/{fid}/content")
def content(fid: str, ws: str = Depends(workspace)):
    meta = read_meta(ws, fid)
    return FileResponse(content_path(ws, meta), media_type="application/octet-stream")


@app.put("/api/files/{fid}/content")
async def put_content(fid: str, request: Request, ws: str = Depends(workspace)):
    """rhwp 편집기 저장 (HWP/HWPX 바이너리 그대로)."""
    meta = read_meta(ws, fid)
    if meta["ext"] not in HWP:
        raise HTTPException(400, "이 형식은 ONLYOFFICE에서 저장됩니다")
    data = await request.body()
    if not data:
        raise HTTPException(400, "empty body")
    store_bytes(ws, meta, data)
    meta["version"] += 1
    write_meta(ws, meta)
    return public(meta)


@app.get("/api/files/{fid}/download-link")
def download_link(fid: str, ws: str = Depends(workspace)):
    """브라우저 다운로드용 단기 서명 링크 (헤더를 붙일 수 없는 <a href> 용)."""
    meta = read_meta(ws, fid)
    exp = str(int(time.time()) + 300)
    return {"url": f"/dl/{ws}/{fid}?exp={exp}&sig={sign('dl', ws, fid, exp)}", "name": meta["name"]}


@app.get("/dl/{ws}/{fid}")
def download(ws: str, fid: str, exp: str, sig: str):
    check_sig(sig, "dl", ws, fid, exp)
    if int(exp) < time.time():
        raise HTTPException(403, "link expired")
    meta = read_meta(ws, fid)
    return FileResponse(content_path(ws, meta), filename=meta["name"],
                        media_type="application/octet-stream")


# ---------------------------------------------------------------- ONLYOFFICE
@app.get("/api/files/{fid}/onlyoffice")
def onlyoffice_config(fid: str, mobile: bool = False, ws: str = Depends(workspace)):
    meta = read_meta(ws, fid)
    ext = meta["ext"]
    if ext in HWP:
        raise HTTPException(400, "HWP는 rhwp 편집기로 엽니다")
    editable = ext in OO_EDITABLE
    key = f"{fid}_{meta['version']}"
    config = {
        "document": {
            "fileType": ext,
            "key": key,
            "title": meta["name"],
            "url": f"{API_INTERNAL_URL}/internal/dl/{ws}/{fid}?sig={sign('oo-dl', ws, fid)}",
            "permissions": {"edit": editable, "download": True, "print": True,
                            "comment": editable, "review": editable},
        },
        "documentType": doc_type(ext),
        "editorConfig": {
            "mode": "edit" if editable else "view",
            "lang": "ko",
            "region": "ko-KR",
            "callbackUrl": f"{API_INTERNAL_URL}/internal/callback/{ws}/{fid}?sig={sign('oo-cb', ws, fid)}",
            "user": {"id": hashlib.sha256(ws.encode()).hexdigest()[:16], "name": "나"},
            "customization": {"forcesave": True, "autosave": True, "compactHeader": False,
                              "hideRightMenu": False, "uiTheme": "theme-classic-light"},
        },
        "type": "mobile" if mobile else "desktop",
        "width": "100%",
        "height": "100%",
    }
    config["token"] = jwt.encode(config, JWT_SECRET, algorithm="HS256")
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
    if status in (2, 6):  # 2: 편집 종료 후 저장, 6: 강제 저장
        meta = read_meta(ws, fid)
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


@app.post("/api/files/{fid}/convert")
async def convert(fid: str, body: Convert, ws: str = Depends(workspace)):
    """ONLYOFFICE 변환 서비스로 다른 형식 사본을 만든다 (예: HWP→DOCX, DOCX→PDF)."""
    meta = read_meta(ws, fid)
    to = body.to.lower()
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
    base = meta["name"].rsplit(".", 1)[0]
    return public(create_file(ws, base, to, f.content, meta.get("app")))
