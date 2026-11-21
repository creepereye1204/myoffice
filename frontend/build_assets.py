"""빌드 시 정적 자산 최적화 (Dockerfile 1단계에서 실행).

1. rhwp-studio 번들이 cdn.jsdelivr.net 에서 받는 HWP 글꼴을 내려받아 같은 출처(/rhwp/ext-fonts/)로 바꾼다.
2. 거의 모든 HWP 문서가 쓰는 큰 기본 글꼴(함초롬바탕/돋움, 합쳐 21MB)은 woff2로 다시 압축 (-35%).
3. wasm 엔진은 brotli(q11)로 미리 압축 → nginx가 br 지원 브라우저에 .br 을 보낸다 (gzip 대비 -30%).
4. 나머지 텍스트 자산은 gzip -9 미리 압축 (gzip_static).
"""
import gzip
import re
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import brotli
from fontTools.ttLib import TTFont

SITE = Path(sys.argv[1])
RHWP = SITE / "rhwp"
CDN = "https://cdn.jsdelivr.net/"
WOFF2_TARGETS = ("HANBatang.woff", "HCRDotum.woff")
bundles = list((RHWP / "assets").glob("*.js"))

# ---- 1. 외부 글꼴 받기
urls = sorted({u for b in bundles for u in re.findall(r"https://cdn\.jsdelivr\.net/[A-Za-z0-9./@_%-]+\.(?:woff2?|ttf|otf)", b.read_text("utf-8"))})
print(f"external fonts: {len(urls)}", flush=True)


def fetch(url: str) -> tuple[str, bool]:
    dest = RHWP / "ext-fonts" / url[len(CDN):]
    dest.parent.mkdir(parents=True, exist_ok=True)
    for attempt in range(6):
        try:
            with urllib.request.urlopen(url, timeout=300) as r:
                data = r.read()
            if data:
                dest.write_bytes(data)
                return url, True
        except Exception as e:  # noqa: BLE001
            print(f"  retry {attempt + 1} {url}: {e}", flush=True)
            time.sleep(2 + attempt * 2)
    return url, False


with ThreadPoolExecutor(8) as ex:
    results = dict(ex.map(fetch, urls))

# ---- 2. 큰 기본 글꼴 woff2
replace = {}
for url, ok in results.items():
    if not ok:
        print(f"WARN: {url} 받기 실패 — CDN 유지", flush=True)
        continue
    rel = url[len(CDN):]
    local = f"/rhwp/ext-fonts/{rel}"
    if rel.endswith(WOFF2_TARGETS):
        src = RHWP / "ext-fonts" / rel
        f = TTFont(src)
        f.flavor = "woff2"
        out = src.with_suffix(".woff2")
        f.save(out)
        print(f"woff2 {src.name}: {src.stat().st_size // 1024}KB -> {out.stat().st_size // 1024}KB", flush=True)
        local = local[: -len(".woff")] + ".woff2"
    replace[url] = local

for b in bundles:
    t = b.read_text("utf-8")
    n = t
    for u, l in replace.items():
        n = n.replace(u, l)
    if n != t:
        b.write_text(n, "utf-8")
left = {u for b in bundles for u in re.findall(r"https://cdn\.jsdelivr\.net/[^`\"']+\.(?:woff2?|ttf|otf)", b.read_text("utf-8"))}
print(f"left on CDN: {len(left)}", flush=True)

# ---- 3. wasm brotli
for w in (RHWP / "assets").glob("*.wasm"):
    data = w.read_bytes()
    br = brotli.compress(data, quality=11, lgwin=24)
    w.with_name(w.name + ".br").write_bytes(br)
    print(f"brotli {w.name}: {len(data) // 1024}KB -> {len(br) // 1024}KB", flush=True)

# ---- 4. gzip_static
for p in SITE.rglob("*"):
    if p.is_file() and p.suffix in {".js", ".css", ".wasm", ".html", ".svg", ".json", ".webmanifest", ".mjs"}:
        p.with_name(p.name + ".gz").write_bytes(gzip.compress(p.read_bytes(), 9))
print("done", flush=True)
