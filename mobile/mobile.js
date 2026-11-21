// BAGRENATION no Android (S-0057). Só existe dentro do APK (montar.mjs põe antes do app.js); no site não carrega.
// O app é o mesmo site; aqui fica só o que o WebView do Android não tem:
//  - getDisplayMedia: a tela vem do MediaProjection nativo (JPEG + som por um WebSocket local) e vira uma faixa WebRTC comum;
//  - voz com o app atrás (serviço em primeiro plano), avisos de mensagem, botão voltar, tela cheia deitada;
//  - aviso de versão nova com botão que baixa o APK da Release e abre o instalador.
(() => {
  const C = window.Capacitor;
  if (!C || !C.isNativePlatform || !C.isNativePlatform() || !C.Plugins || !C.Plugins.Bagre) return;
  const P = C.Plugins.Bagre;
  document.documentElement.classList.add('is-android');
  const num = (x, d) => (typeof x === 'number' ? x : x && (x.ideal || x.max || x.exact || x.min)) || d;
  const log = (...a) => console.info('BAGRE-ANDROID', ...a);

  // ---------- tela: getDisplayMedia de verdade no Android ----------
  let atual = null;
  async function getDisplayMedia(c = {}) {
    const v = c && typeof c.video === 'object' ? c.video : {};
    const fps = Math.min(30, num(v.frameRate, 30));
    let r;
    try {
      r = await P.shareStart({ w: num(v.width, 1280), h: num(v.height, 720), fps, audio: !!(c && c.audio) });
    } catch (err) {
      const msg = String((err && err.message) || err);
      throw new DOMException(msg, /cancel/i.test(msg) ? 'NotAllowedError' : 'NotReadableError');
    }
    if (atual) atual.fim(false);
    const stream = new MediaStream();
    const gen = typeof window.MediaStreamTrackGenerator === 'function';
    let video, writer, cv, ctx;
    if (gen) { // não depende da página estar visível: a tela segue com o app atrás (o jogo na frente)
      video = new window.MediaStreamTrackGenerator({ kind: 'video' });
      writer = video.writable.getWriter();
    } else {
      cv = document.createElement('canvas'); cv.width = r.w; cv.height = r.h;
      ctx = cv.getContext('2d', { alpha: false });
      video = cv.captureStream(fps).getVideoTracks()[0];
    }
    stream.addTrack(video);
    let ac = null, node = null, audio = null;
    if (r.audio) {
      try {
        ac = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
        await ac.audioWorklet.addModule('pcm-worklet.js?v=1354');
        node = new AudioWorkletNode(ac, 'pcm-in', { numberOfInputs: 0, outputChannelCount: [2] });
        const dest = ac.createMediaStreamDestination();
        dest.channelCount = 2;
        node.connect(dest);
        await ac.resume();
        audio = dest.stream.getAudioTracks()[0];
        stream.addTrack(audio);
      } catch (err) { log('som da tela não abriu', err); }
    }
    const ws = new WebSocket(`ws://127.0.0.1:${r.port}/?t=${encodeURIComponent(r.token)}`);
    ws.binaryType = 'arraybuffer';
    let busy = false, acabou = false, primeiro;
    const veio = new Promise((ok) => { primeiro = ok; });
    const s = {
      stream,
      fim(avisar) {
        if (acabou) return;
        acabou = true;
        if (atual === s) atual = null;
        try { ws.close(); } catch { /* fechado */ }
        if (writer) writer.close().catch(() => {});
        if (ac) ac.close().catch(() => {});
        P.shareStop().catch(() => {});
        if (avisar) for (const t of stream.getTracks()) { t.dispatchEvent(new Event('ended')); }
      },
    };
    for (const t of stream.getTracks()) { const st = t.stop.bind(t); t.stop = () => { st(); s.fim(false); }; }
    ws.onmessage = async (ev) => {
      const b = new Uint8Array(ev.data);
      if (b[0] === 2) { if (node) { const pcm = ev.data.slice(1); node.port.postMessage(pcm, [pcm]); } return; }
      if (b[0] !== 1 || busy || acabou) return;
      busy = true;
      try {
        const bmp = await createImageBitmap(new Blob([b.subarray(1)], { type: 'image/jpeg' }));
        if (gen) {
          const f = new VideoFrame(bmp, { timestamp: Math.round(performance.now() * 1000) });
          bmp.close();
          await writer.write(f);
        } else {
          if (cv.width !== bmp.width || cv.height !== bmp.height) { cv.width = bmp.width; cv.height = bmp.height; }
          ctx.drawImage(bmp, 0, 0); bmp.close();
        }
        primeiro();
      } catch (err) { log('quadro', err); }
      busy = false;
    };
    ws.onclose = () => { if (!acabou) s.fim(true); };
    atual = s;
    await Promise.race([veio, new Promise((ok) => setTimeout(ok, 4000))]);
    return stream;
  }
  if (navigator.mediaDevices) navigator.mediaDevices.getDisplayMedia = getDisplayMedia;
  P.addListener('shareEnded', () => { if (atual) atual.fim(true); });

  // ---------- o que o app.js chama (window.BAGRE_MOB) ----------
  const hooks = {};
  let lastCall = null;
  window.BAGRE_MOB = {
    hooks,
    callState(on, text) { // voz com o app atrás: liga/desliga o serviço em primeiro plano
      const k = `${on}|${text}`;
      if (k === lastCall) return;
      lastCall = k;
      P.callState({ on: !!on, text: text || 'Na voz' }).catch((err) => log('serviço da voz', err));
    },
    notify(body, title) { P.notify({ title: title || 'BAGRENATION', body }).catch(() => {}); },
    fullscreen(on, landscape) { P.fullscreen({ on: !!on, landscape: !!landscape }).catch(() => {}); },
    openUrl(url) { P.openUrl({ url }).catch(() => {}); },
    hidden: () => document.hidden,
  };
  P.addListener('sairVoz', () => hooks.leave && hooks.leave());
  P.addListener('pararTela', () => hooks.stopShare && hooks.stopShare());
  P.addListener('back', () => {
    const d = [...document.querySelectorAll('dialog[open]')].pop();
    if (d) { d.close(); return; }
    if (hooks.back && hooks.back()) return;
    P.toBack().catch(() => {});
  });
  // aviso de mensagem e fone Bluetooth: pede no 1º toque (o Android 13+ só mostra o pedido com o app na frente)
  const pedir = () => { document.removeEventListener('pointerup', pedir, true); P.permissoes().catch(() => {}); };
  if (!localStorage.getItem('bagre:perm')) { localStorage.setItem('bagre:perm', '1'); document.addEventListener('pointerup', pedir, true); }
  // links de fora abrem no navegador (no WebView um target=_blank não abre nada)
  document.addEventListener('click', (ev) => {
    const a = ev.target.closest && ev.target.closest('a[href^="http"]');
    if (a && !a.href.startsWith(location.origin)) { ev.preventDefault(); P.openUrl({ url: a.href }).catch(() => {}); }
  });

  // ---------- versão nova: aviso + botão que baixa e abre o instalador ----------
  const cmp = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); } return 0; };
  let meu = '';
  let barra = null;
  function css() {
    const st = document.createElement('style');
    st.textContent = `
.upd { position: fixed; left: 12px; right: 12px; bottom: calc(12px + env(safe-area-inset-bottom)); z-index: 90; display: flex; align-items: center; gap: 12px;
  padding: 12px 12px 12px 14px; background: var(--panel, #0d0a1c); border: var(--u, 3px) solid var(--cyan, #00f0ff);
  box-shadow: 0 calc(var(--u, 3px) * 2) 0 #00f0ff55, 0 12px 30px #000c; animation: rise .25s steps(4); }
.upd p { flex: 1; margin: 0; color: var(--text, #f4f0ff); font: 400 22px/1 var(--term, monospace); }
.upd p b { display: block; margin-bottom: 6px; color: var(--cyan, #00f0ff); font: 400 10px/1.3 var(--pix, monospace); text-transform: uppercase; }
.upd .btn { flex: none; min-height: 46px; }
.upd .upd-go { --fr: var(--fr-yellow); --sh: #8a7a00; color: var(--ink, #07040f); }
.upd .upd-x { min-width: 46px; padding: 0; }
.upd .upd-bar { position: absolute; left: 0; bottom: 0; height: var(--u, 3px); background: var(--yel, #ffe600); width: 0; }`;
    document.head.appendChild(st);
  }
  function mostrar(r) {
    if (barra) barra.remove();
    if (!document.querySelector('style[data-upd]')) { css(); document.head.lastChild.dataset.upd = '1'; }
    barra = document.createElement('div');
    barra.className = 'upd';
    barra.setAttribute('role', 'status');
    const nova = r.tag.replace(/^v/, '');
    barra.innerHTML = `<p><b>Versão nova</b><span class="upd-txt">BAGRENATION ${nova} (você está na ${meu})</span></p>
      <button class="btn upd-go" type="button">Atualizar</button><button class="btn upd-x" type="button" aria-label="Agora não">✕</button><i class="upd-bar"></i>`;
    document.body.appendChild(barra);
    const txt = barra.querySelector('.upd-txt'), go = barra.querySelector('.upd-go'), bar = barra.querySelector('.upd-bar');
    barra.querySelector('.upd-x').onclick = () => { sessionStorage.setItem('bagre:updx', r.tag); barra.remove(); barra = null; };
    go.onclick = async () => {
      go.disabled = true; txt.textContent = 'Baixando…';
      const h = await P.addListener('apkProgress', ({ p }) => { bar.style.width = `${Math.round(p * 100)}%`; txt.textContent = `Baixando… ${Math.round(p * 100)}%`; });
      try {
        const res = await P.installApk({ url: r.apk, tag: r.tag });
        bar.style.width = '100%';
        txt.textContent = res && res.liberar ? 'Libere "Permitir desta fonte" e toque em Atualizar de novo' : 'Toque em Atualizar no instalador do Android';
      } catch (err) {
        txt.textContent = `Não baixou (${(err && err.message) || err}). Tente de novo.`;
      }
      h.remove();
      go.disabled = false;
    };
  }
  let checado = 0;
  async function checar() {
    if (Date.now() - checado < 6 * 3600 * 1000) return;
    checado = Date.now();
    try {
      if (!meu) meu = (await P.info()).version;
      const r = await P.latest();
      const nova = (r.tag || '').replace(/^v/, '');
      log('versão', meu, 'release', nova, r.apk ? 'com APK' : 'sem APK');
      if (r.apk && /^\d+\.\d+\.\d+$/.test(nova) && cmp(nova, meu) > 0 && sessionStorage.getItem('bagre:updx') !== r.tag) mostrar(r);
    } catch (err) { checado = Date.now() - 5.5 * 3600 * 1000; log('update', err); } // sem rede: tenta de novo em 30 min
  }
  window.addEventListener('load', () => setTimeout(checar, 2500));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checar(); });
})();
