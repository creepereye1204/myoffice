"""관리자용 집계와 내부 서비스 상태 조회."""
import heapq
import json
import math
import os
import re
import shutil
import time
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path
from threading import Lock

import httpx

from .error_logs import summarize
from .error_reporting import UUID, request_id, scrub

DAY = 86400
SOURCES = ("client", "server")
HTTP_METRIC = "myoffice_http_request_duration_seconds"
HTTP_RATE = f"sum(rate({HTTP_METRIC}_count[1h]))"
PROM_QUERIES = {
    "requestsPerMinute": f"60 * {HTTP_RATE}",
    "p95Seconds": f"histogram_quantile(0.95, sum by (le) (rate({HTTP_METRIC}_bucket[1h])))",
    "errorRate": f'(sum(rate({HTTP_METRIC}_count{{status=~"5.."}}[1h])) or (0 * {HTTP_RATE})) / {HTTP_RATE}',
}


def dates(now, days):
    return [(now.date() - timedelta(days=offset)).isoformat() for offset in range(days - 1, -1, -1)]


def documents_snapshot(accounts, data_dir, app_ext, allowed):
    # 문서와 링크는 디스크에 저장된다. 경로와 메타데이터 원문은 응답에 포함하지 않는다.
    now = datetime.now(timezone.utc)
    cutoff = now.timestamp() - 7 * DAY
    types, daily = Counter(), Counter()
    shares = {"view": 0, "edit": 0}
    stored, created7, modified7 = 0, 0, 0
    largest = []
    for owner in accounts._q("SELECT username, ws FROM users"):
        for path in (data_dir / "ws" / owner["ws"]).glob("*/meta.json"):
            fid = path.parent.name
            if not re.fullmatch(r"[a-f0-9]{32}", fid):
                continue
            try:
                meta = json.loads(path.read_text())
                ext = meta["ext"]
                if ext not in allowed:
                    continue
                size = (path.parent / f"content.{ext}").stat().st_size
                created = int(meta["created"])
                modified = int(meta["modified"])
                day = datetime.fromtimestamp(created, timezone.utc).date().isoformat()
                app = meta.get("app")
                kind = app if app in app_ext and ext in app_ext[app] else ext
                edited = modified > created or meta.get("version", 1) > 1
            except (OSError, ValueError, TypeError, KeyError, AttributeError, OverflowError):
                continue
            stored += size
            types[kind] += 1
            daily[day] += 1
            created7 += created >= cutoff
            modified7 += edited and modified >= cutoff
            share = meta.get("share")
            mode = share.get("mode") if isinstance(share, dict) else None
            if mode in ("view", "edit"):
                shares[mode] += 1
            item = (size, fid, owner["username"], kind, modified)
            if len(largest) < 10:
                heapq.heappush(largest, item)
            else:
                heapq.heappushpop(largest, item)
    return {
        "total": sum(types.values()), "byType": dict(sorted(types.items())), "created7d": created7,
        "modified7d": modified7, "shareLinks": shares, "storedBytes": stored,
        "largest": [
            {"id": fid[:8], "owner": owner, "type": kind, "size": size, "modified": modified}
            for size, fid, owner, kind, modified in sorted(largest, reverse=True)
        ],
    }, daily


def data_size(root):
    total = 0
    for directory, _, files in os.walk(root):
        for file in files:
            path = Path(directory) / file
            try:
                if not path.is_symlink():
                    total += path.stat().st_size
            except FileNotFoundError:
                # 저장 중 임시 파일은 순회 도중 교체될 수 있다.
                continue
    return total


