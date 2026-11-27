import { expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const API = process.env.API_URL || 'https://api.myoffice.p-e.kr';
export const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

// 무시해도 되는 브라우저 콘솔 메시지 (ONLYOFFICE 내부 경고 등)
const BENIGN = [/Permissions policy violation/, /favicon/, /Failed to load resource: the server responded with a status of 404/,
  /sourcemap/i, /DevTools/, /\[Violation\]/, /ResizeObserver loop/];

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
let adminToken;
export const created = [];
// 이번 실행에서 만든 테스트 계정 이름 목록 — 정리(teardown.js)는 이 목록에 있는 계정만 지운다.
// (이름 규칙으로 지우면 같은 모양의 아이디를 쓰는 실제 사용자 문서까지 지워질 수 있음)
export const CREATED_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '.created-accounts');
export function rememberAccount(username) { fs.appendFileSync(CREATED_FILE, `${username}\n`); }

export async function adminH() {
  if (!adminToken) {
    const r = await fetch(`${API}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: ADMIN_PASSWORD }) });
    if (!r.ok) throw new Error('관리자 로그인 실패 — ADMIN_PASSWORD 확인');
    adminToken = (await r.json()).token;
  }
  return { Authorization: `Bearer ${adminToken}` };
}

/** 관리자 API로 테스트 계정 생성 (+ 로그인 토큰) */
export async function makeAccount(name = '테스터') {
  const username = 'e_' + Math.random().toString(36).slice(2, 12);
  rememberAccount(username);
  const password = 'pw_' + Math.random().toString(36).slice(2, 14);
  const r = await fetch(`${API}/api/admin/users`, { method: 'POST', headers: { ...(await adminH()), 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password, name }) });
  if (!r.ok) throw new Error(await r.text());
  const user = await r.json();
  created.push(user.id);
  const l = await (await fetch(`${API}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) })).json();
  return { username, password, user, token: l.token, H: { Authorization: `Bearer ${l.token}` } };
}

export async function deleteAccount(id) {
  await fetch(`${API}/api/admin/users/${id}`, { method: 'DELETE', headers: await adminH() });
}

/** 로그인된 사용자 브라우저 컨텍스트 */
export async function newUser(browser, name = '테스터') {
  const acc = await makeAccount(name);
  const ctx = await browser.newContext();
  await ctx.addInitScript(([token, me]) => {
    if (!sessionStorage.getItem('e2e-init')) {
      localStorage.setItem('rhwp.token', token);
      localStorage.setItem('rhwp.me', JSON.stringify(me));
      sessionStorage.setItem('e2e-init', '1');
    }
  }, [acc.token, acc.user]);
  const page = await ctx.newPage();
  const errors = watchErrors(page);
  return { ...acc, ctx, page, errors, uid: `u${acc.user.id}`, name };
}

/** 공유 링크로 들어오는 손님 (로그인 안 함) */
export async function newGuest(browser, name = '손님') {
  const ctx = await browser.newContext();
  const uid = 'g' + Math.random().toString(36).slice(2, 12);
  await ctx.addInitScript((user) => localStorage.setItem('rhwp.user', JSON.stringify(user)), { uid, name });
  const page = await ctx.newPage();
  return { ctx, page, errors: watchErrors(page), uid, name };
}

export function watchErrors(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !BENIGN.some((re) => re.test(m.text()))) errors.push(`console: ${m.text().slice(0, 300)}`);
  });
  return errors;
}

export async function api(user, p, opts = {}) {
  const r = await fetch(`${API}${p}`, { ...opts, headers: { ...user.H, ...(opts.json ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) }, body: opts.json ? JSON.stringify(opts.json) : opts.body });
  if (!r.ok) throw new Error(`${p} → ${r.status} ${await r.text()}`);
  return (r.headers.get('content-type') || '').includes('json') ? r.json() : r;
}

export const create = (user, type) => api(user, '/api/files/new', { method: 'POST', json: { type } });

export async function uploadFixture(user, name) {
  const fd = new FormData();
  fd.append('file', new Blob([fs.readFileSync(path.join(FIX, name))]), name);
  return api(user, '/api/files/upload', { method: 'POST', body: fd });
}

/** 파일 내용을 텍스트로 (ONLYOFFICE 변환 경유) — 실제 저장된 내용 확인용 */
export async function textOf(user, id, hops = []) {
  let cur = id;
  for (const to of hops) cur = (await api(user, `/api/files/${cur}/convert`, { method: 'POST', json: { to } })).id;
  const t = await api(user, `/api/files/${cur}/convert`, { method: 'POST', json: { to: 'txt' } });
  const r = await api(user, `/api/files/${t.id}/content`);
  return (await r.text()).replace(/\s+/g, '');
}

export async function openEditor(page, query) {
  await page.goto(`/edit?${query}`);
  await expect(page.locator('#loading')).toHaveCount(0, { timeout: 120_000 });
}

/** ONLYOFFICE 편집 영역에 글자 입력 */
export async function ooType(page, text) {
  const frame = page.frameLocator('iframe[name="frameEditor"]');
  await frame.locator('#editor_sdk').waitFor();
  await page.waitForTimeout(1500);
  const box = await page.locator('iframe[name="frameEditor"]').boundingBox();
  await page.mouse.click(box.x + box.width * 0.4, box.y + box.height * 0.45);
  await page.keyboard.press('Control+End');
  await page.keyboard.type(` ${text} `, { delay: 30 });
}

/** rhwp 편집 영역에 글자 입력 */
export async function hwpType(page, text) {
  const box = await page.locator('#hwp iframe').boundingBox();
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.42);
  await page.waitForTimeout(300);
  await page.keyboard.type(text, { delay: 40 });
}

export function noErrors(errors) {
  expect(errors, errors.join('\n')).toEqual([]);
}

/** Ctrl+S 를 눌렀을 때 브라우저 기본 동작('페이지 저장')이 막혔는지 모든 프레임에서 기록 → window.top.__ctrlS */
export async function watchSaveKey(ctx) {
  await ctx.addInitScript(() => {
    window.addEventListener('keydown', (e) => {
      if (!((e.ctrlKey || e.metaKey) && e.code === 'KeyS')) return;
      setTimeout(() => { try { (window.top.__ctrlS ||= []).push(e.defaultPrevented); } catch {} }, 0);
    }, true);
  });
}
export const ctrlS = (page) => page.evaluate(() => window.__ctrlS || []);
