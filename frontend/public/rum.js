(() => {
  if (!['www.myoffice.p-e.kr', 'www.rhwp.p-e.kr'].includes(location.hostname)) return;
  if (!navigator.sendBeacon || !performance.getEntriesByType) return;

  const API_BASE = location.hostname.startsWith('www.') ? `https://api.${location.hostname.slice(4)}` : '';
  const page = /^\/edit(?:\.html)?$/.test(location.pathname) ? 'edit' : 'home';
  const fileTypes = ['word', 'cell', 'slide', 'hwp', 'pdf'];
  const sent = new WeakSet();
  const fonts = /\.(?:ttf|otf|woff2?)(?:\.br)?$/i;
  performance.setResourceTimingBufferSize?.(1000);

  function kindOf(url) {
    const path = url.pathname;
    if (url.origin === API_BASE || (url.origin === location.origin && path.startsWith('/api/'))) return 'api';
    if (url.origin === location.origin) {
      if (path.startsWith('/rhwp/')) {
        if (/\.wasm(?:\.br)?$/i.test(path)) return 'rhwp-wasm';
        return fonts.test(path) ? 'rhwp-font' : 'rhwp-other';
      }
      if (path.startsWith('/office/')) {
        if (fonts.test(path)) return 'oo-font';
        return /\.(?:js|css|html)$/i.test(path) ? 'oo-sdk' : 'oo-other';
      }
      if (/\.(?:js|css)$/i.test(path)) return 'app';
    }
    if (/(^|\.)(?:google-analytics\.com|googletagmanager\.com|google\.com)$/.test(url.hostname)) return 'analytics';
    return 'other';
  }

  function* entries(frame) {
    let perf, childFrames;
    try {
      perf = frame.performance;
      childFrames = frame.frames;
    } catch {
      return;
    }
    // 프레임 문서 자체는 부모의 리소스 목록에 있고, 내부 리소스는 각 프레임에서 읽는다.
    if (frame === window) yield* perf.getEntriesByType('navigation');
    yield* perf.getEntriesByType('resource');
    for (let i = 0; i < childFrames.length; i++) yield* entries(childFrames[i]);
  }

  const boundedInt = (value, limit) => Math.min(limit, Math.max(0, Math.round(value || 0)));

  function collect() {
    const groups = {};
    const batch = [];
    for (const entry of entries(window)) {
      if (sent.has(entry) || !entry.responseEnd) continue;
      const url = new URL(entry.name, location.href);
      if (url.origin === API_BASE && url.pathname === '/api/rum') continue;
      const kind = entry.entryType === 'navigation' ? 'page' : kindOf(url);
      const tls = entry.secureConnectionStart > 0 ? entry.connectEnd - entry.secureConnectionStart : 0;
      // 교차 출처에서 상세 시간이 가려지면 0ms로 집계하지 않는다.
      const segments = entry.responseStart > 0 ? [
        entry.domainLookupEnd - entry.domainLookupStart,
        entry.connectEnd - entry.connectStart - tls,
        tls,
        entry.responseStart - entry.requestStart,
        entry.responseEnd - entry.responseStart,
      ].map(value => boundedInt(value, 120000)) : [null, null, null, null, null];
      const transfer = boundedInt(entry.transferSize, 500000000);
      const encoded = boundedInt(entry.encodedBodySize, 500000000);
      // 순서: DNS, TCP, TLS, TTFB, 다운로드, 전체(ms), 전송/본문(바이트), 캐시 적중
      const sample = [...segments, boundedInt(entry.duration, 120000), transfer, encoded, transfer === 0 && encoded > 0];
      const group = groups[kind] ??= { count: 0, sums: Array(8).fill(0), samples: [] };
      group.count++;
      group.sums.forEach((sum, index) => { group.sums[index] = sum + (sample[index] ?? 0); });
      group.samples.push(sample);
      batch.push(entry);
      if (batch.length === 200) break;
    }
    if (!batch.length) return;
    const payload = { page, groups };
    const fileType = page === 'edit' ? window.__edit?.file?.type : undefined;
    if (fileTypes.includes(fileType)) payload.fileType = fileType;
    // 문자열 본문은 text/plain으로 전송되어 별도 CORS 사전 요청이 필요 없다.
    if (navigator.sendBeacon(`${API_BASE}/api/rum`, JSON.stringify(payload))) {
      batch.forEach(entry => sent.add(entry));
    }
  }

  const schedule = () => setTimeout(collect, 20000);
  if (document.readyState === 'complete') schedule();
  else window.addEventListener('load', schedule, { once: true });
  // 숨김 직후 pagehide가 이어져도 같은 시점에 두 번째 배치를 보내지 않는다.
  let flushedOnHide = false;
  document.addEventListener('visibilitychange', () => {
    flushedOnHide = document.visibilityState === 'hidden';
    if (flushedOnHide) collect();
  });
  window.addEventListener('pagehide', () => {
    if (!flushedOnHide) collect();
  });
})();
