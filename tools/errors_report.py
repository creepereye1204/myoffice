#!/usr/bin/env python3
"""최근 오류 JSONL을 읽고 같은 오류를 묶어 요약한다."""
import argparse
import json
import re
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

LOG_DIR = Path(__file__).resolve().parent.parent / "data" / "logs"


def normalize(message):
    message = re.sub(r"\b\d{4}-\d{2}-\d{2}(?:T[\d:.]+(?:Z|[+-]\d\d:\d\d)?)?\b", "<시각>", message)
    message = re.sub(r"\b\d{10,}\b", "<숫자>", message)
    return " ".join(message.split())


@dataclass
class Group:
    first: datetime
    last: datetime
    count: int = 0
    pages: set = field(default_factory=set)
    file_types: set = field(default_factory=set)
    builds: set = field(default_factory=set)
    sample_stack: str = ""
    request_id: str = ""

    def add(self, ts, record, stack):
        self.count += 1
        self.first = min(self.first, ts)
        self.last = max(self.last, ts)
        for field_name, values in (("page", self.pages), ("fileType", self.file_types), ("build", self.builds)):
            value = record.get(field_name)
            if isinstance(value, str) and value:
                values.add(value)
        request_id = record.get("request_id") or ""
        if (stack and not self.sample_stack) or (stack and request_id and not self.request_id):
            self.sample_stack = stack
            self.request_id = request_id
        elif not self.sample_stack and not self.request_id:
            self.request_id = request_id


def summarize(log_dir, days, include_tests=False):
    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(days=days)
    groups = {}
    skipped = 0
    for path in sorted(log_dir.glob("*.jsonl")):
        try:
            log_day = date.fromisoformat(path.stem[-10:])
        except ValueError:
            log_day = None
        if log_day and log_day < cutoff.date():
            continue
        with path.open(encoding="utf-8", errors="replace") as stream:
            for line in stream:
                try:
                    record = json.loads(line)
                    if not isinstance(record, dict):
                        raise ValueError("레코드 형식 오류")
                    # Python 3.10 이하의 fromisoformat 은 끝의 Z 를 못 읽는다
                    ts = datetime.fromisoformat(str(record["ts"]).replace("Z", "+00:00"))
                    if ts.tzinfo is None:
                        ts = ts.replace(tzinfo=timezone.utc)
                    kind = record["kind"]
                    if not isinstance(kind, str):
                        raise ValueError("오류 종류 형식 오류")
                    message = normalize(record["message"])
                    stack = record.get("traceback") or record.get("stack") or ""
                    frames = [line.strip() for line in stack.splitlines() if line.strip()]
                except (AttributeError, KeyError, TypeError, ValueError):
                    skipped += 1
                    continue
                if not cutoff <= ts <= now:
                    continue
                # 자동 테스트(API_TEST_ERROR, E2E_TEST_ERROR)가 남긴 기록은 기본으로 뺀다
                if not include_tests and "_TEST_ERROR" in message:
                    continue
                if frames:
                    top = frames[-1] if record.get("traceback") else frames[0]
                elif record.get("filename"):
                    top = f"{record['filename']}:{record.get('line', '')}:{record.get('col', '')}"
                else:
                    top = ""
                key = kind, message, top
                if key not in groups:
                    groups[key] = Group(ts, ts)
                groups[key].add(ts, record, stack)
    return groups, skipped


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--days", type=int, default=7, help="조회할 최근 일수 (기본 7일)")
    parser.add_argument("--log-dir", type=Path, default=LOG_DIR, help="JSONL 파일이 있는 디렉터리")
    parser.add_argument("--include-tests", action="store_true", help="자동 테스트가 남긴 기록도 포함")
    args = parser.parse_args()
    if args.days < 1:
        parser.error("--days는 1 이상이어야 합니다.")
    groups, skipped = summarize(args.log_dir, args.days, args.include_tests)
    total = sum(group.count for group in groups.values())
    print(f"최근 {args.days}일 오류 {total}건, {len(groups)}개 그룹 (UTC)")
    if skipped:
        print(f"형식 오류로 건너뛴 줄 {skipped}건")
    for (kind, message, top), group in sorted(groups.items(), key=lambda item: (-item[1].count, item[0])):
        print(f"\n[{kind}] {group.count}건 · {message}")
        print(f"  첫 발생 {group.first.astimezone(timezone.utc).isoformat()} / 마지막 {group.last.astimezone(timezone.utc).isoformat()}")
        print(f"  페이지 {', '.join(sorted(group.pages)) or '없음'} / 파일 형식 {', '.join(sorted(group.file_types)) or '없음'}")
        print(f"  빌드 {', '.join(sorted(group.builds)) or '없음'}")
        print(f"  첫 오류 프레임 {top or '없음'} / 요청 ID {group.request_id or '없음'}")
        if group.sample_stack:
            print("  예시 스택")
            print("\n".join(f"    {frame}" for frame in group.sample_stack.splitlines()))


if __name__ == "__main__":
    main()
