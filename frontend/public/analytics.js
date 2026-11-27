(() => {
  if ('nativeBridge' in window || 'AndroidBridge' in window) return;
  if (!['www.myoffice.p-e.kr', 'www.rhwp.p-e.kr'].includes(location.hostname)) return;

  window.dataLayer = window.dataLayer || [];
  function gtag() { window.dataLayer.push(arguments); }

  // 파일 ID, 공유 토큰, 문서 제목을 분석 데이터에서 제외한다.
  gtag('set', {
    page_location: location.origin + location.pathname,
    page_referrer: document.referrer.split(/[?#]/, 1)[0],
    page_title: 'myoffice',
  });
  gtag('js', new Date());

  const script = document.createElement('script');
  script.async = true;
  script.referrerPolicy = 'no-referrer';
  script.src = 'https://www.googletagmanager.com/gtm.js?id=GTM-M8WP3GCZ';
  document.head.appendChild(script);
})();
