"""브라우저 측정 수집 형식과 본문 크기 제한."""
import json

import pytest

from conftest import WEB


@pytest.fixture
def payload():
    return {
        "page": "edit",
        "fileType": "hwp",
        "groups": {
            "rhwp-wasm": {
                "count": 1,
                "sums": [1, 2, 3, 10, 8, 24, 1024, 900],
                "samples": [[1, 2, 3, 10, 8, 24, 1024, 900, False]],
            },
        },
    }


@pytest.mark.parametrize("media_type", ["text/plain;charset=UTF-8", "application/json"])
def test_rum_beacon(http, payload, media_type):
    r = http.post("/api/rum", content=json.dumps(payload), headers={"Content-Type": media_type, "Origin": WEB})
    assert r.status_code == 204, r.text
    assert r.headers.get("Access-Control-Allow-Origin") == WEB
    assert WEB in r.headers.get("Timing-Allow-Origin", "").replace(" ", "").split(",")


def test_rum_invalid_sample(http, payload):
    payload["groups"]["rhwp-wasm"]["samples"][0][0] = "1"
    assert http.post("/api/rum", json=payload).status_code == 422


@pytest.mark.parametrize("at_group", [False, True])
def test_rum_rejects_urls(http, payload, at_group):
    target = payload["groups"]["rhwp-wasm"] if at_group else payload
    target["url"] = "https://example.com/private"
    assert http.post("/api/rum", json=payload).status_code == 422


@pytest.mark.parametrize("chunked", [False, True])
def test_rum_body_limit(http, chunked):
    body = b" " * (64 * 1024 + 1)
    content = iter((body[:65536], body[65536:])) if chunked else body
    r = http.post("/api/rum", content=content, headers={"Content-Type": "text/plain"})
    assert r.status_code == 413
