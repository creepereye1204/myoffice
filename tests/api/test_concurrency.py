"""동시 요청 — 실제로 났던 버그: SQLite 연결을 여러 스레드가 동시에 써서 간헐적 500."""
from concurrent.futures import ThreadPoolExecutor

import httpx

from conftest import API, make


def test_parallel_requests_no_500(http, H):
    f = make(http, H, "docx")
    paths = [f"/api/files/{f['id']}", "/api/files", "/api/auth/me", "/api/shared-with-me", "/api/workspaces/me"] * 40

    def hit(p):
        with httpx.Client(base_url=API, timeout=60) as c:
            return c.get(p, headers=H).status_code

    with ThreadPoolExecutor(max_workers=24) as ex:
        codes = list(ex.map(hit, paths))
    assert set(codes) == {200}, {c: codes.count(c) for c in set(codes)}


def test_parallel_logins(http, U):
    def login(_):
        with httpx.Client(base_url=API, timeout=60) as c:
            return c.post("/api/auth/login", json={"username": U["_username"], "password": U["_password"]}).status_code

    with ThreadPoolExecutor(max_workers=16) as ex:
        codes = list(ex.map(login, range(32)))
    assert set(codes) == {200}
