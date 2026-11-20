/* Bagre DJ (S-1566): player oficial do YouTube (IFrame Player API) controlado pelo BAGRENATION por postMessage.
 * Só toca o vídeo embutido, do jeito que o YouTube permite: nada de baixar ou separar o áudio.
 * Ordens (do app/site):  { bp: 1, op: 'load', id, at, play } · 'play' · 'pause' · { op: 'seek', at } · { op: 'vol', v, m } · 'stop' · { op: 'list', list }
 * Avisos (para o app):   { bp: 1, ev: 'ready' } · { ev: 'tick', st, t, d, id, ts } (a cada 250 ms e a cada mudança) · { ev: 'error', code, id } · { ev: 'list', list, ids }
 */
(() => {
  'use strict';
  const OK = [/^https:\/\/alissonlittig\.github\.io$/, /^https?:\/\/tauri\.localhost$/, /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/];
  let parentOrigin = '';
  let yt = null;
  let ready = false;
  let pending = [];
  let vid = '';
  let vol = { v: 70, m: false };

  const tell = (msg) => { if (parentOrigin) parent.postMessage({ bp: 1, ...msg }, parentOrigin); };
  const tick = () => {
    if (!ready) return;
    let t = 0, d = 0, st = -1;
    try { t = yt.getCurrentTime() || 0; d = yt.getDuration() || 0; st = yt.getPlayerState(); } catch { /* player trocando de vídeo */ }
    tell({ ev: 'tick', st, t, d, id: vid, ts: Date.now(), m: yt.isMuted(), v: yt.getVolume() });
  };
  const applyVol = () => { if (!ready) return; yt.setVolume(vol.v); if (vol.m) yt.mute(); else yt.unMute(); };

  function run(d) {
    if (!ready) { pending.push(d); return; }
    if (d.op === 'load' && /^[A-Za-z0-9_-]{11}$/.test(d.id)) {
      const at = Math.max(0, Number(d.at) || 0);
      if (d.id === vid) { yt.seekTo(at, true); if (d.play) yt.playVideo(); else yt.pauseVideo(); }
      else {
        vid = d.id;
        if (d.play) yt.loadVideoById({ videoId: d.id, startSeconds: at }); else yt.cueVideoById({ videoId: d.id, startSeconds: at });
      }
      applyVol();
    } else if (d.op === 'play') yt.playVideo();
    else if (d.op === 'pause') yt.pauseVideo();
    else if (d.op === 'seek') yt.seekTo(Math.max(0, Number(d.at) || 0), true);
    else if (d.op === 'vol') { vol = { v: Math.max(0, Math.min(100, Math.round(Number(d.v)))) || 0, m: d.m === true }; applyVol(); }
    else if (d.op === 'stop') { vid = ''; yt.stopVideo(); }
    else if (d.op === 'list' && /^[A-Za-z0-9_-]{10,64}$/.test(d.list)) { // só lista os vídeos de uma playlist (iframe à parte, sem tocar)
      yt.cuePlaylist({ listType: 'playlist', list: d.list });
      const t0 = Date.now();
      const poll = setInterval(() => {
        const ids = (yt.getPlaylist && yt.getPlaylist()) || [];
        if (ids.length || Date.now() - t0 > 10000) { clearInterval(poll); tell({ ev: 'list', list: d.list, ids: ids.slice(0, 200) }); }
      }, 300);
    }
    tick();
  }

  window.addEventListener('message', (ev) => {
    if (ev.source !== parent || !OK.some((re) => re.test(ev.origin))) return;
    const d = ev.data;
    if (!d || d.bp !== 1 || typeof d.op !== 'string') return;
    if (!parentOrigin) { parentOrigin = ev.origin; if (ready) tell({ ev: 'ready' }); }
    if (ev.origin !== parentOrigin) return;
    if (d.op !== 'hello') run(d);
  });

  window.onYouTubeIframeAPIReady = () => {
    yt = new YT.Player('yt', {
      width: '100%', height: '100%',
      host: 'https://www.youtube.com',
      playerVars: { autoplay: 1, controls: 0, disablekb: 1, playsinline: 1, rel: 0, iv_load_policy: 3, fs: 0, origin: location.origin, widget_referrer: location.href },
      events: {
        onReady: () => { ready = true; applyVol(); tell({ ev: 'ready' }); const p = pending; pending = []; p.forEach(run); },
        onStateChange: tick,
        onError: (e) => tell({ ev: 'error', code: Number(e.data) || 0, id: vid }),
      },
    });
  };
  setInterval(tick, 250);
  const s = document.createElement('script');
  s.src = 'https://www.youtube.com/iframe_api';
  document.head.append(s);
})();
