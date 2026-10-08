'use strict';
(function () {
  const $ = id => document.getElementById(id);
  const LIBRARY_URL = 'vendor/zxing-browser-0.1.5.min.js';
  const LIBRARY_INTEGRITY = 'sha384-ylLhng89kD62+PVK1cjm4rAYg69zDlGrbbSfAE2Eb8Xqf8RoAQCMcRoUXZh7pAPC';
  const params = new URLSearchParams(window.location.hash.slice(1));
  const returnOrigin = params.get('returnOrigin') || '', nonce = params.get('nonce') || '';
  const config = window.FAMILY_SCANNER_CONFIG || {};
  const allowed = Array.isArray(config.allowedLibraryOrigins) ? config.allowedLibraryOrigins : [];
  let validOrigin = false;
  let gasOrigin = false;
  try {
    const u = new URL(returnOrigin);
    gasOrigin = /^n-[a-z0-9-]+-script\.googleusercontent\.com$/i.test(u.hostname);
    validOrigin = u.protocol === 'https:' && u.origin === returnOrigin && (allowed.includes(returnOrigin) || gasOrigin);
  } catch (_) {}
  const sessionIsValid = validOrigin && /^[a-f0-9]{32}$/.test(nonce);
  let returnPort = null;
  const canReturnNow = () => sessionIsValid && (!!returnPort || !!window.opener);
  let current = null, loading = null, readIsbn = '', sent = false, acked = false;
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
  function sendToLibrary(message) {
    if (!sessionIsValid) return false;
    if (returnPort) {
      try { returnPort.postMessage(message); return true; } catch (_) { try { returnPort.close(); } catch (_) {} returnPort = null; }
    }
    if (window.opener) {
      try { window.opener.postMessage(message, returnOrigin); return true; } catch (_) {}
    }
    return false;
  }
  function handleControl(data) {
    if (!data || typeof data !== 'object' || data.nonce !== nonce) return;
    if (data.type === 'family-library-isbn-scan-cancel') {
      stop(); $('start').disabled = true; status('本棚側でスキャンを終了しました。元のタブへ戻ってください。');
      return;
    }
    if (data.type === 'family-library-isbn-scan-ack' && sent && !acked) {
      acked = true; $('return-status').textContent = '本棚でISBNを受信しました。元の本棚タブへ戻ります。';
      try { window.close(); } catch (_) {}
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
    sent = sendToLibrary({ type: 'family-library-isbn-scan', isbn, nonce });
    if (!sent) {
      $('return-status').textContent = '本棚への自動送信を利用できません。ISBNをコピーして元の本棚へ戻ってください。';
      return;
    }
    $('return-status').textContent = '本棚へ送信しました。受信確認を待っています。';
    setTimeout(() => { if (!acked) $('return-status').textContent = '受信確認がありません。元の本棚タブを確認し、必要ならISBNをコピーして入力してください。'; }, 3000);
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
  window.addEventListener('message', event => {
    if (!sessionIsValid || event.origin !== returnOrigin || !event.data || event.data.nonce !== nonce) return;
    if (event.data.type === 'family-library-isbn-channel' && event.ports && event.ports[0]) {
      const port = event.ports[0];
      if (returnPort) { try { returnPort.close(); } catch (_) {} }
      returnPort = port;
      returnPort.onmessage = portEvent => handleControl(portEvent.data);
      if (returnPort.start) returnPort.start();
      try { returnPort.postMessage({ type: 'family-library-isbn-channel-ready', nonce }); } catch (_) {}
      status('本棚と接続しました。スキャン開始を押してください。');
      return;
    }
    if (event.source !== window.opener) return;
    handleControl(event.data);
  });
  $('start').addEventListener('click', start);
  $('cancel').addEventListener('click', () => { stop(); status('スキャンを停止しました。元の本棚で画像読み取り・手入力も使えます。'); });
  $('return').addEventListener('click', () => {
    stop();
    if (canReturnNow()) { try { if (window.opener) window.opener.focus(); window.close(); return; } catch (_) {} }
    status('元の本棚タブへ手動で切り替えてください。再読み込みは不要です。');
  });
  $('copy').addEventListener('click', async () => {
    if (!readIsbn) return;
    try { await navigator.clipboard.writeText(readIsbn); $('return-status').textContent = 'ISBNをコピーしました。元の本棚へ貼り付けてください。'; }
    catch (_) { $('isbn-result').focus(); $('isbn-result').select(); $('return-status').textContent = 'ISBNを選択しました。長押しなどでコピーしてください。'; }
  });
  window.addEventListener('pagehide', stop); window.addEventListener('beforeunload', stop);
  document.addEventListener('visibilitychange', () => { if (document.hidden && current) { stop(); status('カメラを停止しました。スキャン開始で再開できます。'); } });
  if (!sessionIsValid) {
    $('return-status').textContent = '自動送信を利用できない場合は、読み取り後にISBNをコピーして本棚へ戻れます。';
    if (!returnOrigin) status('本棚からライブスキャンを開いてください。スキャン自体は試せます。');
    else if (!validOrigin) status('接続元を確認できません。接続元: ' + returnOrigin + '　スキャン自体は試せます。');
    else status('接続用トークンを確認できません。本棚からライブスキャンを開き直してください。');
  } else {
    setTimeout(() => {
      if (!returnPort && !window.opener) status('本棚との直接接続を確認できません。スキャン後はISBNコピーも利用できます。');
    }, 1800);
  }
})();
