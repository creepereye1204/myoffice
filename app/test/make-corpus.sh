#!/bin/sh
# 형식별 검사 문서 만들기 → app/build/corpus/  (도커 + LibreOffice + iconv 필요)
#  - docx/xlsx/pptx: 파이썬(api 이미지)으로 한글·영문 표시 글자를 넣어 생성
#  - doc odt rtf txt / xls ods csv / ppt odp / pdf: LibreOffice 로 변환
#  - txt-cp949: 옛 한글 인코딩(EUC-KR 계열) 글자 파일 — 글자 깨짐 확인용
#  - hwp: 실제 한컴 한글 문서(tests/fixtures/sample.hwp), hwpx: 그것을 rhwp 로 변환
set -e
cd "$(dirname "$0")/../.."
OUT=app/build/corpus
rm -rf "$OUT" && mkdir -p "$OUT"
docker run --rm -i --user "$(id -u):$(id -g)" -v "$PWD/$OUT:/out" myoffice-app-api python - <<'PY'
from docx import Document
from openpyxl import Workbook
from pptx import Presentation
d = Document(); d.add_heading("문서 검사 제목", 1); d.add_paragraph("가나다라 FMTWORD 한글 문장입니다. 숫자 12345"); d.save("/out/word.docx")
wb = Workbook(); ws = wb.active; ws["A1"] = "이름"; ws["B1"] = "값"; ws["A2"] = "가나다"; ws["B2"] = 42; ws["A3"] = "FMTCELL"; wb.save("/out/cell.xlsx")
p = Presentation(); s = p.slides.add_slide(p.slide_layouts[1]); s.shapes.title.text = "발표 제목 FMTSLIDE"; s.placeholders[1].text = "가나다라 내용"; p.save("/out/slide.pptx")
PY
P=$(mktemp -d)
for spec in "word.docx:doc odt rtf pdf" "cell.xlsx:xls ods csv" "slide.pptx:ppt odp"; do
  src=${spec%%:*}
  for to in ${spec#*:}; do
    filt=$to; [ $to = csv ] && filt='csv:Text - txt - csv (StarCalc):44,34,76'
    soffice --headless -env:UserInstallation=file://$P --convert-to "$filt" "$OUT/$src" --outdir "$OUT" >/dev/null 2>&1
  done
done
soffice --headless -env:UserInstallation=file://$P --convert-to 'txt:Text (encoded):UTF8' "$OUT/word.docx" --outdir "$OUT" >/dev/null 2>&1
rm -rf "$P"
printf '이름,값\n가나다 FMTCP949,1\n' | iconv -f UTF-8 -t CP949 > "$OUT/legacy-cp949.txt"
cp tests/fixtures/sample.hwp "$OUT/hangul.hwp"
# hwpx: 같은 한글 문서를 rhwp 로 HWPX 로 (서버 api/Dockerfile 과 같은 @rhwp/core)
docker run --rm -i --user "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD/$OUT:/out" -w /tmp node:22-alpine sh -c '
  npm init -y >/dev/null && npm install -s --no-audit --no-fund @rhwp/core@0.9.1 >/dev/null && node --input-type=module -e "
    import fs from \"node:fs\";
    const m = await import(\"/tmp/node_modules/@rhwp/core/rhwp.js\");
    m.initSync({ module: fs.readFileSync(\"/tmp/node_modules/@rhwp/core/rhwp_bg.wasm\") });
    const d = new m.HwpDocument(fs.readFileSync(\"/out/hangul.hwp\"));
    fs.writeFileSync(\"/out/hangul.hwpx\", d.exportHwpx());
  "'
ls -la "$OUT"
