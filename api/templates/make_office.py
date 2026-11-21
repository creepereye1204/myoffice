"""빌드 시 빈 docx/xlsx/pptx 템플릿 생성."""
import sys
from docx import Document
from docx.shared import Pt
from docx.oxml.ns import qn
from openpyxl import Workbook
from pptx import Presentation
from pptx.util import Inches

out = sys.argv[1]
d = Document()
st = d.styles["Normal"]
st.font.name = "맑은 고딕"
st.font.size = Pt(10)
st.element.get_or_add_rPr().get_or_add_rFonts().set(qn("w:eastAsia"), "맑은 고딕")
d.save(f"{out}/blank.docx")

wb = Workbook()
wb.active.title = "Sheet1"
wb.save(f"{out}/blank.xlsx")

p = Presentation()
# 기본 템플릿은 4:3(10in). 16:9(13.333in)로 넓히면 마스터/레이아웃의 자리표시자가
# 옛 위치에 남아 왼쪽으로 치우친다 → 가로 위치·너비를 같은 비율로 늘려 가운데 정렬 유지.
old_w = p.slide_width
p.slide_width, p.slide_height = Inches(13.333), Inches(7.5)
k = p.slide_width / old_w


def stretch(shapes):
    for sh in shapes:
        # 자기 xfrm이 있는 도형만 — 마스터에서 위치를 상속하는 자리표시자를 또 늘리면 두 번 늘어난다
        if sh._element.xpath("./p:spPr/a:xfrm"):
            sh.left, sh.width = int(sh.left * k), int(sh.width * k)


for master in p.slide_masters:
    stretch(master.shapes)
    for layout in master.slide_layouts:
        stretch(layout.shapes)
p.slides.add_slide(p.slide_layouts[0])
p.save(f"{out}/blank.pptx")
