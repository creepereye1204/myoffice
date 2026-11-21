# --- 1) 빈 HWP/HWPX 템플릿 (rhwp core WASM) ---
FROM node:22-alpine AS hwp
WORKDIR /build
RUN npm init -y >/dev/null && npm install --no-audit --no-fund @rhwp/core@0.9.1
COPY templates/make_hwp.mjs .
RUN mkdir out && node make_hwp.mjs /build/out

# --- 2) API ---
FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY templates/make_office.py /tmp/make_office.py
RUN mkdir -p /app/templates && python /tmp/make_office.py /app/templates
COPY --from=hwp /build/out/ /app/templates/
COPY app ./app
RUN useradd -u 10001 -m app && mkdir -p /data && chown app /data
USER app
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "*"]
