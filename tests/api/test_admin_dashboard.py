"""임시 저장소와 ASGI 요청으로 관리자 대시보드를 검증한다."""
import asyncio
import importlib
import io
import json
import time
from datetime import datetime, timezone
from pathlib import Path

import httpx
import pytest

API_SOURCE = Path(__file__).resolve().parents[2] / "api"
if not (API_SOURCE / "app" / "main.py").is_file():
    pytest.skip("API 소스가 필요한 오프라인 테스트입니다", allow_module_level=True)
pytest.importorskip("fastapi")

ENDPOINTS = {
    "overview": {"users", "documents", "storage", "live", "errors24h", "unreadFeedback",
                 "activityDaily", "errorsDaily"},
    "documents": {"total", "byType", "created7d", "modified7d", "shareLinks", "storedBytes", "largest"},
    "errors": {"days", "tests", "skipped", "groups"},
    "status": {"api", "onlyoffice", "disk", "prometheus"},
}


@pytest.fixture
def cleanup_users():
    # 이 모듈은 공용 테스트 서버에 접속하지 않는다.
    yield


@pytest.fixture(scope="module")
def dashboard_client(tmp_path_factory):
    with pytest.MonkeyPatch.context() as patch:
        root = tmp_path_factory.mktemp("admin-dashboard")
        patch.syspath_prepend(str(API_SOURCE))
        patch.setenv("DATA_DIR", str(root))
        patch.setenv("JWT_SECRET", "offline-jwt")
        patch.setenv("SIGN_SECRET", "offline-sign")
        patch.setenv("APP_BUILD", "offline-test")
        patch.delenv("ADMIN_PASSWORD", raising=False)
        main = importlib.import_module("app.main")

        admin = main.accounts.create_user("testadmin", "test-password", "관리자", is_admin=True)
        member = main.accounts.create_user("testmember", "test-password", "사용자")

        def headers(user):
            return {"Authorization": f"Bearer {main.accounts.new_session(user['id'])}"}

        doc = main.create_file(member["ws"], "비공개-문서.xlsx", "xlsx", b"private-body", "hcell")
        doc["share"] = {"mode": "edit", "token": "private-share-token"}
        main.write_meta(member["ws"], doc)
        (root / "logs").mkdir()
        now = datetime.now(timezone.utc)
        main.error_logs.write("client", [
            {"ts": now.isoformat(), "kind": "api", "message": "오류 12345678901", "page": "admin"},
            {"ts": now.isoformat(), "kind": "api", "message": "오류 12345678902", "page": "admin"},
            {"ts": now.isoformat(), "kind": "api", "message": "API_TEST_ERROR"},
        ])

        def service_response(client, url, **kwargs):
            if url.endswith("/healthcheck"):
                return httpx.Response(200, json=True)
            assert url == "http://prometheus:9090/api/v1/query"
            raise httpx.ConnectError("오프라인")

        patch.setattr(httpx.Client, "get", service_response)
        # ASGI lifespan을 시작하지 않아 메트릭 포트와 자동 저장 작업을 열지 않는다.
        def request(path, headers=None, *, method="GET", **kwargs):
            async def send():
                transport = httpx.ASGITransport(app=main.app)
                async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
                    return await client.request(method, path, headers=headers, **kwargs)

            return asyncio.run(send())

        try:
            yield request, headers(admin), headers(member), doc["id"]
        finally:
            main.accounts.db.close()


@pytest.mark.parametrize("endpoint", ENDPOINTS)
def test_admin_dashboard_permissions_and_shape(dashboard_client, endpoint):
    get, admin, member, _ = dashboard_client
    path = f"/api/admin/{endpoint}"
    assert get(path).status_code == 401
    assert get(path, headers=member).status_code == 403
    response = get(path, headers=admin)
    assert response.status_code == 200, response.text
    assert ENDPOINTS[endpoint] == response.json().keys()


def test_admin_documents_expose_aggregates_and_safe_fields(dashboard_client):
    get, admin, _, fid = dashboard_client
    response = get("/api/admin/documents", headers=admin)
    result = response.json()
    assert result["byType"] == {"hcell": 1}
    assert result["shareLinks"] == {"view": 0, "edit": 1}
    assert result["created7d"] == 1
    assert result["modified7d"] == 0
    document, = result["largest"]
    assert set(document) == {"id", "owner", "type", "size", "modified"}
    assert document["id"] == fid[:8]
    assert document["owner"] == "testmember"
    assert document["modified"] <= int(time.time())
    for private in ("비공개-문서", "private-share-token", "private-body", "filename",
                    "file_name", "password", "pw_hash", "email", fid):
        assert private not in response.text.lower()


