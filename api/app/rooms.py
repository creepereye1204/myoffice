"""파일별 실시간 방 — 접속자 목록, HWP 편집 잠금, 저장 알림.

uvicorn 단일 프로세스 기준 메모리 상태(재시작 시 비워지고 클라이언트가 자동 재접속한다).
잠금 규칙: 편집 권한이 있는 사람 중 먼저 들어온 사람이 잠금을 가진다. 그 사람이 나가거나
양보(release)하면 다음 편집 가능 접속자에게 넘어간다.
잠금을 가진 사람의 연결이 (와이파이 끊김 등으로) 갑자기 끊기면 LOCK_GRACE 초 동안 잠금을 붙잡아 두고,
그 안에 다시 연결되면 그대로 이어서 편집한다. 창을 닫아 정상적으로 나가면(bye) 바로 넘어간다.
"""
from __future__ import annotations

import asyncio
from dataclasses import dataclass, field

from fastapi import WebSocket

LOCK_GRACE = 10.0

COLORS = ["#2563eb", "#16a34a", "#dc2626", "#9333ea", "#ea580c", "#0891b2", "#db2777", "#65a30d"]


@dataclass
class Member:
    uid: str
    name: str
    editor: bool
    color: str
    socks: list = field(default_factory=list)


@dataclass
class Room:
    members: dict = field(default_factory=dict)  # uid -> Member (입장 순서 유지)
    lock: str | None = None
    requests: set = field(default_factory=set)


class Rooms:
    def __init__(self) -> None:
        self.rooms: dict[str, Room] = {}
        self.mu = asyncio.Lock()

    # ------------------------------------------------------------ 조회
    def active_counts(self) -> dict[str, int]:
        users = set()
        count = 0
        for room in self.rooms.values():
            connected = {member.uid for member in room.members.values() if member.socks}
            count += bool(connected)
            users.update(connected)
        return {"rooms": count, "users": len(users)}

    def lock_holder(self, fid: str) -> str | None:
        r = self.rooms.get(fid)
        return r.lock if r else None

    def name_of(self, fid: str, uid: str | None) -> str:
        r = self.rooms.get(fid)
        m = r.members.get(uid) if r and uid else None
        return m.name if m else "누군가"

    # ------------------------------------------------------------ 변경
    async def join(self, fid: str, uid: str, name: str, sock: WebSocket, editor: bool) -> None:
        async with self.mu:
            r = self.rooms.setdefault(fid, Room())
            m = r.members.get(uid)
            if m:
                m.socks.append(sock)
                m.name = name
            else:
                used = {x.color for x in r.members.values()}
                color = next((c for c in COLORS if c not in used), COLORS[len(r.members) % len(COLORS)])
                r.members[uid] = Member(uid, name, editor, color, [sock])
            if r.lock is None and editor:
                r.lock = uid
        await self.presence(fid)

    async def leave(self, fid: str, uid: str, sock: WebSocket, grace: float | None = None) -> None:
        grace = LOCK_GRACE if grace is None else grace
        async with self.mu:
            r = self.rooms.get(fid)
            if not r or uid not in r.members:
                return
            m = r.members[uid]
            if sock in m.socks:
                m.socks.remove(sock)
            departed = not m.socks
            keep_lock = departed and r.lock == uid and grace > 0
            if keep_lock:
                # 연결이 끊긴 편집자: 잠시 잠금 유지 → 다시 들어오면 그대로, 아니면 넘김
                asyncio.create_task(self._expire(fid, uid, grace))
            elif departed:
                self._remove(fid, r, uid)
        if departed:
            await self.broadcast(fid, {"type": "cursor", "uid": uid, "x": None}, exclude=uid)
        if not keep_lock:
            await self.presence(fid)

    async def _expire(self, fid: str, uid: str, grace: float) -> None:
        await asyncio.sleep(grace)
        async with self.mu:
            r = self.rooms.get(fid)
            m = r.members.get(uid) if r else None
            if not m or m.socks:
                return  # 이미 나갔거나 다시 연결됨
            self._remove(fid, r, uid)
            if fid not in self.rooms:
                return
        await self.presence(fid)

    def _remove(self, fid: str, r: Room, uid: str) -> None:
        del r.members[uid]
        r.requests.discard(uid)
        if r.lock == uid:
            r.lock = self._next(r)
        if not r.members:
            del self.rooms[fid]

    async def release(self, fid: str, uid: str) -> None:
        async with self.mu:
            r = self.rooms.get(fid)
            if not r or r.lock != uid:
                return
            r.lock = self._next(r, skip=uid)
        await self.presence(fid)

    async def request_lock(self, fid: str, uid: str) -> None:
        async with self.mu:
            r = self.rooms.get(fid)
            if not r or uid not in r.members or not r.members[uid].editor:
                return
            if r.lock is None:
                r.lock = uid
            else:
                r.requests.add(uid)
        await self.presence(fid)

    async def rename_user(self, fid: str, uid: str, name: str) -> None:
        r = self.rooms.get(fid)
        if r and uid in r.members:
            r.members[uid].name = name
            await self.presence(fid)

    def _next(self, r: Room, skip: str | None = None) -> str | None:
        # 요청한 사람 우선, 없으면 입장 순서
        for uid in list(r.requests):
            if uid != skip and uid in r.members and r.members[uid].editor:
                r.requests.discard(uid)
                return uid
        for uid, m in r.members.items():
            if uid != skip and m.editor:
                return uid
        return None

    # ------------------------------------------------------------ 전송
    async def presence(self, fid: str) -> None:
        r = self.rooms.get(fid)
        if not r:
            return
        users = [{"uid": m.uid, "name": m.name, "color": m.color, "editor": m.editor}
                 for m in r.members.values()]
        await self.broadcast(fid, {"type": "presence", "users": users, "lock": r.lock,
                                   "requests": sorted(r.requests)})

    async def cursor(self, fid: str, uid: str, msg: dict) -> bool:
        # 포인터는 검증한 좌표만 전달하고 방 상태에는 남기지 않는다.
        x = msg.get("x")
        if x is None:
            if msg.keys() != {"type", "x"}:
                return False
            payload = {"x": None}
        else:
            y, space = msg.get("y"), msg.get("space")
            if space not in ("hwp", "word", "viewport"):
                return False
            keys = {"type", "x", "y", "space"}
            if space == "word":
                keys.update(("page", "vx", "vy"))
            elif space == "hwp" and "page" in msg:
                keys.add("page")
            if msg.keys() != keys:
                return False
            lo, hi = (0, 1) if space == "viewport" else (-1_000_000, 10_000_000)
            if not all(type(v) in (int, float) and lo <= v <= hi for v in (x, y)):
                return False
            payload = {"x": x, "y": y, "space": space}
            if "page" in keys:
                page = msg["page"]
                if type(page) is not int or not 0 <= page < 100_000:
                    return False
                payload["page"] = page
            if space == "word":
                vx, vy = msg["vx"], msg["vy"]
                if not all(type(v) in (int, float) and 0 <= v <= 1 for v in (vx, vy)):
                    return False
                payload.update(vx=vx, vy=vy)
        await self.broadcast(fid, {"type": "cursor", "uid": uid, **payload}, exclude=uid)
        return True

    async def broadcast(self, fid: str, msg: dict, exclude: str | None = None) -> None:
        r = self.rooms.get(fid)
        if not r:
            return
        for uid, m in list(r.members.items()):
            if uid == exclude:
                continue
            for s in list(m.socks):
                try:
                    await s.send_json(msg)
                except Exception:
                    pass
