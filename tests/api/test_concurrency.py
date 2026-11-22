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


def test_download_while_saving_is_never_torn(http, H):
    """실제로 났던 버그: 저장(파일 교체)과 다운로드가 겹치면 'Content-Length 불일치'로 전송이 끊겨
    변환(PDF 등)이 code -4 로 실패. 받는 쪽은 항상 저장 전 또는 저장 후의 온전한 파일을 받아야 한다."""
    from pathlib import Path
    from conftest import upload
    a = (Path(__file__).parent.parent / "fixtures" / "sample.hwp").read_bytes()
    b = a + b"\0" * 300_000  # 크기가 다른 두 버전
    f = upload(http, H, "race.hwp", a).json()
    stop = False

    def writer():
        n = 0
        with httpx.Client(base_url=API, timeout=60) as c:
            while not stop:
                r = c.put(f"/api/files/{f['id']}/content", content=b if n % 2 else a,
                          headers={**H, "Content-Type": "application/octet-stream"})
                assert r.status_code == 200, r.text
                n += 1
        return n

    def reader(_):
        with httpx.Client(base_url=API, timeout=60) as c:
            r = c.get(f"/api/files/{f['id']}/content", headers=H)
            return r.status_code, r.content in (a, b)

    with ThreadPoolExecutor(max_workers=13) as ex:
        w = ex.submit(writer)
        results = list(ex.map(reader, range(120)))
        stop = True
        assert w.result() > 3
    assert all(code == 200 and whole for code, whole in results), results
