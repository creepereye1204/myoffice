import secrets
import uuid

import pytest

FEEDBACK = "/api/feedback"
ADMIN_FEEDBACK = "/api/admin/feedback"


@pytest.fixture
def payload():
    return {"kind": "bug", "page": "home", "message": f"API_TEST_FEEDBACK {secrets.token_hex(8)}"}


@pytest.fixture
def submit(http, admin):
    ids = []

    def post(body, headers=None):
        response = http.post(FEEDBACK, json=body, headers=headers)
        if response.status_code == 201:
            ids.append(response.json()["id"])
        return response

    yield post
    results = [http.delete(f"{ADMIN_FEEDBACK}/{fid}", headers=admin) for fid in ids]
    for result in results:
        assert result.status_code == 204, result.text


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

    member = submit({**payload, "kind": "suggestion", "email": "reply@example.com"}, headers=H)
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
    assert http.patch(location, headers=admin, json={"status": "read"}).status_code == 204
    assert listed(fid, status="read", kind="bug")["status"] == "read"

    for i in range(4):
        response = submit({**payload, "message": f"{payload['message']} {i}"})
        assert response.status_code == (201 if i < 3 else 429), response.text
