'use strict';
(function () {
  const $ = id => document.getElementById(id);
  const LIBRARY_URL = 'vendor/zxing-browser-0.1.5.min.js';
  const LIBRARY_INTEGRITY = 'sha384-ylLhng89kD62+PVK1cjm4rAYg69zDlGrbbSfAE2Eb8Xqf8RoAQCMcRoUXZh7pAPC';
  const params = new URLSearchParams(window.location.hash.slice(1));
  const relayUrlText = params.get('relayUrl') || '';
  const token = params.get('token') || '';
  let relayUrl = '';
  try {
    const u = new URL(relayUrlText);
    if (u.protocol === 'https:' && u.hostname === 'script.google.com' && /^\/macros\/s\/[^/]+\/exec$/.test(u.pathname)) relayUrl = u.href;
  } catch (_) {}
  const relayReady = !!relayUrl && /^[a-f0-9]{32}$/.test(token);
  let current = null, loading = null, readIsbn = '';
  function isbn13(value) {
    if (typeof value !== 'string' || !/^97[89]\d{10}$/.test(value)) return '';
    let sum = 0;
    for (let i = 0; i < 13; i++) sum += Number(value[i]) * (i % 2 ? 3 : 1);
    return sum % 10 ? '' : value;
  }
  function status(text) { $('status').textContent = text; }
  function stopTracks(stream) { if (stream) stream.getTracks().forEach(track => { try { track.stop(); } catch (_) {} }); }
  function stopControls(controls) {
    if (!controls) return;
    try { const result = controls.stop(); if (result && result.catch) result.catch(() => {}); } catch (_) {}
  }
  function stop() {
    const session = current; current = null;
    if (session) {
      session.cancelled = true; clearTimeout(session.timeout);
      stopControls(session.controls); stopTracks(session.stream);
      if (session.video) { try { session.video.pause(); session.video.srcObject = null; } catch (_) {} session.video.remove(); }
    }
    $('placeholder').hidden = false; $('start').disabled = !!readIsbn;
  }
  function failure(error, session) {
    if (current !== session) return;
    stop();
    let detail = '';
    if (error && (error.name === 'NotAllowedError' || error.name === 'SecurityError')) detail = 'カメラの許可を確認してください。';
    if (error && error.name === 'NotFoundError') detail = 'カメラが見つかりません。';
    if (error && error.name === 'NotReadableError') detail = '他のアプリでカメラが使用中でないか確認してください。';
    if (error && error.name === 'TimeoutError') detail = '時間切れのため停止しました。再試行できます。';
    status('ライブカメラを利用できません。' + detail + '画像から読み取るか、ISBNを手入力してください。');
  }
  function library() {
    if (window.ZXingBrowser && window.ZXingBrowser.BrowserMultiFormatOneDReader) return Promise.resolve(window.ZXingBrowser);
    if (loading) return loading;
    loading = new Promise((resolve, reject) => {
      const script = document.createElement('script'); let timeout;
      const fail = () => { clearTimeout(timeout); script.remove(); reject(new Error('decoder unavailable')); };
      script.src = LIBRARY_URL; script.integrity = LIBRARY_INTEGRITY; script.async = true;
      script.onload = () => { clearTimeout(timeout); if (window.ZXingBrowser && window.ZXingBrowser.BrowserMultiFormatOneDReader) resolve(window.ZXingBrowser); else fail(); };
      script.onerror = fail; timeout = setTimeout(fail, 12000); document.head.append(script);
    }).catch(error => { loading = null; throw error; });
    return loading;
  }
  function submitRelay(isbn) {
    if (!relayReady) return false;
    try {
      const form = document.createElement('form');
      form.method = 'POST';
      form.action = relayUrl;
      form.style.display = 'none';
      const fields = {
        action: 'liveScanRelay',
        token: token,
        isbn: isbn
      };
      Object.keys(fields).forEach(name => {
        const input = document.createElement('input');
        input.type = 'hidden';
        input.name = name;
        input.value = fields[name];
        form.appendChild(input);
      });
      document.body.appendChild(form);
      form.submit();
      return true;
    } catch (_) {
      return false;
    }
  }
  function accept(result, session, controls) {
    if (current !== session || session.cancelled || session.locked) { stopControls(controls); return; }
    const isbn = result && result.getBarcodeFormat() === window.ZXingBrowser.BarcodeFormat.EAN_13 ? isbn13(result.getText()) : '';
    if (!isbn) { status('ISBNバーコードではありません。978 / 979のバーコードを合わせてください。'); return; }
    session.locked = true; session.controls = controls || session.controls;
    stop();
    readIsbn = isbn; $('start').disabled = true;
    $('isbn-result').value = isbn; $('result').hidden = false; status('ISBNを読み取りました。カメラを停止しました。');
    if (!relayReady) {
      $('return-status').textContent = '本棚との中継を利用できません。ISBNをコピーして元の本棚へ戻ってください。';
      return;
    }
    $('return-status').textContent = '本棚へISBNを送信しています…';
    setTimeout(() => {
      if (!submitRelay(isbn)) $('return-status').textContent = '自動送信できませんでした。ISBNをコピーして元の本棚へ戻ってください。';
    }, 180);
  }
  async function start() {
    if (readIsbn || current) return;
    const session = { locked: false, cancelled: false, controls: null, stream: null, video: null, timeout: null };
    current = session; $('start').disabled = true; status('カメラ読み取りの準備中…');
    session.timeout = setTimeout(() => failure({ name: 'TimeoutError' }, session), 60000);
    try {
      if (window.top !== window.self || !window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw { name: 'SecurityError' };
      const lib = await library(); if (current !== session) return;
      let stream;
      try { stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } } }); }
      catch (error) {
        if (current !== session) return;
        if (error.name !== 'OverconstrainedError' && error.name !== 'NotFoundError') throw error;
        stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: true });
      }
      if (current !== session) { stopTracks(stream); return; }
      session.stream = stream;
      const video = document.createElement('video'); video.muted = true; video.autoplay = true; video.playsInline = true;
      session.video = video; $('preview').append(video); $('placeholder').hidden = true;
      stream.getVideoTracks().forEach(track => track.addEventListener('ended', () => failure({ name: 'NotReadableError' }, session), { once: true }));
      status('読み取り中… バーコードを枠内に合わせてください。');
      const reader = new lib.BrowserMultiFormatOneDReader(new Map([[2, [lib.BarcodeFormat.EAN_13]], [3, true]]), { delayBetweenScanAttempts: 180, delayBetweenScanSuccess: 400, tryPlayVideoTimeout: 5000 });
      const controls = await reader.decodeFromStream(stream, video, (result, error, controls) => {
        if (result) { try { accept(result, session, controls); } catch (error) { failure(error, session); } }
      });
      if (current !== session) { stopControls(controls); stopTracks(stream); return; }
      session.controls = controls;
    } catch (error) { failure(error, session); }
  }
  $('start').addEventListener('click', start);
  $('cancel').addEventListener('click', () => { stop(); status('スキャンを停止しました。元の本棚で画像読み取り・手入力も使えます。'); });
  $('return').addEventListener('click', () => {
    stop();
    status('元の「家族の本棚」タブへ戻ります…');
    try { window.close(); } catch (_) {}
    setTimeout(() => {
      if (!window.closed) status('このタブを閉じて、元の「家族の本棚」タブへ切り替えてください。');
    }, 350);
  });
  $('copy').addEventListener('click', async () => {
    if (!readIsbn) return;
    try { await navigator.clipboard.writeText(readIsbn); $('return-status').textContent = 'ISBNをコピーしました。元の本棚へ貼り付けてください。'; }
    catch (_) { $('isbn-result').focus(); $('isbn-result').select(); $('return-status').textContent = 'ISBNを選択しました。長押しなどでコピーしてください。'; }
  });
  window.addEventListener('pagehide', stop); window.addEventListener('beforeunload', stop);
  document.addEventListener('visibilitychange', () => { if (document.hidden && current) { stop(); status('カメラを停止しました。スキャン開始で再開できます。'); } });
  if (!relayReady) {
    $('return-status').textContent = '中継設定がないため、読み取り後はISBNコピーを利用できます。';
    status('本棚からライブスキャンを開いてください。スキャン自体は試せます。');
  } else {
    status('本棚との中継を準備できました。スキャン開始を押してください。');
  }
})();