class AdminDashboard:
    def __init__(self, accounts, data_dir, app_ext, allowed, onlyoffice_url, api_version):
        self.accounts = accounts
        self.data_dir = data_dir
        self.app_ext = app_ext
        self.allowed = allowed
        self.onlyoffice_url = onlyoffice_url
        self.api_version = api_version
        self.started = time.monotonic()
        self.cache = {}
        self.locks = {key: Lock() for key in ("documents", "volume", "trend", "errors", "status")}

    def cached(self, key, load):
        # 같은 집계의 동시 요청은 한 번만 계산한다.
        with self.locks[key[0]]:
            cached = self.cache.get(key)
            if cached and time.monotonic() < cached[0]:
                return cached[1]
            result = load()
            self.cache[key] = (time.monotonic() + 30, result)
            return result

    def document_data(self):
        return self.cached(("documents",), lambda: documents_snapshot(
            self.accounts, self.data_dir, self.app_ext, self.allowed))

    def overview(self, live):
        now = datetime.now(timezone.utc)
        today = dates(now, 30)
        docs, created = self.document_data()
        totals = self.accounts._one(
            "SELECT COUNT(*), COUNT(CASE WHEN created >= ? THEN 1 END) FROM users",
            (int(now.timestamp()) - 7 * DAY,))
        signups = dict(self.accounts._q(
            """SELECT date(created, 'unixepoch'), COUNT(*) FROM users
               WHERE created >= ? GROUP BY 1""", (int(now.timestamp()) - 30 * DAY,)))
        unread = self.accounts._one("SELECT COUNT(*) FROM feedback WHERE status='new'")[0]
        _, _, daily, recent = self.cached(
            ("trend",), lambda: summarize(self.data_dir / "logs", 14, now=now))
        return {
            "users": {"total": totals[0], "joined7d": totals[1]},
            "documents": {"total": docs["total"], "byType": docs["byType"]},
            # 데이터 디렉터리 용량에는 문서 본문이 이미 포함된다.
            "storage": {"storedBytes": docs["storedBytes"],
                        "dataBytes": self.cached(("volume",), lambda: data_size(self.data_dir))},
            "live": live, "errors24h": {source: recent[source] for source in SOURCES},
            "unreadFeedback": unread,
            "activityDaily": [{"date": day, "signups": signups.get(day, 0),
                               "documents": created[day]} for day in today],
            "errorsDaily": [{"date": day, **{source: daily[day, source] for source in SOURCES}}
                            for day in dates(now, 14)],
        }

    def errors(self, days, tests):
        def load():
            groups, skipped, _, _ = summarize(self.data_dir / "logs", days, tests)
            return {
                "days": days, "tests": tests, "skipped": skipped,
                "groups": [
                    {"kind": scrub(kind, 60), "message": scrub(message, 500), "count": group.count,
                     "first": group.first.isoformat(), "last": group.last.isoformat(),
                     "pages": sorted({scrub(page, 40) for page in group.pages}),
                     "fileTypes": sorted({scrub(kind, 40) for kind in group.file_types}),
                     "sampleStack": scrub(group.sample_stack, 8000),
                     "request_id": group.request_id if isinstance(group.request_id, str)
                     and request_id(group.request_id) == group.request_id else "",
                     "sessionId": group.session_id if isinstance(group.session_id, str)
                     and re.fullmatch(UUID, group.session_id, re.I) else ""}
                    for (kind, message, _), group in sorted(groups.items(), key=lambda item: (-item[1].count, item[0]))
                ],
            }
        return self.cached(("errors", days, tests), load)

    def status(self):
        return self.cached(("status",), self.service_status)

    def service_status(self):
        metrics = dict.fromkeys(PROM_QUERIES)
        available = False
        with httpx.Client(timeout=1.0, trust_env=False) as client:
            try:
                response = client.get(self.onlyoffice_url + "healthcheck")
                onlyoffice = response.is_success and response.json() is True
            except (httpx.HTTPError, ValueError):
                onlyoffice = False
            query_time = time.time()
            for key, query in PROM_QUERIES.items():
                try:
                    response = client.get("http://prometheus:9090/api/v1/query",
                                          params={"query": query, "time": query_time, "timeout": "1s"})
                    response.raise_for_status()
                    result = response.json()
                    if result["status"] == "success":
                        values = result["data"]["result"]
                        if values:
                            value = float(values[0]["value"][1])
                            metrics[key] = value if math.isfinite(value) else None
                        available = True
                except (httpx.HTTPError, ValueError, KeyError, TypeError, IndexError):
                    continue
        disk = shutil.disk_usage(self.data_dir)
        return {
            "api": {"ok": True, "uptimeSeconds": int(time.monotonic() - self.started),
                    "version": self.api_version, "build": os.getenv("APP_BUILD") or None},
            "onlyoffice": {"ok": onlyoffice},
            "disk": {"freeBytes": disk.free, "totalBytes": disk.total},
            "prometheus": {"available": available, "windowSeconds": 3600, **metrics},
        }
