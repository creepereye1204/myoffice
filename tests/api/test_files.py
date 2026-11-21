"""파일 API: 인증, 격리, 생성/업로드/이름/다운로드/저장/삭제, 변환."""
import time
import zipfile
import io

import pytest

from conftest import FIX, docx_bytes, make, new_user, hdr, upload, WEB


def test_health(http):
    assert http.get("/api/health").json() == {"ok": True}


@pytest.mark.parametrize("auth", [None, "", "Bearer", "Bearer x", "Bearer " + "x" * 300, "Basic YWRtaW46YWRtaW4=", "bearer abc"])
def test_bad_token_rejected(http, auth):
    h = {"Authorization": auth} if auth is not None else {}
    for path in ["/api/files", "/api/auth/me", "/api/workspaces/me", "/api/shared-with-me"]:
        assert http.get(path, headers=h).status_code == 401


def test_old_workspace_header_ignored(http):
    assert http.get("/api/files", headers={"X-Workspace": "A" * 43}).status_code == 401
    assert http.post("/api/workspaces").status_code in (404, 405)


@pytest.mark.parametrize("kind,ext,typ,app", [
    ("docx", "docx", "word", None), ("xlsx", "xlsx", "cell", None), ("pptx", "pptx", "slide", None),
    ("hwp", "hwp", "hwp", None), ("hwpx", "hwpx", "hwp", None),
    ("hcell", "xlsx", "cell", "hcell"), ("hshow", "pptx", "slide", "hshow"),
])
def test_new_file_each_type(http, H, kind, ext, typ, app):
    f = make(http, H, kind)
    assert (f["ext"], f["type"], f["app"], f["version"], f["editable"]) == (ext, typ, app, 1, True)
    assert f["name"].endswith("." + ext) and f["size"] > 0
    body = http.get(f"/api/files/{f['id']}/content", headers=H).content
    assert len(body) == f["size"]
    if ext in ("docx", "xlsx", "pptx", "hwpx"):
        zipfile.ZipFile(io.BytesIO(body)).testzip()  # 깨지지 않은 zip


def test_default_names_korean(http, H):
    names = {k: make(http, H, k)["name"] for k in ["docx", "xlsx", "pptx", "hwp", "hcell", "hshow"]}
    assert names == {"docx": "새 워드.docx", "xlsx": "새 엑셀.xlsx", "pptx": "새 파워포인트.pptx",
                     "hwp": "새 한글.hwp", "hcell": "새 한셀.xlsx", "hshow": "새 한쇼.pptx"}


def test_pptx_template_centered(http, H):
    """16:9 템플릿에서 제목/부제목이 가운데 (예전 버그: 왼쪽 치우침)."""
    from xml.etree import ElementTree as ET
    f = make(http, H, "pptx")
    z = zipfile.ZipFile(io.BytesIO(http.get(f"/api/files/{f['id']}/content", headers=H).content))
    ns = {"p": "http://schemas.openxmlformats.org/presentationml/2006/main", "a": "http://schemas.openxmlformats.org/drawingml/2006/main"}
    W = int(ET.fromstring(z.read("ppt/presentation.xml")).find("p:sldSz", ns).get("cx"))
    checked = 0
    for name in z.namelist():
        if not (name.startswith("ppt/slideLayouts/slideLayout") and name.endswith(".xml")) and name not in ("ppt/slides/slide1.xml", "ppt/slideMasters/slideMaster1.xml"):
            continue
        root = ET.fromstring(z.read(name))
        # 제목이 원래 가운데인 레이아웃만 (세로 제목/캡션형은 설계상 한쪽에 있음)
        if "slideLayout" in name and root.get("type") not in ("title", "obj", "secHead", "titleOnly", "twoObj", "twoTxTwoObj"):
            continue
        for sp in root.iter("{%s}sp" % ns["p"]):
            ph = sp.find(".//p:nvPr/p:ph", ns)
            off, ext = sp.find(".//a:xfrm/a:off", ns), sp.find(".//a:xfrm/a:ext", ns)
            if ph is None or off is None or ph.get("type") not in ("title", "ctrTitle", "subTitle", None):
                continue
            x, w = int(off.get("x")), int(ext.get("cx"))
            assert 0 <= x and x + w <= W * 1.01, f"{name} 밖으로 나감"
            if ph.get("type") in ("title", "ctrTitle", "subTitle"):
                assert abs((x + w / 2) / W - 0.5) < 0.03, f"{name} {ph.get('type')} 중심={(x + w / 2) / W:.3f}"
                checked += 1
    assert checked >= 4  # 마스터 제목 + 슬라이드1 제목/부제목 + 제목 레이아웃


def test_new_file_bad_type(http, H):
    for t in ["exe", "", "pdf", "../hwp"]:
        assert http.post("/api/files/new", headers=H, json={"type": t}).status_code == 400


