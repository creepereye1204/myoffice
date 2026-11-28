"""실행 중인 API의 브라우저 오류 수집과 요청 ID."""
import json
import uuid
from datetime import datetime, timezone

import pytest

from conftest import WEB

PATH = "/api/client-errors"


@pytest.fixture
def record():
    return {
        "ts": datetime.now(timezone.utc).isoformat(),
        "kind": "js",
        "message": "API_TEST_ERROR",
        "stack": "at test (home.js:1:2)",
        "page": "home",
        "ua": "test",
        "build": "test",
        "sessionId": str(uuid.uuid4()),
    }


def test_client_error_batch(http, record):
    request_id = "api-test-" + uuid.uuid4().hex[:12]
    response = http.post(PATH, content=json.dumps([record]), headers={
        "Content-Type": "text/plain;charset=UTF-8",
        "Origin": WEB,
        "X-Request-ID": request_id,
    })
    assert response.status_code == 204, response.text
    assert response.headers["X-Request-ID"] == request_id
    assert response.headers["Access-Control-Allow-Origin"] == WEB
    assert "x-request-id" in response.headers["Access-Control-Expose-Headers"].lower()
    health = http.get("/api/health", headers={"X-Request-ID": "invalid request id"})
    assert health.status_code == 200
    assert uuid.UUID(health.headers["X-Request-ID"])


@pytest.mark.parametrize("patch", [{"page": "other"}, {"url": "https://example.com"}, {"line": "1"}])
def test_client_error_invalid(http, record, patch):
    response = http.post(PATH, json=[{**record, **patch}])
    assert response.status_code == 422
    assert response.headers.get("X-Request-ID")


@pytest.mark.parametrize("chunked", [False, True])
def test_client_error_oversized(http, chunked):
    body = b" " * (64 * 1024 + 1)
    content = iter((body[:-1], body[-1:])) if chunked else body
    response = http.post(PATH, content=content, headers={"Content-Type": "text/plain"})
    assert response.status_code == 413
    assert response.headers.get("X-Request-ID")


def test_client_error_per_ip_record_limit(http, record):
    for _ in range(4):
        response = http.post(PATH, json=[record] * 20)
        assert response.headers.get("X-Request-ID")
        if response.status_code == 429:
            break
        assert response.status_code == 204, response.text
    else:
        pytest.fail("오류 레코드 60건을 초과한 IP에 429가 반환되지 않았습니다")
