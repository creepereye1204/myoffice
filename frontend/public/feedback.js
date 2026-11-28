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
    <label class="feedback-field">이미지 첨부
      <input type="file" name="images" accept="image/png,image/jpeg,image/webp,image/gif" multiple
             aria-describedby="feedback-image-help" />
    </label>
    <div id="feedback-image-help" class="feedback-image-help">최대 3장 · 장당 5MB. 내용 입력란에 끌어 놓거나 붙여넣을 수 있습니다.</div>
    <div class="feedback-thumbnails" id="feedback-previews"></div>
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
const { message, email, includeErrors, images } = form.elements;
const count = dialog.querySelector('#feedback-count');
const cancel = dialog.querySelector('#feedback-cancel');
const send = dialog.querySelector('[type="submit"]');
const encoder = new TextEncoder();
const previews = dialog.querySelector('#feedback-previews');
const imageTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const imageLimit = 5 * 1024 * 1024;
const attachments = [];
let context;
let processing = false;
let submitting = false;
let generation = 0;

function updateAttachmentControls() {
  images.disabled = processing || submitting || attachments.length === 3;
  send.disabled = processing || submitting;
  previews.querySelectorAll('button').forEach((button) => { button.disabled = submitting; });
}

async function resizeImage(file) {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement('canvas');
  try {
    const scale = Math.min(1, 1920 / Math.max(bitmap.width, bitmap.height));
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const encode = (type) => new Promise((resolve) => canvas.toBlob(resolve, type, 0.85));
    let blob = await encode('image/webp');
    if (blob?.type !== 'image/webp') blob = await encode('image/jpeg');
    if (!blob || blob.size > imageLimit) throw new Error();
    return blob;
  } finally {
    bitmap.close();
    canvas.width = canvas.height = 1;
  }
}

function previewAttachment(blob) {
  const entry = { blob, url: URL.createObjectURL(blob) };
  const card = document.createElement('div');
  const image = document.createElement('img');
  image.src = entry.url;
  image.alt = '첨부 이미지 미리보기';
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.textContent = '×';
  remove.setAttribute('aria-label', '첨부 이미지 제거');
  remove.addEventListener('click', () => {
    attachments.splice(attachments.indexOf(entry), 1);
    URL.revokeObjectURL(entry.url);
    card.remove();
    updateAttachmentControls();
  });
  card.append(image, remove);
  previews.append(card);
  attachments.push(entry);
}

async function attachFiles(files) {
  if (!files.length || !dialog.open || processing || submitting) return;
  const version = generation;
  processing = true;
  updateAttachmentControls();
  try {
    for (const file of files) {
      if (attachments.length === 3) {
        toast('이미지는 최대 3장까지 첨부할 수 있습니다', 'err', [], dialog);
        break;
      }
      if (!imageTypes.has(file.type) || file.size > imageLimit) {
        toast('5MB 이하의 PNG, JPEG, WebP 또는 GIF 이미지를 선택해 주세요', 'err', [], dialog);
        continue;
      }
      try {
        const blob = await resizeImage(file);
        if (!dialog.open || version !== generation) return;
        previewAttachment(blob);
      } catch {
        if (!dialog.open || version !== generation) return;
        toast('이미지를 처리할 수 없습니다', 'err', [], dialog);
      }
    }
  } finally {
    if (version === generation) {
      processing = false;
      updateAttachmentControls();
    }
  }
}

function clearAttachments() {
  generation += 1;
  processing = false;
  for (const entry of attachments) URL.revokeObjectURL(entry.url);
  attachments.length = 0;
  previews.replaceChildren();
  images.value = '';
  updateAttachmentControls();
}

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
images.addEventListener('change', () => {
  const files = [...images.files];
  images.value = '';
  attachFiles(files);
});
message.addEventListener('dragover', (event) => {
  if (event.dataTransfer.types.includes('Files')) event.preventDefault();
});
message.addEventListener('drop', (event) => {
  const files = [...event.dataTransfer.files];
  if (!files.length) return;
  event.preventDefault();
  attachFiles(files);
});
message.addEventListener('paste', (event) => {
  const files = [...event.clipboardData.files].filter((file) => file.type.startsWith('image/'));
  if (!files.length) return;
  // 텍스트도 담긴 클립보드는 기본 텍스트 붙여넣기를 유지한다.
  if (!event.clipboardData.getData('text/plain')) event.preventDefault();
  attachFiles(files);
});
cancel.addEventListener('click', () => dialog.close());
dialog.addEventListener('cancel', (event) => { if (submitting) event.preventDefault(); });
dialog.addEventListener('close', clearAttachments);

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
  let payload = body;
  if (attachments.length) {
    payload = new FormData();
    payload.append('payload', JSON.stringify(body));
    for (const { blob } of attachments) {
      payload.append('images', blob, blob.type === 'image/webp' ? 'image.webp' : 'image.jpg');
    }
  }
  submitting = cancel.disabled = true;
  updateAttachmentControls();
  try {
    await api('/api/feedback', { method: 'POST', body: payload, includeShare: false, referrerPolicy: 'no-referrer' });
    dialog.close();
    form.reset();
    toast('의견을 보냈습니다. 고맙습니다!', 'ok');
  } catch (e) {
    toast(e.message, 'err', [], dialog);
  } finally {
    submitting = cancel.disabled = false;
    updateAttachmentControls();
  }
});
