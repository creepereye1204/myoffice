"""계정/세션/파일 권한 저장소 (SQLite, 표준 라이브러리만 사용).

- 비밀번호: scrypt(n=2^14, r=8, p=1) + 사용자별 salt
- 세션: 무작위 토큰을 발급하고 DB에는 sha256 해시만 저장 (DB가 새어도 토큰 재사용 불가)
- 각 사용자는 내부 저장 폴더 id(ws)를 하나 가진다 (예전 익명 작업공간 구조 재사용)
"""
from __future__ import annotations

import hashlib
import hmac
import os
import secrets
import sqlite3
import threading
import time
from pathlib import Path

SESSION_DAYS = 30


def _hash_pw(password: str, salt: bytes) -> bytes:
    return hashlib.scrypt(password.encode(), salt=salt, n=2 ** 14, r=8, p=1, dklen=32)


def _tok_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


class Accounts:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self.db.row_factory = sqlite3.Row
        self.mu = threading.RLock()
        with self.mu:
            self.db.executescript("""
            PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS users (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              username TEXT UNIQUE NOT NULL COLLATE NOCASE,
              name TEXT NOT NULL,
              pw_salt BLOB NOT NULL,
              pw_hash BLOB NOT NULL,
              ws TEXT UNIQUE NOT NULL,
              is_admin INTEGER NOT NULL DEFAULT 0,
              disabled INTEGER NOT NULL DEFAULT 0,
              created INTEGER NOT NULL,
              last_login INTEGER
            );
            CREATE TABLE IF NOT EXISTS sessions (
              token_hash TEXT PRIMARY KEY,
              user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
              expires INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS grants (
              fid TEXT NOT NULL,
              owner_ws TEXT NOT NULL,
              user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
              role TEXT NOT NULL CHECK (role IN ('edit','view')),
              created INTEGER NOT NULL,
              PRIMARY KEY (fid, user_id)
            );
            CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS feedback (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              created_at INTEGER NOT NULL,
              user_id INTEGER,
              kind TEXT NOT NULL CHECK (kind IN ('bug','suggestion','other')),
              message TEXT NOT NULL,
              email TEXT,
              page TEXT NOT NULL,
              file_type TEXT,
              ua TEXT,
              screen TEXT,
              build TEXT,
              session_id TEXT,
              errors_json TEXT NOT NULL,
              status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','read','done'))
            );
            CREATE INDEX IF NOT EXISTS feedback_status_id ON feedback(status, id);
            """)
            self.db.execute("PRAGMA foreign_keys=ON")

    def _q(self, sql: str, args: tuple = ()) -> list:
        """읽기 — 같은 연결을 여러 스레드가 동시에 쓰면 sqlite3가 오류를 내므로 항상 잠금."""
        with self.mu:
            return self.db.execute(sql, args).fetchall()

    def _one(self, sql: str, args: tuple = ()):
        rows = self._q(sql, args)
        return rows[0] if rows else None

    # ------------------------------------------------------------ 의견
    def add_feedback(self, fields: tuple) -> int:
        with self.mu:
            return self.db.execute(
                """INSERT INTO feedback
                   (created_at,user_id,kind,message,email,page,file_type,ua,screen,build,session_id,errors_json)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
                (int(time.time()), *fields)).lastrowid

    def list_feedback(self, status, kind, limit: int, offset: int) -> dict:
        filters, args = [], []
        if status:
            filters.append("status=?")
            args.append(status)
        if kind:
            filters.append("kind=?")
            args.append(kind)
        where = " WHERE " + " AND ".join(filters) if filters else ""
        with self.mu:
            rows = self._q(f"SELECT * FROM feedback{where} ORDER BY id DESC LIMIT ? OFFSET ?", (*args, limit, offset))
            total = self._one(f"SELECT COUNT(*) FROM feedback{where}", tuple(args))[0]
            unread = self._one("SELECT COUNT(*) FROM feedback WHERE status='new'")[0]
        return {"items": [dict(row) for row in rows], "total": total, "unread": unread}

    def update_feedback(self, fid: int, status: str) -> bool:
        with self.mu:
            return self.db.execute("UPDATE feedback SET status=? WHERE id=?", (status, fid)).rowcount > 0

    def delete_feedback(self, fid: int) -> bool:
        with self.mu:
            return self.db.execute("DELETE FROM feedback WHERE id=?", (fid,)).rowcount > 0

    # ------------------------------------------------------------ users
    def create_user(self, username: str, password: str, name: str, is_admin: bool = False) -> dict:
        salt = os.urandom(16)
        ws = secrets.token_urlsafe(32)
        with self.mu:
            cur = self.db.execute(
                "INSERT INTO users(username,name,pw_salt,pw_hash,ws,is_admin,created) VALUES (?,?,?,?,?,?,?)",
                (username, name, salt, _hash_pw(password, salt), ws, int(is_admin), int(time.time())))
        return self.user(cur.lastrowid)

    def user(self, uid: int) -> dict | None:
        r = self._one("SELECT * FROM users WHERE id=?", (uid,))
        return dict(r) if r else None

    def by_username(self, username: str) -> dict | None:
        r = self._one("SELECT * FROM users WHERE username=?", (username,))
        return dict(r) if r else None

    def by_ws(self, ws: str) -> dict | None:
        r = self._one("SELECT * FROM users WHERE ws=?", (ws,))
        return dict(r) if r else None

    def users(self) -> list[dict]:
        return [dict(r) for r in self._q("SELECT * FROM users ORDER BY id")]

    def check_password(self, user: dict, password: str) -> bool:
        return hmac.compare_digest(_hash_pw(password, user["pw_salt"]), user["pw_hash"])

    def set_password(self, uid: int, password: str) -> None:
        salt = os.urandom(16)
        with self.mu:
            self.db.execute("UPDATE users SET pw_salt=?, pw_hash=? WHERE id=?", (salt, _hash_pw(password, salt), uid))
            self.db.execute("DELETE FROM sessions WHERE user_id=?", (uid,))  # 다른 기기 로그아웃

    def update_user(self, uid: int, **fields) -> None:
        allowed = {k: v for k, v in fields.items() if k in ("name", "is_admin", "disabled")}
        if not allowed:
            return
        sets = ", ".join(f"{k}=?" for k in allowed)
        with self.mu:
            self.db.execute(f"UPDATE users SET {sets} WHERE id=?", (*allowed.values(), uid))
            if allowed.get("disabled"):
                self.db.execute("DELETE FROM sessions WHERE user_id=?", (uid,))

    def delete_user(self, uid: int) -> None:
        with self.mu:
            self.db.execute("DELETE FROM sessions WHERE user_id=?", (uid,))
            self.db.execute("DELETE FROM grants WHERE user_id=?", (uid,))
            self.db.execute("DELETE FROM users WHERE id=?", (uid,))

    # ------------------------------------------------------------ sessions
    def new_session(self, uid: int) -> str:
        token = secrets.token_urlsafe(32)
        with self.mu:
            self.db.execute("INSERT INTO sessions VALUES (?,?,?)", (_tok_hash(token), uid, int(time.time()) + SESSION_DAYS * 86400))
            self.db.execute("UPDATE users SET last_login=? WHERE id=?", (int(time.time()), uid))
            self.db.execute("DELETE FROM sessions WHERE expires < ?", (int(time.time()),))
        return token

    def session_user(self, token: str | None) -> dict | None:
        if not token or len(token) > 100:
            return None
        r = self._one(
            "SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires>? AND u.disabled=0",
            (_tok_hash(token), int(time.time())))
        return dict(r) if r else None

    def end_session(self, token: str) -> None:
        with self.mu:
            self.db.execute("DELETE FROM sessions WHERE token_hash=?", (_tok_hash(token),))

    # ------------------------------------------------------------ grants (사용자 지정 공유)
    def grant(self, fid: str, owner_ws: str, uid: int, role: str) -> None:
        with self.mu:
            self.db.execute("INSERT INTO grants VALUES (?,?,?,?,?) ON CONFLICT(fid,user_id) DO UPDATE SET role=excluded.role",
                            (fid, owner_ws, uid, role, int(time.time())))

    def revoke(self, fid: str, uid: int) -> None:
        with self.mu:
            self.db.execute("DELETE FROM grants WHERE fid=? AND user_id=?", (fid, uid))

    def revoke_file(self, fid: str) -> None:
        with self.mu:
            self.db.execute("DELETE FROM grants WHERE fid=?", (fid,))

    def revoke_owner(self, owner_ws: str) -> None:
        with self.mu:
            self.db.execute("DELETE FROM grants WHERE owner_ws=?", (owner_ws,))

    def grant_for(self, fid: str, uid: int) -> dict | None:
        r = self._one("SELECT * FROM grants WHERE fid=? AND user_id=?", (fid, uid))
        return dict(r) if r else None

    def grants_of_file(self, fid: str) -> list[dict]:
        return [dict(r) for r in self._q(
            "SELECT g.role, u.id user_id, u.username, u.name FROM grants g JOIN users u ON u.id=g.user_id WHERE g.fid=? ORDER BY g.created", (fid,))]

    def grants_to_user(self, uid: int) -> list[dict]:
        return [dict(r) for r in self._q(
            "SELECT g.fid, g.owner_ws, g.role, u.name owner_name, u.username owner_username FROM grants g "
            "JOIN users u ON u.ws=g.owner_ws WHERE g.user_id=? ORDER BY g.created DESC", (uid,))]

    # ------------------------------------------------------------ settings
    def setting(self, k: str, default: str) -> str:
        r = self._one("SELECT v FROM settings WHERE k=?", (k,))
        return r["v"] if r else default

    def set_setting(self, k: str, v: str) -> None:
        with self.mu:
            self.db.execute("INSERT INTO settings VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", (k, v))
