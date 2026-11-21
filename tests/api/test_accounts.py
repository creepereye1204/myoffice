"""계정·관리자·사용자 지정 공유·PDF 내보내기."""
import secrets

import pytest

from conftest import FIX, make, new_user, hdr, upload, _created


def admin_find(http, admin, username):
    for u in http.get("/api/admin/users", headers=admin).json()["users"]:
        if u["username"] == username:
            return u
    return None


# ---------------------------------------------------------------- 가입/로그인
def test_signup_login_logout(http, admin):
    uname = "s_" + secrets.token_hex(5)
    r = http.post("/api/auth/signup", json={"username": uname.upper(), "password": "password123", "name": "가입자"})
    assert r.status_code == 200, r.text
    _created.append(r.json()["user"]["id"])
    assert r.json()["user"] == {"id": r.json()["user"]["id"], "username": uname, "name": "가입자", "isAdmin": False}
    tok = r.json()["token"]
    H = {"Authorization": f"Bearer {tok}"}
    assert http.get("/api/auth/me", headers=H).json()["username"] == uname
    assert http.get("/api/files", headers=H).json() == []
    # 같은 아이디(대소문자 무시) 재가입 불가
    assert http.post("/api/auth/signup", json={"username": uname, "password": "password123", "name": "x"}).status_code == 409
    # 로그인 (대문자로 입력해도)
    r2 = http.post("/api/auth/login", json={"username": uname.upper(), "password": "password123"})
    assert r2.status_code == 200
    # 로그아웃하면 그 토큰만 무효
    assert http.post("/api/auth/logout", headers=H).status_code == 200
    assert http.get("/api/auth/me", headers=H).status_code == 401
    assert http.get("/api/auth/me", headers={"Authorization": f"Bearer {r2.json()['token']}"}).status_code == 200


@pytest.mark.parametrize("body,code", [
    ({"username": "ab", "password": "password123", "name": "x"}, 400),
    ({"username": "Bad Name", "password": "password123", "name": "x"}, 400),
    ({"username": "한글아이디", "password": "password123", "name": "x"}, 400),
    ({"username": "validname1", "password": "short", "name": "x"}, 400),
    ({"username": "validname2", "password": "password123", "name": "   "}, 400),
    ({"username": "validname3", "password": "password123"}, 422),
    ({"username": "admin", "password": "password123", "name": "x"}, 409),
])
def test_signup_validation(http, body, code):
    assert http.post("/api/auth/signup", json=body).status_code == code


def test_login_wrong_and_rate_limit(http, U):
    for _ in range(10):
        r = http.post("/api/auth/login", json={"username": U["_username"], "password": "wrong-password"})
        assert r.status_code == 401
        assert "아이디 또는 비밀번호" in r.json()["detail"]  # 아이디 존재 여부를 흘리지 않음
    # 11번째는 맞는 비밀번호여도 잠시 막힘
    assert http.post("/api/auth/login", json={"username": U["_username"], "password": U["_password"]}).status_code == 429
    # 없는 아이디도 같은 메시지
    r = http.post("/api/auth/login", json={"username": "nobody_" + secrets.token_hex(4), "password": "x"})
    assert r.status_code == 401 and "아이디 또는 비밀번호" in r.json()["detail"]


def test_password_change_logs_out_other_sessions(http, U):
    other_session = http.post("/api/auth/login", json={"username": U["_username"], "password": U["_password"]}).json()["token"]
    assert http.post("/api/auth/password", headers=hdr(U), json={"old": "wrong", "new": "newpassword1"}).status_code == 400
    assert http.post("/api/auth/password", headers=hdr(U), json={"old": U["_password"], "new": "short"}).status_code == 400
    r = http.post("/api/auth/password", headers=hdr(U), json={"old": U["_password"], "new": "newpassword1"})
    assert r.status_code == 200
    assert http.get("/api/auth/me", headers={"Authorization": f"Bearer {other_session}"}).status_code == 401
    assert http.get("/api/auth/me", headers={"Authorization": f"Bearer {r.json()['token']}"}).status_code == 200
    assert http.post("/api/auth/login", json={"username": U["_username"], "password": "newpassword1"}).status_code == 200


def test_change_name(http, H):
    assert http.patch("/api/auth/me", headers=H, json={"name": "<b>새이름</b>"}).json()["name"] == "b새이름/b"
    assert http.patch("/api/auth/me", headers=H, json={"name": "  "}).status_code == 400


# ---------------------------------------------------------------- 관리자
def test_admin_endpoints_forbidden_for_users(http, H):
    assert http.get("/api/admin/users", headers=H).status_code == 403
    assert http.post("/api/admin/users", headers=H, json={"username": "zzzzz", "password": "password123", "name": "x"}).status_code == 403
    assert http.put("/api/admin/settings", headers=H, json={"signup": False}).status_code == 403
    assert http.delete("/api/admin/users/1", headers=H).status_code == 403
    assert http.patch("/api/admin/users/1", headers=H, json={"disabled": True}).status_code == 403