def test_upload_and_roundtrip(http, H):
    data = (FIX / "sample.hwp").read_bytes()
    r = upload(http, H, "보고서.hwp", data)
    assert r.status_code == 200
    f = r.json()
    assert f["name"] == "보고서.hwp" and f["size"] == len(data)
    assert http.get(f"/api/files/{f['id']}/content", headers=H).content == data


@pytest.mark.parametrize("name", ["a.exe", "a", "a.html", "a.js", "x.svg"])
def test_upload_disallowed(http, H, name):
    assert upload(http, H, name, b"hello").status_code == 400


@pytest.mark.parametrize("ext", ["cell", "show"])
def test_upload_hancom_native_has_guidance(http, H, ext):
    r = upload(http, H, f"x.{ext}", b"hello")
    assert r.status_code == 400 and "xlsx/pptx" in r.json()["detail"]


def test_upload_too_large(http, H):
    r = upload(http, H, "big.txt", b"a" * (50 * 1024 * 1024 + 10))
    assert r.status_code == 413


def test_upload_filename_sanitized(http, H):
    f = upload(http, H, "../../evil<script>.docx", docx_bytes("x")).json()
    assert "/" not in f["name"] and "<" not in f["name"] and f["name"].endswith(".docx")


def test_workspace_isolation(http, H, admin):
    f = make(http, H, "docx")
    other = hdr(new_user(http, admin))
    for method, path in [("GET", ""), ("GET", "/content"), ("GET", "/onlyoffice"), ("GET", "/download-link"),
                         ("DELETE", ""), ("POST", "/share")]:
        r = http.request(method, f"/api/files/{f['id']}{path}", headers=other, json={} if method == "POST" else None)
        assert r.status_code == 404, (method, path, r.status_code)
    assert http.get("/api/files", headers=other).json() == []
    assert http.get(f"/api/files/{f['id']}", headers=H).status_code == 200


@pytest.mark.parametrize("fid", ["..", "..%2F..%2Fetc", "0" * 31, "g" * 32, "A" * 32])
def test_bad_file_ids(http, H, fid):
    assert http.get(f"/api/files/{fid}", headers=H).status_code in (404, 422)


def test_list_sorted_and_usage(http, H):
    a = make(http, H, "docx"); time.sleep(1.1); b = make(http, H, "xlsx")
    ids = [f["id"] for f in http.get("/api/files", headers=H).json()]
    assert ids == [b["id"], a["id"]]
    u = http.get("/api/workspaces/me", headers=H).json()
    assert u["files"] == 2 and u["used"] == a["size"] + b["size"]


@pytest.mark.parametrize("given,expected", [
    ("새 이름", "새 이름.docx"), ("a/b\\c", "a_b_c.docx"), ("이미.docx", "이미.docx"),
    ("   ", "제목 없음.docx"), ("x" * 300, "x" * 120 + ".docx"), ("..", "제목 없음.docx"),
])
def test_rename(http, H, given, expected):
    f = make(http, H, "docx")
    r = http.patch(f"/api/files/{f['id']}", headers=H, json={"name": given})
    assert r.status_code == 200 and r.json()["name"] == expected


def test_download_link(http, H):
    f = make(http, H, "docx")
    link = http.get(f"/api/files/{f['id']}/download-link", headers=H).json()
    r = http.get(link["url"])
    assert r.status_code == 200 and len(r.content) == f["size"]
    assert "attachment" in r.headers["content-disposition"]
    tampered = link["url"].replace("sig=", "sig=0")
    assert http.get(tampered).status_code == 403
    expired = link["url"].split("?")[0] + "?exp=1&sig=" + link["url"].split("sig=")[1]
    assert http.get(expired).status_code == 403


def test_hwp_save_versions(http, H):
    f = make(http, H, "hwp")
    data = (FIX / "sample.hwp").read_bytes()
    url = f"/api/files/{f['id']}/content"
    hdr = {**H, "Content-Type": "application/octet-stream"}
    r = http.put(url, headers={**hdr, "X-Base-Version": "1"}, content=data)
    assert r.status_code == 200 and r.json()["version"] == 2 and r.json()["size"] == len(data)
    got = http.get(url, headers=H)
    assert got.content == data and got.headers["x-file-version"] == "2"
    # 옛 버전 기준 저장은 거부 (그 사이 누가 저장함)
    assert http.put(url, headers={**hdr, "X-Base-Version": "1"}, content=b"x").status_code == 409
    assert http.put(url, headers=hdr, content=b"").status_code == 400
    assert http.get(url, headers=H).content == data


def test_put_content_rejected_for_office(http, H):
    f = make(http, H, "docx")
    assert http.put(f"/api/files/{f['id']}/content", headers=H, content=b"x").status_code == 400


def test_delete(http, H):
    f = make(http, H, "docx")
    assert http.delete(f"/api/files/{f['id']}", headers=H).status_code == 200
    assert http.get(f"/api/files/{f['id']}", headers=H).status_code == 404
    assert http.delete(f"/api/files/{f['id']}", headers=H).status_code == 404


