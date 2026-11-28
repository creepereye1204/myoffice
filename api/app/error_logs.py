"""오류 JSONL을 읽고 같은 오류를 묶는 공통 집계."""
import json
import re
from collections import Counter
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone


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
    session_id: str = ""

    def add(self, ts, record, stack):
        self.count += 1
        self.first = min(self.first, ts)
        self.last = max(self.last, ts)
        for field_name, values in (("page", self.pages), ("fileType", self.file_types), ("build", self.builds)):
            value = record.get(field_name)
            if isinstance(value, str) and value:
                values.add(value)
        request_id = record.get("request_id") or ""
        session_id = record.get("sessionId") or ""
        if (stack and not self.sample_stack) or (stack and request_id and not self.request_id):
            self.sample_stack = stack
            self.request_id = request_id
            self.session_id = session_id
        elif not self.sample_stack and not (self.request_id or self.session_id):
            self.request_id = request_id
            self.session_id = session_id


def summarize(log_dir, days, include_tests=False, *, now=None):
    now = now or datetime.now(timezone.utc)
    cutoff = now - timedelta(days=days)
    groups = {}
    skipped = 0
    daily = Counter()
    recent = Counter()
    for path in sorted(log_dir.glob("*.jsonl")):
        try:
            log_day = date.fromisoformat(path.stem[-10:])
        except ValueError:
            log_day = None
        if log_day and log_day < cutoff.date():
            continue
        try:
            stream = path.open(encoding="utf-8", errors="replace")
        except FileNotFoundError:
            # 로그 보존 기간 정리와 조회가 겹칠 수 있다.
            continue
        source = "server" if path.name.startswith("server-") else "client"
        with stream:
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
                daily[ts.astimezone(timezone.utc).date().isoformat(), source] += 1
                if ts >= now - timedelta(days=1):
                    recent[source] += 1
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
    return groups, skipped, daily, recent