def test_admin_list_shows_usage(http, admin, U):
    f = make(http, hdr(U), "docx")
    row = admin_find(http, admin, U["_username"])
    assert row["files"] == 1 and row["used"] == f["size"] and row["disabled"] is False


def test_admin_disable_enable(http, admin, U):
    assert http.patch(f"/api/admin/users/{U['_id']}", headers=admin, json={"disabled": True}).status_code == 200
    assert http.get("/api/auth/me", headers=hdr(U)).status_code == 401  # 세션 끊김
    r = http.post("/api/auth/login", json={"username": U["_username"], "password": U["_password"]})
    assert r.status_code == 403 and "중지" in r.json()["detail"]
    assert http.patch(f"/api/admin/users/{U['_id']}", headers=admin, json={"disabled": False}).status_code == 200
    assert http.post("/api/auth/login", json={"username": U["_username"], "password": U["_password"]}).status_code == 200


def test_admin_reset_password(http, admin, U):
    assert http.patch(f"/api/admin/users/{U['_id']}", headers=admin, json={"password": "short"}).status_code == 400
    assert http.patch(f"/api/admin/users/{U['_id']}", headers=admin, json={"password": "resetpass99"}).status_code == 200
    assert http.get("/api/auth/me", headers=hdr(U)).status_code == 401
    assert http.post("/api/auth/login", json={"username": U["_username"], "password": "resetpass99"}).status_code == 200


def test_admin_cannot_lock_self_out(http, admin):
    me = http.get("/api/auth/me", headers=admin).json()
    assert http.patch(f"/api/admin/users/{me['id']}", headers=admin, json={"disabled": True}).status_code == 400
    assert http.patch(f"/api/admin/users/{me['id']}", headers=admin, json={"isAdmin": False}).status_code == 400
    assert http.delete(f"/api/admin/users/{me['id']}", headers=admin).status_code == 400


def test_admin_grant_admin(http, admin, U):
    assert http.patch(f"/api/admin/users/{U['_id']}", headers=admin, json={"isAdmin": True}).status_code == 200
    assert http.get("/api/admin/users", headers=hdr(U)).status_code == 200
    assert http.patch(f"/api/admin/users/{U['_id']}", headers=admin, json={"isAdmin": False}).status_code == 200
    assert http.get("/api/admin/users", headers=hdr(U)).status_code == 403


def test_admin_delete_user_removes_everything(http, admin):
    victim = new_user(http, admin)
    friend = new_user(http, admin)
    f = make(http, hdr(victim), "docx")
    tok = http.post(f"/api/files/{f['id']}/share", headers=hdr(victim), json={"mode": "edit"}).json()["token"]
    http.post(f"/api/files/{f['id']}/grants", headers=hdr(victim), json={"username": friend["_username"], "role": "view"})
    assert len(http.get("/api/shared-with-me", headers=hdr(friend)).json()) == 1
    assert http.delete(f"/api/admin/users/{victim['_id']}", headers=admin).status_code == 200
    assert http.get("/api/auth/me", headers=hdr(victim)).status_code == 401
    assert http.get(f"/api/shared/{tok}").status_code == 404
    assert http.get("/api/shared-with-me", headers=hdr(friend)).json() == []
    assert admin_find(http, admin, victim["_username"]) is None


def test_admin_create_user_validation(http, admin):
    assert http.post("/api/admin/users", headers=admin, json={"username": "admin", "password": "password123", "name": "x"}).status_code == 409
    assert http.post("/api/admin/users", headers=admin, json={"username": "X", "password": "password123", "name": "x"}).status_code == 400


def test_signup_toggle(http, admin):
    try:
        assert http.put("/api/admin/settings", headers=admin, json={"signup": False}).status_code == 200
        assert http.get("/api/auth/config").json() == {"signup": False}
        r = http.post("/api/auth/signup", json={"username": "closed_" + secrets.token_hex(3), "password": "password123", "name": "x"})
        assert r.status_code == 403
    finally:
        http.put("/api/admin/settings", headers=admin, json={"signup": True})
    assert http.get("/api/auth/config").json() == {"signup": True}


