"""공유 권한 + 실시간(WebSocket) 접속자/HWP 잠금/저장 알림."""
import asyncio
import json
from urllib.parse import urlencode

import pytest
import websockets

from conftest import API, FIX, WEB, make, new_user, hdr

WS_URL = API.replace("http", "ws", 1)


# ---------------------------------------------------------------- 공유 권한
def share(http, H, fid, mode="edit"):
    r = http.post(f"/api/files/{fid}/share", headers=H, json={"mode": mode})
    assert r.status_code == 200, r.text
    return r.json()["token"]


def test_share_edit_permissions(http, H):
    f = make(http, H, "docx")
    tok = share(http, H, f["id"])
    S = {"X-Share": tok}
    info = http.get(f"/api/shared/{tok}").json()
    assert info["id"] == f["id"] and info["role"] == "edit"
    assert http.get(f"/api/files/{f['id']}", headers=S).json()["role"] == "edit"
    assert http.get(f"/api/files/{f['id']}/content", headers=S).status_code == 200
    assert http.get(f"/api/files/{f['id']}/onlyoffice", headers=S).json()["config"]["editorConfig"]["mode"] == "edit"
    assert http.patch(f"/api/files/{f['id']}", headers=S, json={"name": "공유편집"}).status_code == 200
    # 소유자 전용 작업은 금지
    assert http.delete(f"/api/files/{f['id']}", headers=S).status_code == 403
    assert http.post(f"/api/files/{f['id']}/share", headers=S, json={"mode": "edit"}).status_code == 403
    assert http.delete(f"/api/files/{f['id']}/share", headers=S).status_code == 403
    assert http.post(f"/api/files/{f['id']}/convert", headers=S, json={"to": "pdf"}).status_code == 403
    # 공유 토큰으로 작업공간 목록/다른 파일 접근 불가
    assert http.get("/api/files", headers=S).status_code == 401
    other = make(http, H, "docx")
    assert http.get(f"/api/files/{other['id']}", headers=S).status_code == 403
    # 소유자에게만 share 정보 노출
    assert "share" not in http.get(f"/api/files/{f['id']}", headers=S).json()
    assert http.get(f"/api/files/{f['id']}", headers=H).json()["share"]["token"] == tok


def test_share_view_permissions(http, H):
    f = make(http, H, "hwp")
    d = make(http, H, "docx")
    tok, tok2 = share(http, H, f["id"], "view"), share(http, H, d["id"], "view")
    S = {"X-Share": tok}
    assert http.get(f"/api/files/{f['id']}", headers=S).json()["role"] == "view"
    assert http.get(f"/api/files/{f['id']}/content", headers=S).status_code == 200
    assert http.put(f"/api/files/{f['id']}/content", headers=S, content=b"x").status_code == 403
    assert http.patch(f"/api/files/{f['id']}", headers=S, json={"name": "x"}).status_code == 403
    c = http.get(f"/api/files/{d['id']}/onlyoffice", headers={"X-Share": tok2}).json()["config"]
    assert c["editorConfig"]["mode"] == "view" and c["document"]["permissions"]["edit"] is False


def test_share_mode_change_keeps_token_and_revoke(http, H):
    f = make(http, H, "docx")
    t1 = share(http, H, f["id"], "edit")
    t2 = share(http, H, f["id"], "view")
    assert t1 == t2
    assert http.get(f"/api/files/{f['id']}", headers={"X-Share": t1}).json()["role"] == "view"
    assert http.get("/api/files", headers=H).json()[0]["shared"] is True
    assert http.delete(f"/api/files/{f['id']}/share", headers=H).status_code == 200
    assert http.get(f"/api/shared/{t1}").status_code == 404
    assert http.get(f"/api/files/{f['id']}", headers={"X-Share": t1}).status_code == 403
    # 다시 공유하면 새 토큰 (옛 링크는 계속 죽어 있음)
    t3 = share(http, H, f["id"])
    assert t3 != t1 and http.get(f"/api/shared/{t1}").status_code == 404


def test_share_dies_with_file(http, H):
    f = make(http, H, "docx")
    t = share(http, H, f["id"])
    http.delete(f"/api/files/{f['id']}", headers=H)
    assert http.get(f"/api/shared/{t}").status_code == 404


@pytest.mark.parametrize("tok", ["x", "a" * 30, "../../ws", ""])
def test_bad_share_tokens(http, H, tok):
    f = make(http, H, "docx")
    assert http.get(f"/api/files/{f['id']}", headers={"X-Share": tok}).status_code in (401, 403)


