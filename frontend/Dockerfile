# 1) rhwp-studio 자산 최적화 (글꼴 내려받기·woff2, wasm brotli, gzip) — 오래 걸리므로
#    public/rhwp 가 바뀔 때만 다시 돈다 (앱 파일 수정은 이 단계 캐시를 깨지 않음)
FROM python:3.12-slim AS assets
RUN pip install --no-cache-dir fonttools==4.55.3 brotli==1.1.0
COPY build_assets.py /build_assets.py
COPY public/rhwp/ /site/rhwp/
RUN python /build_assets.py /site

# 2) nginx: 앱 파일 + 최적화된 rhwp
FROM nginx:1.30.7-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY public/ /usr/share/nginx/html/
COPY --from=assets /site/rhwp/ /usr/share/nginx/html/rhwp/
