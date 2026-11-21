# ONLYOFFICE + 한글 글꼴 (나눔/Noto CJK) — 한국어 문서 표시 품질용
FROM onlyoffice/documentserver:9.2
RUN apt-get update \
 && apt-get install -y --no-install-recommends fonts-nanum fonts-nanum-extra fonts-noto-cjk \
 && rm -rf /var/lib/apt/lists/* \
 && (documentserver-generate-allfonts.sh true || true)