# ---------------------------------------------------------------- WebSocket
class Client:
    def __init__(self, fid, uid, name, t=None, s=None, origin=WEB):
        q = {"uid": uid, "name": name}
        if t: q["t"] = t
        if s: q["s"] = s
        self.url = f"{WS_URL}/ws/files/{fid}?{urlencode(q)}"
        self.origin = origin
        self.uid = uid

    async def __aenter__(self):
        self.ws = await websockets.connect(self.url, origin=self.origin, open_timeout=15)
        return self

    async def __aexit__(self, *a):
        await self.ws.close()

    async def send(self, m):
        await self.ws.send(json.dumps(m))

    async def wait(self, pred, timeout=10):
        async def loop():
            while True:
                m = json.loads(await self.ws.recv())
                if pred(m):
                    return m
        return await asyncio.wait_for(loop(), timeout)

    async def presence(self, pred=lambda m: True, timeout=10):
        return await self.wait(lambda m: m["type"] == "presence" and pred(m), timeout)


def run(coro):
    return asyncio.run(coro)


def test_ws_rejects_bad_auth_and_origin(http, U, admin):
    H = hdr(U)
    f = make(http, H, "hwp")
    other = new_user(http, admin)

    async def go():
        for kw in [dict(t="bad"), dict(), dict(s="nope-nope-nope-nope-nope"), dict(t=other["_token"]), dict(t=U["_token"], origin="https://evil.example")]:
            with pytest.raises(Exception):
                async with Client(f["id"], "u1aaaa", "a", **kw) as c:
                    await c.wait(lambda m: True, timeout=3)
    run(go())


def test_ws_presence_lock_flow(http, U):
    H = hdr(U)
    me = f"u{U['_id']}"  # 계정 사용자는 서버가 u<계정id> 로 고정
    f = make(http, H, "hwp")
    tok = share(http, H, f["id"], "edit")
    put = lambda client, base: http.put(f"/api/files/{f['id']}/content", content=(FIX / "sample.hwp").read_bytes(),
                                        headers={**H, "X-Client": client, "X-Base-Version": str(base)})

    async def go():
        async with Client(f["id"], "ignored", "무시됨", t=U["_token"]) as A:
            m = await A.presence()
            assert m["lock"] == me and [u["name"] for u in m["users"]] == ["테스터"]  # 이름도 계정 이름
            async with Client(f["id"], "guest1", "손님", s=tok) as B:
                m = await B.presence(lambda m: len(m["users"]) == 2)
                assert m["lock"] == me
                assert len({u["color"] for u in m["users"]}) == 2
                await A.presence(lambda m: len(m["users"]) == 2)
                # 잠금 없는 사람은 저장 불가
                assert put("guest1", 1).status_code == 409
                # 잠금 가진 사람이 저장 → B에게 saved 알림
                assert put(me, 1).status_code == 200
                s = await B.wait(lambda m: m["type"] == "saved")
                assert s["version"] == 2 and s["by"] == "테스터"
                # B가 편집 요청 → 요청 목록에 표시
                await B.send({"type": "request"})
                m = await A.presence(lambda m: m["requests"] == ["guest1"])
                # A가 넘김 → B가 잠금
                await A.send({"type": "release"})
                m = await B.presence(lambda m: m["lock"] == "guest1")
                assert m["requests"] == []
                assert put(me, 2).status_code == 409
                assert http.put(f"/api/files/{f['id']}/content", content=(FIX / "sample.hwp").read_bytes(),
                                headers={"X-Share": tok, "X-Client": "guest1", "X-Base-Version": "2"}).status_code == 200
                # 이름 바꾸기 반영 (손님만 — 계정 사용자는 계정 이름 고정)
                await B.send({"type": "name", "name": "새손님"})
                m = await A.presence(lambda m: any(u["name"] == "새손님" for u in m["users"]))
                await B.send({"type": "bye"})  # 창 닫기
            # B가 나가면 잠금이 남은 A에게
            m = await A.presence(lambda m: len(m["users"]) == 1)
            assert m["lock"] == me
    run(go())


def test_ws_view_share_never_gets_lock(http, U):
    H = hdr(U)
    f = make(http, H, "hwp")
    tok = share(http, H, f["id"], "view")

    async def go():
        async with Client(f["id"], "viewer1", "보기", s=tok) as V:
            m = await V.presence()
            assert m["lock"] is None and m["users"][0]["editor"] is False
            await V.send({"type": "request"})
            async with Client(f["id"], "x", "소유자", t=U["_token"]) as A:
                m = await A.presence(lambda m: len(m["users"]) == 2)
                assert m["lock"] == f"u{U['_id']}" and m["requests"] == []
    run(go())


def test_ws_same_account_two_tabs(http, U, admin):
    """같은 계정이 탭 두 개(또는 두 기기)로 들어오면 한 사람으로 보이고, 잠금도 유지."""
    H = hdr(U)
    f = make(http, H, "hwp")
    tok = share(http, H, f["id"], "edit")
    me = f"u{U['_id']}"

    async def go():
        async with Client(f["id"], "a", "x", t=U["_token"]) as A1:
            await A1.presence()
            async with Client(f["id"], "b", "y", t=U["_token"]) as A2:
                m = await A2.presence()
                assert len(m["users"]) == 1 and m["lock"] == me
            async with Client(f["id"], "other1", "남", s=tok) as O:
                m = await O.presence(lambda m: len(m["users"]) == 2)
                assert m["lock"] == me
    run(go())


