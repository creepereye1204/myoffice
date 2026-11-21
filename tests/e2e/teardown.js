// 테스트 계정 정리: 이름이 e_ 로 시작하는 계정을 모두 지운다 (워커 프로세스가 달라 목록 공유가 안 되므로)
export default async function () {
  const API = process.env.API_URL || 'https://api.myoffice.p-e.kr';
  const r = await fetch(`${API}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: process.env.ADMIN_PASSWORD }) });
  if (!r.ok) return;
  const H = { Authorization: `Bearer ${(await r.json()).token}` };
  const { users } = await (await fetch(`${API}/api/admin/users`, { headers: H })).json();
  for (const u of users) if (/^(e_|s_|t_)/.test(u.username)) await fetch(`${API}/api/admin/users/${u.id}`, { method: 'DELETE', headers: H });
}