def test_admin_overview_and_error_groups(dashboard_client):
    get, admin, _, _ = dashboard_client
    overview = get("/api/admin/overview", headers=admin).json()
    assert overview["errors24h"] == {"client": 2, "server": 0}
    assert len(overview["activityDaily"]) == 30
    assert len(overview["errorsDaily"]) == 14
    assert sum(day["documents"] for day in overview["activityDaily"]) == 1
    assert overview["storage"]["dataBytes"] >= overview["storage"]["storedBytes"] > 0

    result = get("/api/admin/errors?days=1&tests=0", headers=admin).json()
    group, = result["groups"]
    assert (group["message"], group["count"], group["pages"]) == ("오류 <숫자>", 2, ["admin"])
    with_tests = get("/api/admin/errors?days=1&tests=1", headers=admin).json()
    assert len(with_tests["groups"]) == 2


def test_admin_status_with_prometheus_offline(dashboard_client):
    get, admin, _, _ = dashboard_client
    status = get("/api/admin/status", headers=admin).json()
    assert status["api"]["ok"] and status["api"]["build"] == "offline-test"
    assert status["onlyoffice"]["ok"]
    assert status["disk"]["freeBytes"] > 0
    assert status["prometheus"] == {
        "available": False, "windowSeconds": 3600, "requestsPerMinute": None,
        "p95Seconds": None, "errorRate": None,
    }


@pytest.fixture
def feedback_png():
    from PIL import Image, PngImagePlugin

    output = io.BytesIO()
    metadata = PngImagePlugin.PngInfo()
    metadata.add_text("Comment", "private metadata")
    Image.new("RGB", (20, 12), "blue").save(output, format="PNG", pnginfo=metadata)
    return output.getvalue()


FEEDBACK_PAYLOAD = {"kind": "bug", "message": "이미지 첨부 테스트입니다", "page": "home"}


def post_feedback_images(request, *images):
    return request("/api/feedback", method="POST", data={"payload": json.dumps(FEEDBACK_PAYLOAD)},
                   files=[("images", ("private.png", image, "image/png")) for image in images])


def test_feedback_image_access_metadata_and_deletion(dashboard_client, feedback_png):
    from PIL import Image

    request, admin, member, _ = dashboard_client
    response = post_feedback_images(request, feedback_png)
    assert response.status_code == 201, response.text
    fid = response.json()["id"]
    path = f"/api/admin/feedback/{fid}/images/1"
    assert request(path).status_code == 401
    assert request(path, member).status_code == 403
    result = request(path, admin)
    assert result.status_code == 200
    assert result.headers["content-type"] == "image/webp"
    assert result.headers["content-disposition"] == 'inline; filename="image-1.webp"'
    assert result.headers["x-content-type-options"] == "nosniff"
    assert result.headers["content-security-policy"] == "default-src 'none'"
    assert result.headers["cache-control"] == "no-store"
    with Image.open(io.BytesIO(result.content)) as image:
        assert image.size == (20, 12)
        assert "Comment" not in image.info
    assert b"private metadata" not in result.content

    items = request("/api/admin/feedback", admin).json()["items"]
    item = next(item for item in items if item["id"] == fid)
    assert item["images"] == [{"n": 1, "mime": "image/webp", "size": len(result.content)}]
    accounts = importlib.import_module("app.main").accounts
    storage = accounts.feedback_dir / str(fid)
    assert (storage / "1.webp").is_file()
    assert request(f"/api/admin/feedback/{fid}", admin, method="DELETE").status_code == 204
    assert not storage.exists()
    assert request(path, admin).status_code == 404


@pytest.mark.parametrize("image_count", [1, 4])
def test_feedback_rejects_non_images_and_four_attachments(dashboard_client, feedback_png, image_count):
    request, admin, _, _ = dashboard_client
    before = request("/api/admin/feedback", admin).json()["total"]
    images = [b"not a real image"] if image_count == 1 else [feedback_png] * image_count
    assert post_feedback_images(request, *images).status_code == 422
    assert request("/api/admin/feedback", admin).json()["total"] == before


def test_feedback_attachment_size_limits(dashboard_client, feedback_png):
    request, _, _, _ = dashboard_client
    too_large = feedback_png.ljust(5 * 1024 * 1024 + 1, b"\x00")
    assert post_feedback_images(request, too_large).status_code == 413
    huge = b"--example\r\nContent-Disposition: form-data; name=\"images\"; filename=\"a.png\"\r\n\r\n"
    huge = huge.ljust(16 * 1024 * 1024 + 1, b"0")
    response = request("/api/feedback", method="POST", content=huge,
                       headers={"Content-Type": "multipart/form-data; boundary=example"})
    assert response.status_code == 413


def test_feedback_json_submission_still_works(dashboard_client):
    request, admin, _, _ = dashboard_client
    response = request("/api/feedback", method="POST", json=FEEDBACK_PAYLOAD)
    assert response.status_code == 201
    fid = response.json()["id"]
    items = request("/api/admin/feedback", admin).json()["items"]
    assert next(item for item in items if item["id"] == fid)["images"] == []
