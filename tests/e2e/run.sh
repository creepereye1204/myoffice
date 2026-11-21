#!/bin/sh
# 브라우저 E2E 테스트 (실서버 대상). 사용: tests/e2e/run.sh [playwright 인자]
cd "$(dirname "$0")"
[ -d node_modules ] || npm ci --no-audit --no-fund
export ADMIN_PASSWORD=${ADMIN_PASSWORD:-$(grep ^ADMIN_PASSWORD= ../../.env 2>/dev/null | cut -d= -f2)}
exec npx playwright test "$@"
