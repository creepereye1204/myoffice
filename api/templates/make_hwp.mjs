// 빌드 시 @rhwp/core 로 빈 HWP/HWPX 생성
// createEmpty() 만 쓰면 기본 글자 모양(charPr 0)이 없는 문서가 되어, 그걸 열어 HWPX 로 저장하면
// "미등록 ID 참조: charPrIDRef" 로 실패한다 → 편집기의 '새 문서'처럼 createBlankDocument() 로 채운다.
import fs from 'node:fs';
const pkgDir = new URL('./node_modules/@rhwp/core/', import.meta.url).pathname;
const m = await import(pkgDir + 'rhwp.js');
m.initSync({ module: fs.readFileSync(pkgDir + 'rhwp_bg.wasm') });
const d = m.HwpDocument.createEmpty();
d.createBlankDocument();
const out = process.argv[2];
const files = { 'blank.hwp': d.exportHwp(), 'blank.hwpx': d.exportHwpx() };
// 만든 템플릿을 다시 열어 두 형식으로 저장되는지 확인
for (const [name, bytes] of Object.entries(files)) {
  const r = new m.HwpDocument(bytes);
  r.exportHwp();
  r.exportHwpx();
  fs.writeFileSync(`${out}/${name}`, bytes);
}
console.log('rhwp', m.version(), 'templates written');