# ---------------------------------------------------------------- 사용자 지정 공유
def test_grants_edit_and_view(http, admin, U):
    H = hdr(U)
    ed, vw, stranger = new_user(http, admin, "편집자"), new_user(http, admin, "열람자"), new_user(http, admin)
    f = make(http, H, "hwp")
    g = http.post(f"/api/files/{f['id']}/grants", headers=H, json={"username": ed["_username"].upper(), "role": "edit"})
    assert g.status_code == 200 and g.json() == [{"username": ed["_username"], "name": "편집자", "role": "edit"}]
    http.post(f"/api/files/{f['id']}/grants", headers=H, json={"username": vw["_username"], "role": "view"})
    assert len(http.get(f"/api/files/{f['id']}/grants", headers=H).json()) == 2

    # 공유받은 목록
    lst = http.get("/api/shared-with-me", headers=hdr(ed)).json()
    assert [(x["id"], x["role"], x["owner"]) for x in lst] == [(f["id"], "edit", "테스터")]
    assert http.get("/api/files", headers=hdr(ed)).json() == []  # 내 파일에는 안 섞임

    # 편집자: 읽기/저장/이름 OK, 삭제·공유·변환 X
    E = hdr(ed)
    assert http.get(f"/api/files/{f['id']}", headers=E).json()["role"] == "edit"
    assert http.put(f"/api/files/{f['id']}/content", headers=E, content=(FIX / "sample.hwp").read_bytes()).status_code == 200
    assert http.patch(f"/api/files/{f['id']}", headers=E, json={"name": "같이씀"}).status_code == 200
    for m, p, body in [("DELETE", "", None), ("POST", "/share", {"mode": "edit"}), ("GET", "/grants", None),
                       ("POST", "/grants", {"username": stranger["_username"], "role": "edit"}), ("POST", "/convert", {"to": "pdf"})]:
        assert http.request(m, f"/api/files/{f['id']}{p}", headers=E, json=body).status_code == 403, (m, p)

    # 열람자: 읽기만
    V = hdr(vw)
    assert http.get(f"/api/files/{f['id']}/content", headers=V).status_code == 200
    assert http.put(f"/api/files/{f['id']}/content", headers=V, content=b"x").status_code == 403
    assert http.patch(f"/api/files/{f['id']}", headers=V, json={"name": "x"}).status_code == 403

    # 남: 아무것도 못 봄
    assert http.get(f"/api/files/{f['id']}", headers=hdr(stranger)).status_code == 404

    # 권한 변경/해제
    http.post(f"/api/files/{f['id']}/grants", headers=H, json={"username": vw["_username"], "role": "edit"})
    assert http.get(f"/api/files/{f['id']}", headers=V).json()["role"] == "edit"
    http.delete(f"/api/files/{f['id']}/grants/{vw['_username']}", headers=H)
    assert http.get(f"/api/files/{f['id']}", headers=V).status_code == 404
    assert http.get("/api/shared-with-me", headers=V).json() == []

    # 파일을 지우면 공유도 사라짐
    http.delete(f"/api/files/{f['id']}", headers=H)
    assert http.get("/api/shared-with-me", headers=E).json() == []


def test_grant_errors(http, H, U):
    f = make(http, H, "docx")
    assert http.post(f"/api/files/{f['id']}/grants", headers=H, json={"username": "nobody_zz", "role": "edit"}).status_code == 404
    assert http.post(f"/api/files/{f['id']}/grants", headers=H, json={"username": U["_username"], "role": "edit"}).status_code == 400
    assert http.post(f"/api/files/{f['id']}/grants", headers=H, json={"username": "admin", "role": "owner"}).status_code == 400


def test_grant_plus_link_highest_wins(http, admin, U):
    H = hdr(U)
    other = new_user(http, admin)
    f = make(http, H, "docx")
    http.post(f"/api/files/{f['id']}/grants", headers=H, json={"username": other["_username"], "role": "view"})
    tok = http.post(f"/api/files/{f['id']}/share", headers=H, json={"mode": "edit"}).json()["token"]
    assert http.get(f"/api/files/{f['id']}", headers={**hdr(other), "X-Share": tok}).json()["role"] == "edit"
    assert http.get(f"/api/files/{f['id']}", headers=hdr(other)).json()["role"] == "view"


# ---------------------------------------------------------------- PDF 내보내기
@pytest.mark.parametrize("kind", ["docx", "xlsx", "pptx", "hcell", "hshow"])
def test_export_pdf(http, H, kind):
    f = make(http, H, kind)
    r = http.post(f"/api/files/{f['id']}/export", headers=H, json={"to": "pdf"})
    assert r.status_code == 200 and r.content[:5] == b"%PDF-"
    assert "filename*=UTF-8''" in r.headers["content-disposition"]
    assert len(http.get("/api/files", headers=H).json()) == 1  # 사본을 만들지 않음


def test_export_pdf_real_hwp_and_view_share(http, H):
    f = upload(http, H, "보고서.hwp", (FIX / "sample.hwp").read_bytes()).json()
    tok = http.post(f"/api/files/{f['id']}/share", headers=H, json={"mode": "view"}).json()["token"]
    r = http.post(f"/api/files/{f['id']}/export", headers={"X-Share": tok}, json={"to": "pdf"})
    assert r.status_code == 200 and r.content[:5] == b"%PDF-" and len(r.content) > 10000
    assert "%EB%B3%B4%EA%B3%A0%EC%84%9C.pdf" in r.headers["content-disposition"]  # 보고서.pdf


def test_export_invalid(http, H):
    f = make(http, H, "docx")
    assert http.post(f"/api/files/{f['id']}/export", headers=H, json={"to": "exe"}).status_code == 400
