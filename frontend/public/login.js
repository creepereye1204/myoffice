import { api, setSession, getToken } from './common.js';

const $ = (s) => document.querySelector(s);
const next = (() => {
  const n = new URLSearchParams(location.search).get('next') || '/';
  return n.startsWith('/') && !n.startsWith('//') ? n : '/';  // 외부 주소로 튕기기 방지
})();

if (getToken()) {
  api('/api/auth/me').then(() => location.replace(next)).catch(() => {});
}

let signupOpen = true;
api('/api/auth/config').then((c) => { signupOpen = c.signup; if (!signupOpen) $('#tab-signup').hidden = true; }).catch(() => {});

function tab(name) {
  document.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
  $('#login-form').hidden = name !== 'login';
  $('#signup-form').hidden = name !== 'signup' || !signupOpen;
  $('#signup-closed').hidden = name !== 'signup' || signupOpen;
  $('#err').textContent = '';
  (name === 'login' ? $('#login-form') : $('#signup-form')).querySelector('input')?.focus();
}
document.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => tab(b.dataset.tab)));
if (new URLSearchParams(location.search).get('tab') === 'signup') tab('signup');

async function submit(form, path, body) {
  const btn = form.querySelector('button[type=submit]');
  btn.disabled = true;
  $('#err').textContent = '';
  try {
    const { token, user } = await api(path, { method: 'POST', body });
    setSession(token, user);
    location.replace(next);
  } catch (e) {
    $('#err').textContent = e.message;
    btn.disabled = false;
  }
}

$('#login-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  submit(e.target, '/api/auth/login', { username: f.get('username').trim().toLowerCase(), password: f.get('password') });
});

$('#signup-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  if (f.get('password') !== f.get('password2')) { $('#err').textContent = '비밀번호 확인이 다릅니다'; return; }
  submit(e.target, '/api/auth/signup', {
    username: f.get('username').trim().toLowerCase(), name: f.get('name').trim(), password: f.get('password'),
  });
});
