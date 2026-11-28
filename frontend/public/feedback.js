import { api, cachedMe, getToken, toast } from './common.js';

const open = document.querySelector('#feedback-open');
const dialog = document.createElement('dialog');
dialog.id = 'feedback-dialog';
dialog.setAttribute('aria-labelledby', 'feedback-title');
dialog.innerHTML = `
  <form id="feedback-form">
    <h3 id="feedback-title">의견 보내기</h3>
    <fieldset class="feedback-kinds">
      <legend>종류</legend>
      <label><input type="radio" name="kind" value="bug" checked /> 버그</label>
      <label><input type="radio" name="kind" value="suggestion" /> 제안</label>
      <label><input type="radio" name="kind" value="other" /> 기타</label>
    </fieldset>
    <label class="feedback-field">내용
      <textarea name="message" rows="5" required minlength="5" maxlength="2000" aria-describedby="feedback-count"></textarea>
    </label>
    <div class="feedback-count" id="feedback-count"></div>
    <label class="feedback-field">답장 받을 이메일 (선택)
      <input type="email" name="email" maxlength="254" autocomplete="email" />
    </label>
    <label><input type="checkbox" name="includeErrors" checked /> 최근 오류 기록 함께 보내기</label>
    <p class="feedback-context"></p>
    <div class="actions">
      <button class="btn" type="button" id="feedback-cancel">취소</button>
      <button class="btn primary" type="submit">보내기</button>
    </div>
  </form>`;
document.body.appendChild(dialog);

const form = dialog.querySelector('form');
const { message, email, includeErrors } = form.elements;
const count = dialog.querySelector('#feedback-count');
const cancel = dialog.querySelector('#feedback-cancel');
const send = dialog.querySelector('[type="submit"]');
const encoder = new TextEncoder();
let context;

function updateCount() {
  count.textContent = `${message.value.length} / 2000자`;
  message.setCustomValidity(message.value && message.value.trim().length < 5 ? '내용을 5자 이상 입력해 주세요' : '');
}

open.addEventListener('click', () => {
  const page = open.dataset.page;
  const ext = window.__edit?.file?.ext;
  context = {
    page,
    file_type: page === 'edit' && [
      'docx', 'doc', 'odt', 'rtf', 'txt', 'xlsx', 'xls', 'ods', 'csv', 'pptx', 'ppt', 'odp', 'hwp', 'hwpx', 'pdf',
    ].includes(ext) ? ext : null,
    ua: navigator.userAgent.slice(0, 160),
    screen: `${screen.width}x${screen.height}`,
    build: (document.querySelector('meta[name="build"]')?.content || document.lastModified).slice(0, 100),
  };
  dialog.querySelector('.feedback-context').textContent = [
    `페이지 ${context.page}`, context.file_type && `파일 형식 ${context.file_type}`,
    `브라우저 ${context.ua}`, `화면 ${context.screen}`, `빌드 ${context.build}`,
  ].filter(Boolean).join(' · ');
  email.value = (getToken() && cachedMe()?.email) || '';
  includeErrors.disabled = typeof window.getRecentClientErrors !== 'function';
  updateCount();
  dialog.showModal();
});

message.addEventListener('input', updateCount);
cancel.addEventListener('click', () => dialog.close());
dialog.addEventListener('cancel', (event) => { if (send.disabled) event.preventDefault(); });

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (send.disabled) return;
  updateCount();
  if (!form.reportValidity()) return;
  const body = { ...context, kind: form.elements.kind.value, message: message.value.trim(), email: email.value.trim() || null };
  if (includeErrors.checked && !includeErrors.disabled) {
    const { sessionId, errors } = window.getRecentClientErrors();
    body.session_id = sessionId;
    body.errors = errors;
    // 전체 본문이 서버 제한에 맞도록 오래된 오류 요약부터 뺀다.
    while (errors.length && encoder.encode(JSON.stringify(body)).length > 16 * 1024) errors.shift();
  }
  send.disabled = cancel.disabled = true;
  try {
    await api('/api/feedback', { method: 'POST', body, includeShare: false, referrerPolicy: 'no-referrer' });
    dialog.close();
    form.reset();
    toast('의견을 보냈습니다. 고맙습니다!', 'ok');
  } catch (e) {
    toast(e.message, 'err', [], dialog);
  } finally {
    send.disabled = cancel.disabled = false;
  }
});
