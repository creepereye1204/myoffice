"""빌드 시 정적 자산 최적화 (Dockerfile 1단계에서 실행).

1. rhwp-studio 번들이 cdn.jsdelivr.net 에서 받는 HWP 글꼴을 내려받아 같은 출처(/rhwp/ext-fonts/)로 바꾼다.
2. woff/woff2 글꼴은 압축을 푼 TTF/OTF 로 바꾼다. 브라우저가 woff2 를 푸는 일은 화면을 그리는
   메인 스레드에서 돌아서 (함초롬바탕 하나에 0.7초) 문서 열기가 느려진다. TTF 는 0.2초.
   전송 크기는 HTTP brotli 로 woff2 와 비슷하게 유지 (압축 풀기는 네트워크 스레드가 처리).
3. wasm 엔진과 TTF/OTF 는 brotli(q11)로 미리 압축 → nginx가 br 지원 브라우저에 .br 을 보낸다.
4. 나머지 텍스트 자산(+글꼴)은 gzip -9 미리 압축 (gzip_static).
"""
import gzip
import os
import re
import sys
import time
import urllib.request
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor
from pathlib import Path

import brotli
from fontTools.ttLib import TTFont

SITE = Path(sys.argv[1])
RHWP = SITE / "rhwp"
CDN = "https://cdn.jsdelivr.net/"
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

# ---- 2. woff/woff2 → TTF/OTF  (이름 충돌 방지: 원래 이름 뒤에 확장자를 덧붙임, 예 HANBatang.woff.ttf)
replace = {}
for url, ok in results.items():
    if ok:
        replace[url] = f"/rhwp/ext-fonts/{url[len(CDN):]}"
    else:
        print(f"WARN: {url} 받기 실패 — CDN 유지", flush=True)


def to_sfnt(src: Path) -> tuple[Path, Path]:
    f = TTFont(src, recalcBBoxes=False, recalcTimestamp=False)
    out = src.with_name(src.name + (".otf" if f.sfntVersion == "OTTO" else ".ttf"))
    f.flavor = None
    f.save(out)
    return src, out


woffs = [p for d in ("fonts", "ext-fonts") for p in (RHWP / d).rglob("*") if p.suffix in (".woff", ".woff2")]
renamed = {}  # /rhwp/... 옛 경로 → 새 경로
with ProcessPoolExecutor(os.cpu_count()) as ex:
    for src, out in ex.map(to_sfnt, woffs):
        renamed["/" + str(src.relative_to(SITE))] = "/" + str(out.relative_to(SITE))
print(f"woff→sfnt: {len(renamed)} fonts", flush=True)


def rewrite(text: str) -> str:
    for u, l in replace.items():
        text = text.replace(u, l)
    for old, new in renamed.items():
        # 번들은 '/rhwp/fonts/X.woff2' 또는 상대경로 'fonts/X.woff2' 로 참조 (서비스워커 사전캐시 목록도)
        for o, n in ((old, new), (old[len("/rhwp/"):], new[len("/rhwp/"):])):
            text = re.sub(r"(?<![\w.-])" + re.escape(o) + r"(?![\w.])", n, text)
    return text


for b in [*bundles, RHWP / "sw.js"]:
    t = b.read_text("utf-8")
    n = rewrite(t)
    if n != t:
        b.write_text(n, "utf-8")
left = {u for b in bundles for u in re.findall(r"https://cdn\.jsdelivr\.net/[^`\"']+\.(?:woff2?|ttf|otf)", b.read_text("utf-8"))}
print(f"left on CDN: {len(left)}", flush=True)
stale = {m for b in bundles for m in re.findall(r"[\w./@-]+\.woff2?(?![\w.])", b.read_text("utf-8"))}
print(f"woff refs left: {len(stale)} {sorted(stale)[:5]}", flush=True)


# ---- 3. brotli (wasm, 글꼴) — 큰 파일은 오래 걸려서 병렬
def br(p: Path) -> str:
    data = p.read_bytes()
    out = brotli.compress(data, quality=11, lgwin=24)
    p.with_name(p.name + ".br").write_bytes(out)
    return f"brotli {p.name}: {len(data) // 1024}KB -> {len(out) // 1024}KB" if len(data) > 5e6 else ""


targets = [*(RHWP / "assets").glob("*.wasm"), *(p for p in RHWP.rglob("*") if p.suffix in (".ttf", ".otf"))]
targets.sort(key=lambda p: -p.stat().st_size)  # 큰 것부터
with ProcessPoolExecutor(os.cpu_count()) as ex:
    for line in ex.map(br, targets):
        if line:
            print(line, flush=True)

# ---- 4. gzip_static
for p in SITE.rglob("*"):
    if p.is_file() and p.suffix in {".js", ".css", ".wasm", ".html", ".svg", ".json", ".webmanifest", ".mjs", ".ttf", ".otf"}:
        p.with_name(p.name + ".gz").write_bytes(gzip.compress(p.read_bytes(), 9))
print("done", flush=True)
