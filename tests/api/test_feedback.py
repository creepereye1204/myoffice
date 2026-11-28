import base64
import json
import secrets
import uuid
from pathlib import Path

import pytest

FEEDBACK = "/api/feedback"
ADMIN_FEEDBACK = "/api/admin/feedback"
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAD0lEQVR4nGNgaPgPQhAKACX2Bf2gcp/LAAAAAElFTkSuQmCC"
)


def image_files(data):
    return [("images", ("test.png", item, "image/png")) for item in data]


@pytest.fixture
def payload():
    return {"kind": "bug", "page": "home", "message": f"API_TEST_FEEDBACK {secrets.token_hex(8)}"}


@pytest.fixture
def submit(http, admin):
    ids = []

    def post(body, headers=None, *, images=None):
        if images is None:
            response = http.post(FEEDBACK, json=body, headers=headers)
        else:
            response = http.post(FEEDBACK, data={"payload": json.dumps(body)},
                                 files=image_files(images), headers=headers)
        if response.status_code == 201:
            ids.append((response.json()["id"], images is not None))
        return response

    yield post
    results = [(fid, attached, http.delete(f"{ADMIN_FEEDBACK}/{fid}", headers=admin))
               for fid, attached in ids]
    for fid, attached, result in results:
        assert result.status_code == 204, result.text
        if attached:
            assert http.get(f"{ADMIN_FEEDBACK}/{fid}/images/1", headers=admin).status_code == 404


@pytest.mark.parametrize("fields", [
    {"message": "API_"},
    {"message": "API_TEST_FEEDBACK " + "가" * 2000},
    {"email": "잘못된-이메일"},
    {"user_id": 1},
])
def test_feedback_validation(submit, payload, fields):
    response = submit({**payload, **fields})
    assert response.status_code == 422, response.text


def test_feedback_body_limit(submit, payload):
    response = submit({**payload, "message": payload["message"] + "a" * (16 * 1024)})
    assert response.status_code == 413, response.text


@pytest.mark.parametrize("images", [[b"not an image"], [PNG] * 4])
def test_feedback_rejects_invalid_images(submit, payload, images):
    response = submit(payload, images=images)
    assert response.status_code == 422, response.text


def test_feedback_access_and_rate_limit(http, admin, U, H, submit, payload):
    # 같은 IP에서 성공 요청 5건을 채우므로 실행 전 이 IP의 제출 한도가 비어 있어야 한다.
    session_id = str(uuid.uuid4())
    guest = submit({
        **payload,
        "session_id": session_id,
        "errors": [{"kind": "js", "message": "오류 설명"}],
    })
    assert guest.status_code == 201, guest.text
    fid = guest.json()["id"]
    location = f"{ADMIN_FEEDBACK}/{fid}"

    for headers, status in [(None, 401), (H, 403)]:
        assert http.get(ADMIN_FEEDBACK, headers=headers).status_code == status
        assert http.patch(location, headers=headers, json={"status": "read"}).status_code == status
        assert http.delete(location, headers=headers).status_code == status

    member = submit({**payload, "kind": "suggestion", "email": "reply@example.com"}, headers=H, images=[PNG])
    assert member.status_code == 201, member.text

    def listed(fid, **filters):
        response = http.get(ADMIN_FEEDBACK, headers=admin, params={"limit": 100, **filters})
        assert response.status_code == 200, response.text
        return next(row for row in response.json()["items"] if row["id"] == fid)

    guest_row = listed(fid, status="new", kind="bug")
    assert guest_row["user_id"] is None
    assert guest_row["session_id"] == session_id
    assert "오류 설명" in guest_row["errors_json"]
    member_row = listed(member.json()["id"], status="new", kind="suggestion")
    assert member_row["user_id"] == U["_id"]
    assert member_row["email"] == "reply@example.com"
    assert guest_row["image_count"] == 0
    assert member_row["image_count"] == 1
    assert member_row["images"][0]["n"] == 1
    image_url = f"{ADMIN_FEEDBACK}/{member_row['id']}/images/1"
    assert http.get(image_url, headers=H).status_code == 403
    image = http.get(image_url, headers=admin)
    assert image.status_code == 200, image.text
    assert image.headers["Content-Type"] == "image/webp"
    assert image.headers["Content-Disposition"] == 'inline; filename="image-1.webp"'
    assert image.headers["X-Content-Type-Options"] == "nosniff"
    assert image.headers["Content-Security-Policy"] == "default-src 'none'"
    assert image.headers["Cache-Control"] == "no-store"
    assert image.content.startswith(b"RIFF") and image.content[8:12] == b"WEBP"
    assert http.patch(location, headers=admin, json={"status": "read"}).status_code == 204
    assert listed(fid, status="read", kind="bug")["status"] == "read"

    for i in range(4):
        response = submit({**payload, "message": f"{payload['message']} {i}"})
        assert response.status_code == (201 if i < 3 else 429), response.text


class TestFeedbackStorage:
    @pytest.fixture
    def cleanup_users(self):
        # 임시 저장소 테스트에서는 공용 서버에 접속하지 않는다.
        yield

    def test_delete_removes_image_files(self, tmp_path, monkeypatch):
        source = Path(__file__).resolve().parents[2] / "api"
        if not (source / "app" / "accounts.py").is_file():
            pytest.skip("저장소 테스트에는 API 소스가 필요합니다")
        monkeypatch.syspath_prepend(str(source))
        from app.accounts import Accounts

        accounts = Accounts(tmp_path / "app.db")
        try:
            fields = (None, "bug", "첨부 삭제 확인", None, "home", None, None, None, None, None, "[]")
            fid = accounts.add_feedback(fields, [("png", "image/png", PNG)])
            directory = tmp_path / "feedback" / str(fid)
            assert (directory / "1.png").read_bytes() == PNG
            assert accounts.delete_feedback(fid)
            assert not directory.exists()
            assert accounts.get_feedback_image(fid, 1) is None
        finally:
            accounts.db.close()
