// 빌드 시 @rhwp/core 로 빈 HWP/HWPX 생성
import fs from 'node:fs';
const pkgDir = new URL('./node_modules/@rhwp/core/', import.meta.url).pathname;
const m = await import(pkgDir + 'rhwp.js');
m.initSync({ module: fs.readFileSync(pkgDir + 'rhwp_bg.wasm') });
const d = m.HwpDocument.createEmpty();
const out = process.argv[2];
fs.writeFileSync(out + '/blank.hwp', d.exportHwp());
fs.writeFileSync(out + '/blank.hwpx', d.exportHwpx());
console.log('rhwp', m.version(), 'templates written');