def test_ws_granted_user_joins(http, U, admin):
    """사용자 지정 공유(편집)로 받은 사람도 실시간 방에 들어오고, 잠금을 이어받을 수 있다."""
    H = hdr(U)
    other = new_user(http, admin, name="동료")
    f = make(http, H, "hwp")
    assert http.post(f"/api/files/{f['id']}/grants", headers=H, json={"username": other["_username"], "role": "edit"}).status_code == 200

    async def go():
        async with Client(f["id"], "x", "x", t=U["_token"]) as A:
            await A.presence()
            async with Client(f["id"], "y", "y", t=other["_token"]) as B:
                m = await B.presence(lambda m: len(m["users"]) == 2)
                assert {u["name"] for u in m["users"]} == {"테스터", "동료"}
                await A.send({"type": "release"})
                await B.presence(lambda m: m["lock"] == f"u{other['_id']}")
    run(go())


def test_ws_rename_broadcast(http, U):
    H = hdr(U)
    f = make(http, H, "docx")

    async def go():
        async with Client(f["id"], "renam1", "a", t=U["_token"]) as A:
            await A.presence()
            http.patch(f"/api/files/{f['id']}", headers=H, json={"name": "바뀐이름"})
            m = await A.wait(lambda m: m["type"] == "renamed")
            assert m["name"] == "바뀐이름.docx"
    run(go())


def test_ws_ping(http, U):
    H = hdr(U)
    f = make(http, H, "docx")

    async def go():
        async with Client(f["id"], "pinger", "p", t=U["_token"]) as A:
            await A.send({"type": "ping"})
            await A.wait(lambda m: m["type"] == "pong")
            await A.ws.send("not json")  # 잘못된 메시지 → 서버가 죽지 않아야
        async with Client(f["id"], "pinger", "p", t=U["_token"]) as A:
            await A.presence()
    run(go())


def test_ws_lock_survives_brief_disconnect(http, U):
    """편집자의 연결이 잠깐 끊겨도(와이파이 등) 잠금을 바로 뺏기지 않고, 다시 들어오면 그대로 편집."""
    H = hdr(U)
    me = f"u{U['_id']}"
    f = make(http, H, "hwp")
    tok = share(http, H, f["id"], "edit")

    async def go():
        async with Client(f["id"], "guest1", "손님", s=tok) as B:
            m = await B.presence()
            assert m["lock"] == "guest1"  # 먼저 들어온 B 가 잠금
        # B 가 갑자기 끊김(bye 없이) → 그 사이 A 가 들어와도 잠금은 B 에게 남음
        async with Client(f["id"], "x", "주인", t=U["_token"]) as A:
            m = await A.presence()
            assert m["lock"] == "guest1"
            async with Client(f["id"], "guest1", "손님", s=tok) as B2:  # 10초 안에 재접속
                m = await A.presence(lambda m: len(m["users"]) == 2)
                assert m["lock"] == "guest1"
                await B2.send({"type": "bye"})  # 창 닫기 → 바로 넘김
                m = await A.presence(lambda m: m["lock"] == me, timeout=5)
    run(go())


def test_ws_lock_moves_after_grace(http, U):
    """끊긴 편집자가 돌아오지 않으면 잠시 뒤 다음 사람에게 잠금이 넘어간다."""
    H = hdr(U)
    me = f"u{U['_id']}"
    f = make(http, H, "hwp")
    tok = share(http, H, f["id"], "edit")

    async def go():
        async with Client(f["id"], "x", "주인", t=U["_token"]) as A:
            await A.presence(lambda m: m["lock"] == me)
            async with Client(f["id"], "guest1", "손님", s=tok) as B:
                await B.presence(lambda m: len(m["users"]) == 2)
                await A.ws.close()  # 갑작스러운 끊김
                await asyncio.sleep(3)
                assert http.put(f"/api/files/{f['id']}/content", content=(FIX / "sample.hwp").read_bytes(),
                                headers={"X-Share": tok, "X-Client": "guest1"}).status_code == 409  # 아직 주인 잠금
                m = await B.presence(lambda m: m["lock"] == "guest1", timeout=15)
                assert [u["uid"] for u in m["users"]] == ["guest1"]
    run(go())


