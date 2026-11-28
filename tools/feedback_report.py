#!/usr/bin/env python3
"""최근에 접수한 알오피스 의견을 조회한다."""
import argparse
from datetime import datetime, timezone
from pathlib import Path
import sqlite3
import time

DB_PATH = Path(__file__).resolve().parent.parent / "data" / "app.db"
KINDS = {"bug": "버그", "suggestion": "제안", "other": "기타"}
STATUSES = {"new": "새 의견", "read": "읽음", "done": "처리 완료"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--days", type=int, default=7, help="조회할 최근 일수 (기본 7일)")
    parser.add_argument("--status", choices=STATUSES, help="지정한 상태만 조회")
    args = parser.parse_args()
    if args.days < 1:
        parser.error("--days는 1 이상이어야 합니다.")
    query = """SELECT id, created_at, kind, message, email, page, file_type, session_id, status
               FROM feedback WHERE created_at >= ? AND instr(message, 'API_TEST_FEEDBACK') != 1"""
    params = [max(0, int(time.time()) - args.days * 86400)]
    if args.status:
        query += " AND status = ?"
        params.append(args.status)
    try:
        with sqlite3.connect(DB_PATH.as_uri() + "?mode=ro", uri=True) as db:
            db.row_factory = sqlite3.Row
            rows = db.execute(query + " ORDER BY id DESC", params).fetchall()
    except sqlite3.Error as e:
        parser.exit(1, f"의견을 조회할 수 없습니다 ({e})\n")
    print(f"최근 {args.days}일 의견 {len(rows)}건 (UTC)")
    for row in rows:
        created = datetime.fromtimestamp(row["created_at"], timezone.utc).isoformat()
        print(f"\n#{row['id']} {created} · {KINDS[row['kind']]} · {STATUSES[row['status']]}")
        print(f"  페이지 {row['page']} / 파일 형식 {row['file_type'] or '없음'}")
        print(f"  이메일 {row['email'] or '없음'} / 세션 ID {row['session_id'] or '없음'}")
        print(f"  {row['message']}")


if __name__ == "__main__":
    main()
