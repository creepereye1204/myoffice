#!/bin/sh
# API 테스트 (실서버 대상). 사용: tests/run-api-tests.sh [pytest 인자]
# 관리자 비밀번호는 ../.env 의 ADMIN_PASSWORD 를 쓴다 (테스트 계정을 만들고 끝나면 지운다).
cd "$(dirname "$0")"
ADMIN_PASSWORD=${ADMIN_PASSWORD:-$(grep ^ADMIN_PASSWORD= ../.env 2>/dev/null | cut -d= -f2)}
exec docker run --rm -v "$PWD:/t" -w /t/api -e API_URL -e WEB_URL -e ADMIN_PASSWORD="$ADMIN_PASSWORD" python:3.12-slim \
  sh -c 'pip install -q -r /t/requirements.txt 2>/dev/null && python -m pytest -q -p no:cacheprovider "$@"' sh "$@"
