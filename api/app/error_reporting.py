"""오류 레코드 검증, 개인정보 제거, JSONL 저장."""
import asyncio
import json
import logging
import re
import sys
import traceback
import uuid
from contextvars import ContextVar
from datetime import date, datetime, timedelta, timezone
from http import HTTPStatus
from pathlib import Path
from typing import Annotated, Literal

from prometheus_client import Counter
from pydantic import BaseModel, ConfigDict, Field, TypeAdapter
from starlette.datastructures import Headers, MutableHeaders
from starlette.exceptions import HTTPException

CLIENT_ERRORS = Counter("myoffice_client_errors_total", "브라우저 오류 수", ["kind", "page"])
SERVER_ERRORS = Counter("myoffice_server_errors_total", "서버 오류 수", ["route"])
REQUEST_ID = r"[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}"
CLIENT_ROUTE = (
    r"^(?:other|/api/(?:auth/(?:config|login|logout|me|password|signup)"
    r"|admin/(?:settings|users(?:/\{id\})?)"
    r"|files(?:/(?:new|upload|\{id\}(?:/(?:content|convert|download-link|export|grants(?:/\{id\})?|onlyoffice|save|share))?))?"
    r"|shared/\{id\}|shared-with-me|workspaces/me|health))$"
)
SOURCE = r"[-\w.]+\.(?:[cm]?js|wasm|html)"
UUID = r"[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}"
OPAQUE = re.compile(r"eyJ[\w.-]+|[a-f0-9]{32,}|(?<![\w-])[a-z0-9_-]{32,}(?![\w-])", re.I)
PRIVATE_VALUES: ContextVar[list | None] = ContextVar("error_private_values", default=None)


def remember_document(meta):
    private_values = PRIVATE_VALUES.get()
    if private_values is not None:
        name = meta.get("name", "")
        private_values.extend((name, name.rsplit(".", 1)[0], (meta.get("share") or {}).get("token")))
QUERY_FIELDS = re.compile(
    r'\b(?:s|id|sig|token|share_token|title|filename|document(?:Text)?|name|password|pw_hash|pw_salt)\s*[:=]\s*'
    r"""(?:"[^"]*"|'[^']*'|[^\s&#,;)]+)""", re.I)
PATHS = re.compile(r"""(?:[a-z][a-z0-9+.-]*://|(?<![^\s(@])(?:[a-z]:)?[/\\])[^\s()<>"']+""", re.I)
DOC_NAMES = re.compile(r"""[^\s/\\:*?"<>|]+\.(?:docx?|xlsx?|pptx?|od[pts]|hwpx?|hcell|hshow|cell|show|nxl|hcdt|hsdt|pdf|rtf|csv|txt)\b""", re.I)


