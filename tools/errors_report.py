#!/usr/bin/env python3
"""최근 오류 JSONL을 읽고 같은 오류를 묶어 요약한다."""
import argparse
import sys
from datetime import timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "api"))
from app.error_logs import summarize  # noqa: E402

LOG_DIR = ROOT / "data" / "logs"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--days", type=int, default=7, help="조회할 최근 일수 (기본 7일)")
    parser.add_argument("--log-dir", type=Path, default=LOG_DIR, help="JSONL 파일이 있는 디렉터리")
    parser.add_argument("--include-tests", action="store_true", help="자동 테스트가 남긴 기록도 포함")
    args = parser.parse_args()
    if args.days < 1:
        parser.error("--days는 1 이상이어야 합니다.")
    groups, skipped, _, _ = summarize(args.log_dir, args.days, args.include_tests)
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
        print(f"  예시 세션 ID {group.session_id or '없음'}")
        if group.sample_stack:
            print("  예시 스택")
            print("\n".join(f"    {frame}" for frame in group.sample_stack.splitlines()))


if __name__ == "__main__":
    main()
