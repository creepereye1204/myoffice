// 테스트 계정 정리: 이번 실행에서 만든 계정(.created-accounts 에 적힌 이름)만 지운다.
// 이름 규칙(e_·s_ 로 시작 등)으로 지우지 않는다 — 실제 사용자가 같은 모양의 아이디를 쓰면 그 사람 문서까지 지워지므로.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '.created-accounts');

export default async function () {
  if (!fs.existsSync(FILE)) return;
  const mine = new Set(fs.readFileSync(FILE, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean));
  const API = process.env.API_URL || 'https://api.myoffice.p-e.kr';
  const r = await fetch(`${API}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: process.env.ADMIN_PASSWORD }) });
  if (!r.ok) return;
  const H = { Authorization: `Bearer ${(await r.json()).token}` };
  const { users } = await (await fetch(`${API}/api/admin/users`, { headers: H })).json();
  for (const u of users) if (mine.has(u.username)) await fetch(`${API}/api/admin/users/${u.id}`, { method: 'DELETE', headers: H });
  fs.rmSync(FILE, { force: true });
}