def test_ws_cursor_broadcast_validation_and_rate(http, U):
    f = make(http, hdr(U), "hwp")
    tok = share(http, hdr(U), f["id"], "view")
    uid = f"u{U['_id']}"
    move = {"type": "cursor", "space": "hwp", "x": 120.5, "y": 300}

    async def go():
        async with Client(f["id"], "owner", "소유자", t=U["_token"]) as a, \
                   Client(f["id"], "viewer", "보기", s=tok) as b:
            await a.presence(lambda m: len(m["users"]) == 2)
            await b.presence()
            await a.send(move)
            assert await b.wait(lambda m: m["type"] == "cursor") == {**move, "uid": uid}
            await a.send({"type": "ping"})
            assert json.loads(await asyncio.wait_for(a.ws.recv(), 10)) == {"type": "pong"}

            drag = {**move, "page": 1, "d": [30.25, 42], "dp": 0}
            selection = {**move, "page": 1, "sel": [[120.5, 300 + i * 12, 42.75, 12] for i in range(20)]}
            hwp_ts = {"space": "hwp", "rects": [[i // 20, 120.5, 40 + i, 42.75, 12] for i in range(40)]}
            cell_ts = {"space": "cell", "sheet": 2, "ranges": [[0, 0, 1_048_575, 16_383]] * 20}
            clear = {"type": "cursor", "ts": None}
            for update in (drag, selection, {**move, "ts": hwp_ts},
                           {"type": "cursor", "ts": cell_ts}, clear):
                await asyncio.sleep(0.06)
                if update.get("ts"):
                    await a.send({**update, "uid": "다른 사용자", "ts": {**update["ts"], "extra": True}})
                else:
                    await a.send(update)
                assert await b.wait(lambda m: m["type"] == "cursor") == {**update, "uid": uid}

            # 제한 간격을 넘긴 뒤에도 잘못된 좌표와 임의 필드는 전달되지 않는다.
            await asyncio.sleep(0.06)
            for invalid in ({**move, "x": True}, {**move, "y": "3"}, {**move, "x": 10**20},
                            {**move, "space": "viewport"}, {**move, "uid": "다른 사용자"},
                            {**move, "d": [0, False]}, {**move, "d": [1, 2, 3]},
                            {**move, "x": 0.5, "y": 0.5, "space": "viewport", "d": [0, 1.1]},
                            {**move, "dp": 0}, {**drag, "dp": 100_000},
                            {**selection, "sel": [[0, 0, 1, 1]] * 21},
                            {**move, "sel": [[0, 0, 1, -1]]}, {**move, "sel": [[0, 0, 1]]},
                            {**move, "sel": [[0, 0, 10**20, 1]]},
                            {"type": "cursor", "x": None, "extra": "x" * 300}):
                await a.send(invalid)
            for invalid in ([], {}, {"space": "viewport", "rects": [[0, 0, 0, 1, 1]]},
                            {**hwp_ts, "rects": hwp_ts["rects"] + [[0, 0, 0, 1, 1]]},
                            {**hwp_ts, "rects": [[True, 0, 0, 1, 1]]},
                            {**hwp_ts, "rects": [[0, 0, 0, 1, 0]]},
                            {**hwp_ts, "rects": [[100_000, 0, 0, 1, 1]]},
                            {**hwp_ts, "rects": [[0, 0, "0", 1, 1]]},
                            {**cell_ts, "ranges": cell_ts["ranges"] + [[0, 0, 0, 0]]},
                            {**cell_ts, "ranges": [[1, 0, 0, 1]]},
                            {**cell_ts, "ranges": [[0, 0, 1, 16384]]},
                            {**cell_ts, "sheet": False}):
                await a.send({"type": "cursor", "ts": invalid})
            await a.send({"type": "ping"})
            await a.wait(lambda m: m["type"] == "pong")
            await b.send({"type": "ping"})
            assert json.loads(await asyncio.wait_for(b.ws.recv(), 10)) == {"type": "pong"}

            for i in range(80):
                await a.send({**drag, "x": i} if i % 2 else {"type": "cursor", "ts": hwp_ts})
            await a.send({"type": "ping"})
            await a.wait(lambda m: m["type"] == "pong")
            await b.send({"type": "ping"})
            received = 0
            while True:
                msg = json.loads(await asyncio.wait_for(b.ws.recv(), 10))
                if msg["type"] == "pong":
                    break
                assert msg["type"] == "cursor" and msg["uid"] == uid
                received += 1
            assert 0 < received < 80

            await asyncio.sleep(0.06)
            await a.send({"type": "cursor", "x": None})
            assert await b.wait(lambda m: m["type"] == "cursor") == {"type": "cursor", "uid": uid, "x": None}

            await b.send(move)
            assert await a.wait(lambda m: m["type"] == "cursor") == {**move, "uid": "viewer"}
            await b.send({"type": "bye"})
            assert await a.wait(lambda m: m["type"] == "cursor") == {
                "type": "cursor", "uid": "viewer", "x": None, "ts": None,
            }

    run(go())
