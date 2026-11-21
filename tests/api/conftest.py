import io
import os
import secrets
import zipfile
from pathlib import Path

import httpx
import pytest

API = os.environ.get("API_URL", "https://api.myoffice.p-e.kr").rstrip("/")
WEB = os.environ.get("WEB_URL", "https://www.myoffice.p-e.kr").rstrip("/")
FIX = Path(__file__).resolve().parent.parent / "fixtures"


ADMIN_USER = os.environ.get("ADMIN_USERNAME", "admin")
ADMIN_PASSWORD = os.environ["ADMIN_PASSWORD"]


@pytest.fixture(scope="session")
def http():
    with httpx.Client(base_url=API, timeout=180) as c:
        yield c


@pytest.fixture(scope="session")
def admin(http):
    r = http.post("/api/auth/login", json={"username": ADMIN_USER, "password": ADMIN_PASSWORD})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['token']}"}


_created = []


def new_user(http, admin, name="테스터"):
    """관리자 API로 테스트 계정을 만들고 로그인 헤더를 돌려준다 (가입 횟수 제한에 안 걸리게)."""
    uname = "t_" + secrets.token_hex(6)
    pw = secrets.token_urlsafe(12)
    r = http.post("/api/admin/users", headers=admin, json={"username": uname, "password": pw, "name": name})
    assert r.status_code == 200, r.text
    _created.append(r.json()["id"])
    tok = http.post("/api/auth/login", json={"username": uname, "password": pw}).json()["token"]
    return {"Authorization": f"Bearer {tok}", "_username": uname, "_password": pw, "_id": r.json()["id"], "_token": tok}


def hdr(u):
    return {"Authorization": u["Authorization"]}


@pytest.fixture
def U(http, admin):
    return new_user(http, admin)


@pytest.fixture
def H(U):
    return hdr(U)


@pytest.fixture(scope="session", autouse=True)
def cleanup_users(http, admin):
    yield
    for uid in _created:
        http.delete(f"/api/admin/users/{uid}", headers=admin)


def make(http, H, kind):
    r = http.post("/api/files/new", headers=H, json={"type": kind})
    assert r.status_code == 200, r.text
    return r.json()


def upload(http, H, name, data):
    return http.post("/api/files/upload", headers=H, files={"file": (name, data)})


def docx_bytes(text: str) -> bytes:
    """python-docx 없이 최소 docx 생성."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
        z.writestr("_rels/.rels", '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
        z.writestr("word/document.xml", f'<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>{text}</w:t></w:r></w:p></w:body></w:document>')
    return buf.getvalue()