def test_onlyoffice_config(http, U):
    H = hdr(U)
    f = make(http, H, "docx")
    j = http.get(f"/api/files/{f['id']}/onlyoffice", headers=H, params={"uid": "user123", "name": "홍길동"}).json()
    c = j["config"]
    assert j["apiUrl"] == "/office/web-apps/apps/api/documents/api.js"
    assert c["document"]["key"] == f"{f['id']}_1" and c["editorConfig"]["mode"] == "edit"
    # 계정 사용자는 보낸 값과 상관없이 계정 기준 (여러 탭·기기에서 같은 사람)
    assert c["editorConfig"]["user"] == {"id": f"u{U['_id']}", "name": "테스터"}
    assert c["token"].count(".") == 2
    # 링크로 들어온 손님: 보낸 uid/name 사용, 이상한 값은 정리
    tok = http.post(f"/api/files/{f['id']}/share", headers=H, json={"mode": "edit"}).json()["token"]
    S = {"X-Share": tok}
    c1 = http.get(f"/api/files/{f['id']}/onlyoffice", headers=S, params={"uid": "g1", "name": "손님"}).json()["config"]
    assert c1["editorConfig"]["user"] == {"id": "g1", "name": "손님"}
    c2 = http.get(f"/api/files/{f['id']}/onlyoffice", headers=S, params={"uid": "<x>", "name": "<b>a</b>"}).json()["config"]
    assert c2["editorConfig"]["user"]["id"] != "<x>" and "<" not in c2["editorConfig"]["user"]["name"]
    h = make(http, H, "hwp")
    assert http.get(f"/api/files/{h['id']}/onlyoffice", headers=H).status_code == 400


def test_onlyoffice_api_js_served():
    import httpx
    r = httpx.get(WEB + "/office/web-apps/apps/api/documents/api.js", timeout=30)
    assert r.status_code == 200 and "DocsAPI" in r.text


def test_internal_endpoints_need_signature(http, H):
    f = make(http, H, "docx")
    ws = "A" * 43
    assert http.get(f"/internal/dl/{ws}/{f['id']}", params={"sig": "x"}).status_code == 403
    assert http.post(f"/internal/callback/{ws}/{f['id']}", params={"sig": "x"}, json={"status": 2}).status_code == 403


@pytest.mark.parametrize("kind,to,expect_ext", [
    ("docx", "pdf", "pdf"), ("xlsx", "pdf", "pdf"), ("pptx", "pdf", "pdf"), ("hcell", "pdf", "pdf"),
])
def test_convert(http, H, kind, to, expect_ext):
    f = make(http, H, kind)
    r = http.post(f"/api/files/{f['id']}/convert", headers=H, json={"to": to})
    assert r.status_code == 200, r.text
    assert r.json()["ext"] == expect_ext and r.json()["size"] > 0


def test_convert_real_hwp(http, H):
    f = upload(http, H, "sample.hwp", (FIX / "sample.hwp").read_bytes()).json()
    d = http.post(f"/api/files/{f['id']}/convert", headers=H, json={"to": "docx"}).json()
    t = http.post(f"/api/files/{d['id']}/convert", headers=H, json={"to": "txt"}).json()
    text = http.get(f"/api/files/{t['id']}/content", headers=H).content.decode("utf-8", "ignore")
    assert "통합재정" in text.replace(" ", "")


def test_convert_text_roundtrip(http, H):
    f = upload(http, H, "a.docx", docx_bytes("안녕하세요 테스트")).json()
    t = http.post(f"/api/files/{f['id']}/convert", headers=H, json={"to": "txt"}).json()
    assert "안녕하세요 테스트" in http.get(f"/api/files/{t['id']}/content", headers=H).content.decode("utf-8", "ignore")


def test_convert_keeps_app(http, H):
    f = make(http, H, "hcell")
    out = http.post(f"/api/files/{f['id']}/convert", headers=H, json={"to": "ods"}).json()
    assert out["ext"] == "ods" and out["app"] == "hcell"


@pytest.mark.parametrize("to", ["exe", "docx", "hwp", ""])
def test_convert_invalid(http, H, to):
    f = make(http, H, "docx")
    assert http.post(f"/api/files/{f['id']}/convert", headers=H, json={"to": to}).status_code == 400


def test_cors(http):
    ok = http.options("/api/files", headers={"Origin": WEB, "Access-Control-Request-Method": "PUT",
                                             "Access-Control-Request-Headers": "authorization,x-share,x-client,x-base-version,content-type"})
    assert ok.status_code == 200 and ok.headers["access-control-allow-origin"] == WEB
    bad = http.options("/api/files", headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "GET"})
    assert bad.headers.get("access-control-allow-origin") != "https://evil.example"
