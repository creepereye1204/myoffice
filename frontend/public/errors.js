(() => {
  if (!['www.myoffice.p-e.kr', 'www.rhwp.p-e.kr'].includes(location.hostname)) return;

  const endpoint = `https://api.${location.hostname.slice(4)}/api/client-errors`;
  const page = location.pathname.match(/^\/(edit|login|admin)(?:\.html)?$/)?.[1] || 'home';
  const build = document.querySelector('meta[name="build"]')?.content || document.lastModified;
  const sessionId = crypto.randomUUID();
  const fileTypes = ['word', 'cell', 'slide', 'hwp', 'pdf'];
  const seen = new Set();
  const pending = [];
  const encoder = new TextEncoder();

  function scrub(value, limit, privateValues) {
    if (typeof value !== 'string') return '';
    for (const secret of privateValues) {
      if (secret) value = value.replaceAll(secret, '[삭제]');
    }
    return value
      .replace(/(?:[a-z][a-z0-9+.-]*:\/\/|(?:^|[\s(@])(?:[a-z]:)?[/\\])[^\s()<>"']+/gim, (path) => {
        const source = path.split(/[?#]/, 1)[0].split(/[/\\]/).pop();
        const position = /[?#]/.test(path) ? path.match(/:\d+:\d+$/)?.[0] || '' : '';
        const prefix = /^\s|^[( @]/.test(path) ? path[0] : '';
        return prefix + (/^[\w.-]+\.(?:[cm]?js|wasm|html)(?::\d+){0,2}$/i.test(source) ? source + position : '[경로]');
      })
      .replace(/(^|[\s(@])(?:[\w.-]+[/\\])+([-\w.]+\.(?:[cm]?js|wasm|html)(?::\d+){0,2})\b/gim, '$1$2')
      .replace(/\?[^\s)<>"']+/g, '[삭제]')
      .replace(/\b(?:s|id|sig|token|share_token|title|filename|document(?:Text)?|name)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s&#,;)]+)/gi, '[삭제]')
      .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, '[이메일]')
      .replace(/eyJ[\w.-]+|[a-f0-9]{32,}|(?<![\w-])[a-z0-9_-]{32,}(?![\w-])/gi, '[식별자]')
      .replace(/[^\s/\\:*?"<>|]+\.(?:docx?|xlsx?|pptx?|od[pts]|hwp[x]?|pdf|rtf|csv|txt)\b/gi, '[파일]')
      .slice(0, limit);
  }

  function report(kind, message, stack, details = {}, privateValues = []) {
    try {
      if (seen.size >= 20) return;
      const file = window.__edit?.file;
      const params = new URLSearchParams(location.search);
      const secrets = [...privateValues, file?.name, file?.name?.replace(/\.[^.]+$/, ''),
        file?.share?.token, params.get('s'), params.get('id')];
      const cleanMessage = scrub(message, 500, secrets) || '오류 메시지 없음';
      // 스택 첫 줄은 보통 메시지의 반복이다. 실제 프레임만 보낸다.
      const frames = typeof stack === 'string' ? stack.split('\n').filter((line) =>
        /^\s*at\s/.test(line) || /@.*:\d+(?::\d+)?\s*$/.test(line)) : [];
      const cleanStack = scrub(frames.join('\n'), 4000, secrets);
      const { line, col, method, route, status, request_id, errorCode } = details;
      const filename = scrub(details.filename, 200, secrets);
      const source = /^[-\w.]+\.(?:[cm]?js|wasm|html)$/i.test(filename) ? filename : undefined;
      const top = cleanStack.split('\n', 1)[0] || (source ? `${source}:${line}:${col}` : '');
      const key = JSON.stringify([kind, cleanMessage, top]);
      if (seen.has(key)) return;
      let uid;
      try {
        const id = JSON.parse(localStorage.getItem('rhwp.me') || 'null')?.id;
        if (localStorage.getItem('rhwp.token') && Number.isSafeInteger(id) && id > 0) uid = id;
      } catch {}
      seen.add(key);
      pending.push({
        ts: new Date().toISOString(), kind, message: cleanMessage, stack: cleanStack, page,
        fileType: fileTypes.includes(file?.type) ? file.type : undefined,
        ua: scrub(navigator.userAgent, 200, secrets), build: scrub(build, 100, secrets), sessionId, uid,
        filename: source, line, col, method, route, status, request_id, errorCode,
      });
    } catch { /* 오류 수집이 앱 동작에 영향을 주지 않게 한다. */ }
  }

  function flush() {
    while (pending.length) {
      const batch = [];
      let bytes = 2;
      while (pending.length) {
        const record = JSON.stringify(pending[0]);
        const size = encoder.encode(record).length;
        if (batch.length && bytes + size + 1 > 60 * 1024) break;
        bytes += size + 1;
        batch.push(record);
        pending.shift();
      }
      const body = `[${batch.join(',')}]`;
      // 문자열 비콘은 text/plain으로 전송돼 교차 출처 사전 요청이 필요 없다.
      try { if (navigator.sendBeacon?.(endpoint, body)) continue; } catch {}
      fetch(endpoint, { method: 'POST', body, keepalive: true }).catch(() => {});
    }
  }

  window.reportClientError = report;
  window.addEventListener('error', (event) => {
    const filename = event.filename?.split(/[?#]/, 1)[0].split(/[/\\]/).pop();
    report('js', event.message, event.error?.stack, {
      filename, line: event.lineno || undefined, col: event.colno || undefined,
    });
  });
  window.addEventListener('unhandledrejection', (event) => {
    report('promise', event.reason?.message ?? event.reason, event.reason?.stack);
  });
  setInterval(flush, 2000);
  window.addEventListener('pagehide', flush);
})();