class ClientError(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    ts: datetime
    kind: Literal["js", "promise", "api", "toast", "editor"]
    message: str = Field(min_length=1, max_length=500)
    stack: str = Field(max_length=4000)
    page: Literal["home", "edit", "login", "admin"]
    fileType: Literal["word", "cell", "slide", "hwp", "pdf"] | None = None
    ua: str = Field(max_length=200)
    build: str = Field(max_length=100)
    sessionId: uuid.UUID
    uid: int | None = Field(default=None, gt=0)
    filename: str | None = Field(default=None, max_length=200, pattern=rf"^{SOURCE}$")
    line: int | None = Field(default=None, ge=0)
    col: int | None = Field(default=None, ge=0)
    method: Literal["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "OTHER"] | None = None
    route: str | None = Field(default=None, pattern=CLIENT_ROUTE)
    status: Literal[0] | Annotated[int, Field(ge=500, le=599)] | None = None
    request_id: str | None = Field(default=None, pattern=rf"^{REQUEST_ID}$")
    errorCode: int | None = None


CLIENT_BATCH = TypeAdapter(Annotated[list[ClientError], Field(min_length=1, max_length=20)])


def scrub(value: str, limit: int, private_values=()) -> str:
    for secret in private_values:
        if secret:
            value = value.replace(secret, "[삭제]")

    def basename(match):
        path = re.split(r"[?#]", match[0], maxsplit=1)[0]
        name = re.split(r"[/\\]", path)[-1]
        return name if re.fullmatch(rf"{SOURCE}(?::\d+){{0,2}}", name, re.I) else "[경로]"

    value = PATHS.sub(basename, value)
    value = re.sub(rf"(?<![^\s(@])(?:[\w.-]+[/\\])+({SOURCE}(?::\d+){{0,2}})\b", r"\1", value, flags=re.I)
    value = re.sub(r"""\?[^\s)<>"']+""", "[삭제]", value)
    value = QUERY_FIELDS.sub("[삭제]", value)
    value = re.sub(r"[\w.+-]+@[\w.-]+\.[a-z]{2,}", "[이메일]", value, flags=re.I)
    value = OPAQUE.sub("[식별자]", value)
    return DOC_NAMES.sub("[파일]", value)[:limit]


def request_id(value: str | None) -> str:
    if value and re.fullmatch(REQUEST_ID, value) and (
        re.fullmatch(UUID, value, re.I) or not (OPAQUE.search(value) or DOC_NAMES.search(value))
    ):
        return value
    return str(uuid.uuid4())


def _logger(name):
    logger = logging.getLogger(f"myoffice.{name}")
    logger.setLevel(logging.INFO)
    logger.propagate = False
    if not logger.handlers:
        handler = logging.StreamHandler(sys.stdout)
        handler.setFormatter(logging.Formatter("%(message)s"))
        logger.addHandler(handler)
    return logger


class ErrorLogs:
    def __init__(self, directory: Path):
        self.directory = directory
        self.loggers = {name: _logger(name) for name in ("client_error", "server_error")}

    def prune(self):
        cutoff = datetime.now(timezone.utc).date() - timedelta(days=30)
        try:
            self.directory.mkdir(parents=True, exist_ok=True)
            for path in self.directory.glob("*-errors-*.jsonl"):
                match = re.fullmatch(r"(?:client|server)-errors-(\d{4}-\d{2}-\d{2})\.jsonl", path.name)
                if match and date.fromisoformat(match[1]) < cutoff:
                    path.unlink(missing_ok=True)
        except (OSError, ValueError):
            logging.getLogger(__name__).warning("오류 로그 정리 실패")

    async def prune_daily(self):
        while True:
            await asyncio.sleep(86400)
            await asyncio.to_thread(self.prune)

    def write(self, source: str, records: list[dict]):
        logger = self.loggers[f"{source}_error"]
        day = datetime.now(timezone.utc).date()
        lines = []
        for record in records:
            record["logger"] = logger.name
            line = json.dumps(record, ensure_ascii=False, separators=(",", ":"))
            line = line.encode("utf-8", errors="backslashreplace").decode("utf-8")
            logger.info("%s", line)
            lines.append(line)
        try:
            path = self.directory / f"{source}-errors-{day}.jsonl"
            with path.open("a", encoding="utf-8", errors="backslashreplace") as stream:
                stream.write("\n".join(lines) + "\n")
        except OSError:
            logging.getLogger(__name__).warning("오류 로그 파일 저장 실패")

    def client(self, items: list[ClientError], uid: int | None):
        records = []
        for item in items:
            record = item.model_dump(mode="json", exclude_none=True, exclude={"uid", "request_id"})
            for field in ("message", "stack", "build", "ua", "filename"):
                if field in record:
                    record[field] = scrub(record[field], len(record[field]))
            if item.request_id and request_id(item.request_id) == item.request_id:
                record["request_id"] = item.request_id
            if uid is not None:
                record["uid"] = uid
            record["level"] = "ERROR"
            records.append(record)
            CLIENT_ERRORS.labels(item.kind, item.page).inc()
        self.write("client", records)

    def server(self, scope, status, *, error=None, message=None):
        state = scope["state"]
        route = getattr(scope.get("route"), "path", "other")
        if route == "/internal/callback/{ws}/{fid}":
            kind = "onlyoffice_callback"
        elif route in {"/api/files/{fid}/convert", "/api/files/{fid}/export"}:
            kind = "conversion"
        else:
            kind = "server"
        private_values = state.get("log_private_values", ())
        frames = traceback.extract_tb(error.__traceback__) if error else ()
        # 소스 코드 줄과 로컬 변수는 기록하지 않는다.
        stack = "\n".join(f"{Path(frame.filename).name}:{frame.lineno} in {frame.name}" for frame in frames)
        if isinstance(error, HTTPException) and isinstance(error.detail, str):
            message = error.detail
        elif error is not None:
            # 입력을 파싱하거나 키를 찾는 예외의 메시지는 입력 원문을 포함할 수 있다.
            message = type(error).__name__ if isinstance(error, (ValueError, LookupError)) else str(error)
        text = message or (HTTPStatus(status).phrase if status in HTTPStatus._value2member_map_ else f"HTTP {status}")
        self.write("server", [{
            "ts": datetime.now(timezone.utc).isoformat(),
            "level": "ERROR",
            "kind": kind,
            "request_id": state["request_id"],
            "method": scope["method"],
            "route": route,
            "status": status,
            "uid": state.get("error_log_uid"),
            "exception": type(error).__name__ if error else None,
            "message": scrub(text, 500, private_values),
            "traceback": scrub(stack, len(stack), private_values)[-8000:],
        }])
        SERVER_ERRORS.labels(route).inc()


class RequestErrors:
    def __init__(self, app, logs: ErrorLogs):
        self.app = app
        self.logs = logs

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        headers = Headers(scope=scope)
        state = scope.setdefault("state", {})
        state["request_id"] = request_id(headers.get("x-request-id"))
        state["log_private_values"] = [headers.get("x-share"), headers.get("authorization", "").removeprefix("Bearer ")]
        private_context = PRIVATE_VALUES.set(state["log_private_values"])
        status = 500
        complete = False

        async def tracked_send(message):
            nonlocal status, complete
            if message["type"] == "http.response.start":
                status = message["status"]
                MutableHeaders(scope=message)["X-Request-ID"] = state["request_id"]
            await send(message)
            if message["type"] == "http.response.body" and not message.get("more_body", False):
                complete = True

        error = None
        try:
            await self.app(scope, receive, tracked_send)
        except Exception as exc:
            error = exc
            if not complete:
                # 응답 스트림이 끊긴 경우 ASGI 서버가 연결을 종료하도록 한다.
                raise RuntimeError("HTTP 응답 처리 실패") from None
        finally:
            PRIVATE_VALUES.reset(private_context)
            if error is not None or status >= 500:
                self.logs.server(scope, status, error=error or state.get("error_log_http_exception"))
