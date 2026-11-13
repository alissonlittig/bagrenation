/* Telão — compartilhamento de tela ponto a ponto (WebRTC).
 *
 * Como funciona:
 *  - Cada pessoa é um "membro" com um ID próprio no servidor público de sinalização do PeerJS.
 *  - A sala tem um ID fixo de "diretório" (telao-<código>-dir). Quem chega tenta falar com ele;
 *    se ninguém responde, assume o papel. O diretório só distribui a lista de membros.
 *    Se quem o mantinha sai, outro membro assume: o link da sala nunca morre.
 *  - Os membros se conectam todos entre si (malha) por canal de dados; quem transmite
 *    abre uma chamada de mídia para cada um. Vídeo e áudio nunca passam por servidor.
 */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // sem 0/o, 1/l/i
  const CODE_RE = new RegExp(`^[${ALPHABET}]{10}$`);
  const QUALITY = {
    '720p30': { w: 1280, h: 720, fps: 30, bitrate: 3_000_000 },
    '1080p30': { w: 1920, h: 1080, fps: 30, bitrate: 6_000_000 },
    '1080p60': { w: 1920, h: 1080, fps: 60, bitrate: 10_000_000 },
    '1440p60': { w: 2560, h: 1440, fps: 60, bitrate: 16_000_000 },
  };
  // shortcut: só STUN (não existe TURN grátis sem conta); redes com NAT simétrico/CGNAT dos dois
  // lados não conectam. Para resolver, adicionar aqui um servidor TURN próprio.
  const ICE = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
    { urls: 'stun:stun.cloudflare.com:3478' },
  ];
  const PEER_OPTS = { debug: 0, config: { iceServers: ICE } };
  const CONN_OPTS = { reliable: true, serialization: 'json' };
  const CAN_SHARE = !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);

  // ---------- estado ----------
  let room = null;          // código da sala (10 caracteres)
  let myId = null;
  let peer = null;          // meu Peer de membro
  let dirPeer = null;       // Peer do diretório, se eu for o responsável
  let dirConn = null;       // minha conexão com o diretório
  let dirSeen = 0;
  const dirMembers = new Map(); // (só diretório) id -> { c, seen }
  let known = [];           // ids informados pelo diretório
  const peers = new Map();  // id -> entrada do membro remoto
  let local = null;         // { stream, tile } enquanto transmito
  let audioMuted = false;
  let leaving = false;
  let everOk = false;
  let backoff = 0;
  let retryTimer = 0;
  let wakeLock = null;
  let myName = clean(store('name')) || `Visitante ${100 + Math.floor(Math.random() * 900)}`;

  // ---------- utilidades ----------
  function store(key, value) {
    try {
      if (value === undefined) return localStorage.getItem(`telao:${key}`);
      localStorage.setItem(`telao:${key}`, value);
    } catch { /* armazenamento bloqueado: segue sem lembrar */ }
    return null;
  }
  function clean(s, max = 24) {
    return String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
  }
  function randomCode(n) {
    let out = '';
    const buf = new Uint8Array(1);
    while (out.length < n) {
      crypto.getRandomValues(buf);
      if (buf[0] < 248) out += ALPHABET[buf[0] % 31]; // 248 = 31*8, sem viés
    }
    return out;
  }
  function parseCode(text) {
    const raw = String(text || '').toLowerCase();
    const code = raw.slice(raw.lastIndexOf('#') + 1).replace(/[^a-z0-9]/g, '');
    return CODE_RE.test(code) ? code : null;
  }
  const pretty = (code) => `${code.slice(0, 5)}-${code.slice(5)}`;
  const dirId = () => `telao-${room}-dir`;
  const isMember = (id) => typeof id === 'string' && id.startsWith(`telao-${room}-m-`) && id.length < 64;
  const setIcon = (use, name) => use.setAttribute('href', `#i-${name}`);

  function toast(msg, ms = 3200) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = msg;
    $('toasts').append(el);
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 320); }, ms);
  }

  // ---------- status de conexão ----------
  function refreshStatus() {
    if (!room) return;
    let state = everOk ? 'reconnecting' : 'connecting';
    if (!navigator.onLine) state = 'offline';
    else if (peer && peer.open && dirConn && dirConn.open) { state = 'ok'; everOk = true; }
    $('status').dataset.state = state;
    $('statusText').textContent = { connecting: 'Conectando', ok: 'Conectado', reconnecting: 'Reconectando', offline: 'Sem internet' }[state];
  }
  function schedule(fn) {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(fn, Math.min(1000 * 2 ** backoff++, 15000));
  }

  // ---------- sinalização: meu Peer ----------
  function connect() {
    if (leaving || !room) return;
    clearTimeout(retryTimer);
    myId = `telao-${room}-m-${randomCode(8)}`;
    const p = peer = new Peer(myId, PEER_OPTS);
    p.on('open', () => { backoff = 0; joinDirectory(); refreshStatus(); });
    p.on('connection', wire);
    p.on('call', onCall);
    p.on('disconnected', () => {
      if (peer !== p || leaving) return;
      refreshStatus();
      schedule(() => { if (peer === p && !p.destroyed && p.disconnected) p.reconnect(); });
    });
    p.on('close', () => { // Peer destruído (erro fatal): recomeça com ID novo; a transmissão local é mantida
      if (peer !== p || leaving) return;
      peer = null;
      resetMesh();
      refreshStatus();
      schedule(connect);
    });
    p.on('error', (err) => {
      if (peer !== p) return;
      if (err.type === 'peer-unavailable') {
        const target = (String(err.message).match(/peer (\S+)$/) || [])[1];
        if (target === dirId()) {
          if (dirConn && !dirConn.open) { const c = dirConn; dirConn = null; c.close(); }
          claimDirectory();
        } else if (target) dropPeer(target, true);
      } else if (err.type === 'browser-incompatible') {
        toast('Este navegador não tem o WebRTC necessário para o Telão.', 8000);
      }
    });
  }

  // ---------- diretório da sala ----------
  function joinDirectory() {
    if (leaving || !peer || !peer.open || dirConn) return;
    const c = dirConn = peer.connect(dirId(), CONN_OPTS);
    // O PeerJS não emite 'close' para conexão que nunca abriu: desisto e tento de novo por conta própria.
    const giveUp = setTimeout(() => { if (dirConn === c && !c.open) { dirConn = null; c.close(); joinDirectory(); } }, 8000);
    c.on('open', () => { clearTimeout(giveUp); dirSeen = Date.now(); refreshStatus(); });
    c.on('data', (d) => {
      if (dirConn !== c || !d || d.t !== 'peers' || !Array.isArray(d.ids)) return;
      dirSeen = Date.now();
      known = d.ids.filter(isMember).slice(0, 64);
      heal();
    });
    c.on('close', () => {
      clearTimeout(giveUp);
      if (dirConn !== c) return;
      dirConn = null;
      refreshStatus();
      // espera aleatória: se o responsável saiu, evita todos disputarem o papel no mesmo instante
      if (!leaving) setTimeout(joinDirectory, 300 + Math.random() * 1200);
    });
    c.on('error', () => {});
  }

  function claimDirectory() {
    if (dirPeer || leaving || !room) return;
    const d = dirPeer = new Peer(dirId(), PEER_OPTS);
    d.on('open', joinDirectory);
    d.on('connection', (c) => {
      c.on('open', () => {
        if (!isMember(c.peer)) { c.close(); return; }
        dirMembers.set(c.peer, { c, seen: Date.now() });
        broadcastDirectory();
      });
      c.on('data', () => { const m = dirMembers.get(c.peer); if (m && m.c === c) m.seen = Date.now(); });
      c.on('close', () => {
        const m = dirMembers.get(c.peer);
        if (m && m.c === c) { dirMembers.delete(c.peer); broadcastDirectory(); }
      });
      c.on('error', () => {});
    });
    d.on('disconnected', () => {
      setTimeout(() => { if (dirPeer === d && !d.destroyed && d.disconnected) d.reconnect(); }, 2000);
    });
    d.on('close', () => { // ID já tem dono (ou caiu): volto a ser só membro
      if (dirPeer !== d) return;
      dirPeer = null;
      dirMembers.clear();
      if (!leaving) setTimeout(joinDirectory, 400 + Math.random() * 800);
    });
    d.on('error', () => {});
  }

  function broadcastDirectory() {
    const ids = [...dirMembers.keys()];
    for (const { c } of dirMembers.values()) if (c.open) c.send({ t: 'peers', ids });
  }

  // ---------- malha entre membros ----------
  // Entre dois membros, quem tem o maior ID inicia a conexão: nunca há conexão duplicada.
  function heal() {
    if (!peer || !peer.open) return;
    for (const id of known) {
      if (id !== myId && !peers.has(id) && myId > id) wire(peer.connect(id, CONN_OPTS));
    }
  }

  function wire(c) {
    const id = c.peer;
    if (!isMember(id) || id === myId) { c.on('open', () => c.close()); return; }
    let e = peers.get(id);
    if (!e) {
      e = { id, name: 'Convidado', named: false, ready: false, born: Date.now(), seen: Date.now(),
        conn: null, sharing: false, call: null, out: null, tile: null,
        volume: 1, muted: false, blocked: false, wanted: 0, fails: 0, chatAt: 0, bytes: 0, bytesAt: 0 };
      peers.set(id, e);
    }
    const old = e.conn;
    e.conn = c;
    if (old) old.close();
    c.on('open', () => {
      if (e.conn !== c) return;
      e.ready = true; e.seen = Date.now();
      c.send(hello());
      if (local) callPeer(e);
      renderPeople();
    });
    c.on('data', (d) => { if (e.conn === c) onData(e, d); });
    c.on('close', () => { if (e.conn === c) dropPeer(id); });
    c.on('error', () => {});
  }

  const hello = () => ({ t: 'hello', name: myName, sharing: !!local });
  function send(e, msg) { if (e.conn && e.conn.open) e.conn.send(msg); }
  function broadcast(msg) { for (const e of peers.values()) send(e, msg); }

  function onData(e, d) {
    if (!d || typeof d !== 'object') return;
    e.seen = Date.now();
    if (d.t === 'hello') {
      const first = !e.named;
      e.name = clean(d.name) || 'Convidado';
      e.named = true;
      e.sharing = d.sharing === true;
      if (first) { note(`${e.name} entrou`); e.wanted = Date.now(); }
      if (!e.sharing) removeStream(e);
      if (e.tile) e.tile.setName(e.name);
      renderPeople();
    } else if (d.t === 'chat') {
      const now = Date.now();
      if (now - e.chatAt < 250) return; // no máximo 4 mensagens por segundo por pessoa
      e.chatAt = now;
      const text = clean(d.text, 500);
      if (text) addChat(e.name, text);
    } else if (d.t === 'want') {
      if (local) callPeer(e);
    } else if (d.t === 'bye') {
      dropPeer(e.id);
    }
  }

  function dropPeer(id, silent) {
    const e = peers.get(id);
    if (!e) return;
    peers.delete(id);
    const c = e.conn; e.conn = null;
    if (c) c.close();
    if (e.out) e.out.close();
    removeStream(e);
    if (e.named && !silent && !leaving) note(`${e.name} saiu`);
    renderPeople();
  }

  function resetMesh() {
    for (const id of [...peers.keys()]) dropPeer(id, true);
    known = [];
    if (dirConn) { const c = dirConn; dirConn = null; c.close(); }
    if (dirPeer) { const d = dirPeer; dirPeer = null; dirMembers.clear(); d.destroy(); }
  }

  // ---------- mídia: enviar ----------
  // Ajustes na negociação (SDP), só nas chamadas do Telão:
  //  - Opus estéreo a 256 kb/s (o padrão do navegador é mono ~32 kb/s, feito para voz);
  //  - vídeo já começa em 3 Mb/s. Sem isso o Chrome parte de 0,3 Mb/s, escolhe 480×270 e leva
  //    ~30 s subindo a resolução em degraus (medido com captura real de monitor).
  function hifi(sdp) {
    sdp = sdp.replace(/(a=fmtp:\d+ [^\r\n]*useinbandfec=1)(?![^\r\n]*stereo=1)/g,
      '$1;stereo=1;sprop-stereo=1;maxaveragebitrate=256000');
    for (const [, pt] of sdp.matchAll(/a=rtpmap:(\d+) (?:VP8|VP9|H264|AV1)\/90000/g)) {
      const fmtp = new RegExp(`a=fmtp:${pt} [^\r\n]*`);
      sdp = fmtp.test(sdp)
        ? sdp.replace(fmtp, '$&;x-google-start-bitrate=3000')
        : sdp.replace(new RegExp(`a=rtpmap:${pt} [^\r\n]*\r\n`), `$&a=fmtp:${pt} x-google-start-bitrate=3000\r\n`);
    }
    return sdp;
  }

  function callPeer(e) {
    if (!local || !peer || !peer.open || !e.conn || !e.conn.open) return;
    if (e.out) e.out.close();
    const call = peer.call(e.id, local.stream, { sdpTransform: hifi });
    if (!call) return;
    e.out = call;
    const pc = call.peerConnection;
    pc.addEventListener('connectionstatechange', () => { if (pc.connectionState === 'connected') tune(pc); });
    call.on('close', () => { if (e.out === call) e.out = null; });
    call.on('error', () => {});
  }

  // Limites de envio aplicados depois da negociação (antes disso o navegador recusa).
  function tune(pc) {
    const q = QUALITY[$('quality').value];
    const motion = $('hint').value === 'motion';
    for (const sender of pc.getSenders()) {
      if (!sender.track) continue;
      const params = sender.getParameters();
      if (!params.encodings || !params.encodings.length) continue;
      if (sender.track.kind === 'video') {
        params.encodings[0].maxBitrate = q.bitrate;
        params.encodings[0].maxFramerate = q.fps;
        params.degradationPreference = motion ? 'maintain-framerate' : 'maintain-resolution';
      } else {
        params.encodings[0].maxBitrate = 256_000;
      }
      sender.setParameters(params).catch((err) => console.warn('Telão: limite de envio não aplicado', err));
    }
  }

  function applyQuality() {
    store('quality', $('quality').value);
    store('hint', $('hint').value);
    if (!local) return;
    const q = QUALITY[$('quality').value];
    const track = local.stream.getVideoTracks()[0];
    track.contentHint = $('hint').value;
    track.applyConstraints({ width: { max: q.w }, height: { max: q.h }, frameRate: { max: q.fps } }).catch(() => {});
    for (const e of peers.values()) if (e.out && e.out.peerConnection) tune(e.out.peerConnection);
  }

  async function capture() {
    const q = QUALITY[$('quality').value];
    try {
      return await navigator.mediaDevices.getDisplayMedia({
        video: { width: { max: q.w }, height: { max: q.h }, frameRate: { ideal: q.fps, max: q.fps } },
        // áudio de jogo/vídeo: sem os filtros de voz, que abafam música e efeitos
        // restrictOwnAudio: ao capturar o som do sistema, deixa de fora o que o próprio Telão está tocando (evita eco entre duas transmissões)
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2, restrictOwnAudio: true },
        systemAudio: 'include',
        windowAudio: 'window',
        selfBrowserSurface: 'exclude', // não oferecer a própria guia do Telão (efeito espelho infinito)
        surfaceSwitching: 'include',
      });
    } catch (err) {
      if (err.name !== 'TypeError' && err.name !== 'OverconstrainedError') throw err;
      return navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    }
  }

  async function share() {
    if (!CAN_SHARE) return;
    let stream;
    try {
      stream = await capture();
    } catch (err) {
      // NotAllowedError = a pessoa cancelou a escolha: não é erro
      if (err.name !== 'NotAllowedError' && err.name !== 'AbortError') {
        console.warn('Telão: captura falhou', err);
        toast('Não foi possível capturar a tela. Feche o seletor e tente de novo.');
      }
      return;
    }
    const video = stream.getVideoTracks()[0];
    const audio = stream.getAudioTracks()[0];
    if (!video) { stream.getTracks().forEach((t) => t.stop()); return; }
    video.contentHint = $('hint').value;
    video.addEventListener('ended', () => { if (local && local.stream === stream) stopShare(); });
    if (audio) { audio.contentHint = 'music'; audio.enabled = !audioMuted; }

    const swapping = !!local;
    if (swapping) local.stream.getTracks().forEach((t) => t.stop());
    else local = { stream, tile: makeTile(null) };
    local.stream = stream;
    local.tile.attach(stream);
    for (const e of peers.values()) callPeer(e);
    if (!swapping) broadcast(hello());
    renderShareUi();
    renderPeople();
    layout();
    if (!audio) {
      toast(video.getSettings().displaySurface === 'window'
        ? 'Sem áudio: este navegador não envia o som de janelas. Para ter som, use "Trocar tela" e escolha uma guia ou a tela inteira.'
        : 'Sem áudio nesta transmissão. Para enviar som, use "Trocar tela" e marque "Compartilhar áudio" no seletor.', 8000);
    }
  }

  function stopShare() {
    if (!local) return;
    local.stream.getTracks().forEach((t) => t.stop());
    local.tile.el.remove();
    local = null;
    for (const e of peers.values()) if (e.out) e.out.close();
    broadcast(hello());
    renderShareUi();
    renderPeople();
    layout();
  }

  function renderShareUi() {
    const on = !!local;
    const audio = on && local.stream.getAudioTracks()[0];
    $('shareBtn').classList.toggle('is-live', on);
    $('shareLabel').textContent = on ? 'Parar de transmitir' : 'Compartilhar tela';
    setIcon($('shareIcon'), on ? 'stop' : 'screen');
    $('swapBtn').hidden = !on;
    $('audioBtn').hidden = !on;
    $('audioBtn').disabled = !audio;
    $('audioBtn').setAttribute('aria-pressed', String(!!audio && audioMuted));
    $('audioLabel').textContent = !audio ? 'Sem áudio' : audioMuted ? 'Áudio silenciado' : 'Áudio ligado';
    setIcon($('audioIcon'), !audio || audioMuted ? 'mute' : 'vol');
  }

  // ---------- mídia: receber ----------
  function onCall(call) {
    const e = peers.get(call.peer);
    if (!e) { call.close(); return; } // só aceito mídia de quem já está na malha da sala
    const prev = e.call;
    e.call = call;
    if (prev) prev.close();
    call.answer(undefined, { sdpTransform: hifi });
    call.on('stream', (stream) => {
      if (e.call !== call) return;
      e.sharing = true;
      e.fails = 0;
      if (!e.tile) e.tile = makeTile(e);
      e.tile.attach(stream);
      e.tile.wait(false);
      renderPeople();
      layout();
    });
    const pc = call.peerConnection;
    pc.addEventListener('connectionstatechange', () => {
      if (e.call !== call) return;
      const st = pc.connectionState;
      if (e.tile) e.tile.wait(st === 'disconnected' || st === 'failed');
      if (st !== 'failed') return;
      // caiu: fecha e pede a transmissão de novo
      e.call = null;
      call.close();
      e.wanted = Date.now();
      send(e, { t: 'want' });
      if (++e.fails === 2) toast(`A conexão direta com ${e.name} não fechou. Redes muito restritas (CGNAT, rede corporativa) podem bloquear.`, 8000);
    });
    call.on('close', () => { if (e.call === call) { e.call = null; if (e.tile) e.tile.wait(true); } });
    call.on('error', () => {});
  }

  function removeStream(e) {
    const call = e.call; e.call = null;
    if (call) call.close();
    if (e.tile) { e.tile.destroy(); e.tile = null; layout(); }
  }

  // ---------- uma tela no palco ----------
  function makeTile(e) { // e = membro remoto, ou null para a minha prévia
    const el = $('tileTpl').content.firstElementChild.cloneNode(true);
    const q = (sel) => el.querySelector(sel);
    const video = q('video');
    const range = q('.js-vol');
    const muteBtn = q('.js-mute');
    const isLocal = !e;
    const who = () => (isLocal ? 'sua tela' : `tela de ${e.name}`);

    function labels() {
      q('.tile-name').textContent = isLocal ? `${myName} (você)` : e.name;
      el.setAttribute('aria-label', isLocal ? 'Sua transmissão' : `Transmissão de ${e.name}`);
      q('.js-focus').setAttribute('aria-label', `Destacar ${who()}`);
      q('.js-pip').setAttribute('aria-label', `Janela flutuante: ${who()}`);
      q('.js-full').setAttribute('aria-label', `Tela cheia: ${who()}`);
      if (!isLocal) range.setAttribute('aria-label', `Volume da ${who()}`);
      for (const b of el.querySelectorAll('button[aria-label]')) b.title = b.getAttribute('aria-label');
    }
    function volume() {
      const silent = e.muted || e.volume === 0;
      video.volume = e.volume;
      video.muted = e.muted || e.blocked;
      range.value = e.muted ? 0 : e.volume;
      range.style.setProperty('--fill', `${range.value * 100}%`);
      setIcon(muteBtn.querySelector('use'), silent ? 'mute' : 'vol');
      muteBtn.setAttribute('aria-pressed', String(silent));
      muteBtn.setAttribute('aria-label', `${silent ? 'Ativar' : 'Silenciar'} som da ${who()}`);
      muteBtn.title = muteBtn.getAttribute('aria-label');
      q('.unblock').hidden = !e.blocked;
    }

    if (isLocal) {
      video.muted = true; // nunca tocar o próprio áudio de volta (eco)
      q('.vol').hidden = true;
      const prev = q('.js-preview');
      prev.hidden = false;
      prev.setAttribute('aria-label', 'Mostrar ou ocultar a prévia (ocultar alivia o computador durante o jogo)');
      prev.addEventListener('click', () => {
        const off = el.classList.toggle('preview-off');
        prev.setAttribute('aria-pressed', String(!off));
        if (off) video.pause(); else video.play().catch(() => {});
      });
    } else {
      muteBtn.addEventListener('click', () => {
        e.muted = !(e.muted || e.volume === 0);
        if (!e.muted && e.volume === 0) e.volume = 0.5;
        volume();
      });
      range.addEventListener('input', () => { e.volume = Number(range.value); e.muted = false; volume(); });
      q('.unblock').addEventListener('click', () => { // um clique já autoriza o som na página inteira
        for (const p of peers.values()) if (p.blocked && p.tile) p.tile.unblock();
      });
    }

    q('.js-focus').addEventListener('click', () => {
      const on = !el.classList.contains('focused');
      for (const t of $('stage').querySelectorAll('.tile')) t.classList.remove('focused');
      el.classList.toggle('focused', on);
      layout();
    });
    q('.tile-video').addEventListener('dblclick', () => q('.js-full').click());
    q('.js-full').addEventListener('click', () => {
      if (document.fullscreenElement) document.exitFullscreen();
      else if (el.requestFullscreen) el.requestFullscreen().catch(() => {});
      else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen(); // iPhone
    });
    if (document.pictureInPictureEnabled) {
      q('.js-pip').addEventListener('click', () => {
        if (document.pictureInPictureElement === video) document.exitPictureInPicture();
        else video.requestPictureInPicture().catch(() => toast('A janela flutuante só abre depois que o vídeo começa.'));
      });
    } else q('.js-pip').hidden = true;

    labels();
    if (!isLocal) volume();
    $('stage').append(el);

    return {
      el, video,
      setName: labels,
      stats: (text, tip = '') => { q('.tile-stats').textContent = text; q('.tile-stats').title = tip; },
      wait: (on) => { q('.tile-wait').hidden = !on; },
      unblock() { e.blocked = false; volume(); video.play().catch(() => {}); },
      attach(stream) {
        if (video.srcObject !== stream) video.srcObject = stream;
        if (el.classList.contains('preview-off')) return;
        video.play().catch(() => {
          if (isLocal) return;
          // o navegador bloqueou som automático: toca mudo e oferece um botão
          e.blocked = true;
          volume();
          video.play().catch(() => {});
        });
      },
      destroy() {
        if (document.pictureInPictureElement === video) document.exitPictureInPicture().catch(() => {});
        video.srcObject = null;
        el.remove();
      },
    };
  }

  function layout() {
    const stage = $('stage');
    const tiles = stage.querySelectorAll('.tile');
    const n = tiles.length;
    $('empty').hidden = n > 0;
    if (n) stage.dataset.count = n > 4 ? 'many' : String(n); else delete stage.dataset.count;
    stage.classList.toggle('has-focus', !!stage.querySelector('.tile.focused'));
    stage.classList.toggle('only-one', n === 1);
    for (const t of tiles) t.querySelector('.js-focus').setAttribute('aria-pressed', String(t.classList.contains('focused')));
  }

  // ---------- números de cada transmissão ----------
  async function updateStats() {
    if (local) {
      const s = local.stream.getVideoTracks()[0].getSettings();
      const outs = [...peers.values()].filter((e) => e.out && e.out.peerConnection && e.out.peerConnection.connectionState === 'connected');
      const parts = [`${s.width || '?'}×${s.height || '?'}`, `${Math.round(s.frameRate || 0)} fps`];
      let tip = '';
      if (outs.length) { // o que de fato está saindo para o primeiro espectador
        let o, codec, avail;
        try {
          const st = await outs[0].out.peerConnection.getStats();
          st.forEach((r) => {
            if (r.type === 'outbound-rtp' && r.kind === 'video') o = r;
            if (r.type === 'candidate-pair' && r.nominated && r.availableOutgoingBitrate) avail = r.availableOutgoingBitrate;
          });
          if (o && o.codecId && st.get(o.codecId)) codec = st.get(o.codecId).mimeType.replace('video/', '');
        } catch { /* conexão fechou no meio da leitura */ }
        if (o && o.frameWidth && local) {
          const now = performance.now();
          const mbps = local.bytesAt ? ((o.bytesSent - local.bytes) * 8) / (now - local.bytesAt) / 1000 : 0;
          local.bytes = o.bytesSent; local.bytesAt = now;
          parts[0] = `${o.frameWidth}×${o.frameHeight}`;
          parts[1] = `${Math.round(o.framesPerSecond || 0)} fps`;
          if (mbps > 0) parts.push(`${mbps.toFixed(1).replace('.', ',')} Mb/s`);
          if (o.qualityLimitationReason === 'cpu') parts.push('limitado pelo processador');
          if (o.qualityLimitationReason === 'bandwidth') parts.push('limitado pela rede');
          tip = `Capturando ${s.width}×${s.height} a ${Math.round(s.frameRate || 0)} fps · codec ${codec || '?'} (${o.encoderImplementation || '?'})`
            + (avail ? ` · banda estimada ${(avail / 1e6).toFixed(1).replace('.', ',')} Mb/s` : '');
        }
      }
      if (!local) return;
      parts.push(outs.length === 1 ? '1 pessoa assistindo' : `${outs.length} pessoas assistindo`);
      local.tile.stats(parts.join(' · '), tip);
    }
    for (const e of peers.values()) {
      const pc = e.call && e.call.peerConnection;
      if (!e.tile || !pc || pc.connectionState !== 'connected') continue;
      let inbound, rtt;
      try {
        (await pc.getStats()).forEach((r) => {
          if (r.type === 'inbound-rtp' && r.kind === 'video') inbound = r;
          if (r.type === 'candidate-pair' && r.nominated && r.currentRoundTripTime !== undefined) rtt = r.currentRoundTripTime;
        });
      } catch { continue; }
      if (!e.tile) continue;
      const v = e.tile.video; // Firefox não informa o tamanho do quadro nas estatísticas: uso o do vídeo
      const w = (inbound && inbound.frameWidth) || v.videoWidth;
      if (!w) continue;
      const parts = [`${w}×${(inbound && inbound.frameHeight) || v.videoHeight}`];
      if (inbound) {
        const now = performance.now();
        const mbps = e.bytesAt ? ((inbound.bytesReceived - e.bytes) * 8) / (now - e.bytesAt) / 1000 : 0;
        e.bytes = inbound.bytesReceived; e.bytesAt = now;
        if (inbound.framesPerSecond !== undefined) parts.push(`${Math.round(inbound.framesPerSecond)} fps`);
        if (mbps > 0) parts.push(`${mbps.toFixed(1).replace('.', ',')} Mb/s`);
      }
      if (rtt !== undefined) parts.push(`${Math.round(rtt * 1000)} ms`);
      e.tile.stats(parts.join(' · '));
    }
  }

  // ---------- pessoas e chat ----------
  function renderPeople() {
    const list = $('people');
    list.textContent = '';
    const row = (name, you, sharing) => {
      const li = document.createElement('li');
      const av = document.createElement('span');
      av.className = 'avatar'; av.textContent = [...name][0] || '?'; av.setAttribute('aria-hidden', 'true');
      const who = document.createElement('span');
      who.className = 'who'; who.textContent = name;
      if (you) { const y = document.createElement('span'); y.className = 'you'; y.textContent = ' (você)'; who.append(y); }
      li.append(av, who);
      if (sharing) {
        const tag = document.createElement('span');
        tag.className = 'tag-live';
        const dot = document.createElement('span'); dot.className = 'live'; dot.setAttribute('aria-hidden', 'true');
        tag.append(dot, 'ao vivo');
        li.append(tag);
      }
      list.append(li);
    };
    row(myName, true, !!local);
    let n = 1;
    for (const e of peers.values()) if (e.ready) { row(e.name, false, e.sharing); n++; }
    $('peopleCount').textContent = String(n);
    $('emptyText').textContent = n > 1
      ? 'Quem compartilhar a tela aparece aqui para todos da sala.'
      : 'Mande o link da sala para quem vai assistir e comece quando quiser.';
  }

  function addChat(from, text, kind) {
    const log = $('chatLog');
    const li = document.createElement('li');
    if (kind === 'sys') { li.className = 'sys'; li.textContent = text; }
    else {
      if (kind === 'mine') li.className = 'mine';
      const f = document.createElement('span'); f.className = 'from'; f.textContent = from;
      li.append(f, text);
    }
    log.append(li);
    while (log.children.length > 200) log.firstElementChild.remove();
    log.scrollTop = log.scrollHeight;
    if (kind !== 'sys' && kind !== 'mine' && $('panel').hidden) {
      const b = $('unread');
      b.hidden = false;
      b.textContent = String(Math.min(99, (Number(b.textContent) || 0) + 1));
    }
  }
  function note(text) { toast(text); addChat('', text, 'sys'); }

  function togglePanel(open) {
    const panel = $('panel');
    panel.hidden = !open;
    $('panelBtn').setAttribute('aria-expanded', String(open));
    if (open) { $('unread').hidden = true; $('unread').textContent = ''; $('chatLog').scrollTop = $('chatLog').scrollHeight; }
  }

  async function copyLink(btn) {
    try {
      await navigator.clipboard.writeText(location.href);
      toast('Link copiado. Quem abrir entra direto na sala.');
      if (btn === $('copyBtn')) {
        btn.classList.add('done'); setIcon($('copyIcon'), 'check');
        setTimeout(() => { btn.classList.remove('done'); setIcon($('copyIcon'), 'link'); }, 1600);
      }
    } catch {
      toast('Não deu para copiar sozinho. Copie o endereço da barra do navegador.', 5000);
    }
  }

  // ---------- entrar e sair ----------
  function enterRoom(code) {
    room = code;
    leaving = false; everOk = false; backoff = 0;
    if (parseCode(location.hash) !== code) location.hash = pretty(code);
    document.title = `Sala ${pretty(code)} · Telão`;
    $('home').hidden = true;
    $('room').hidden = false;
    $('copyLabel').textContent = pretty(code);
    $('nameInput').value = myName;
    $('chatLog').textContent = '';
    togglePanel(window.matchMedia('(min-width: 1100px)').matches);
    renderShareUi(); renderPeople(); layout(); refreshStatus();
    if (typeof Peer === 'undefined') { toast('A biblioteca de conexão não carregou. Recarregue a página.', 8000); return; }
    connect();
  }

  function leaveRoom() {
    if (!room) return;
    leaving = true;
    clearTimeout(retryTimer);
    broadcast({ t: 'bye' });
    stopShare();
    resetMesh();
    if (peer) { const p = peer; peer = null; p.destroy(); }
    if (wakeLock) wakeLock.release().catch(() => {});
    room = null;
    history.replaceState(null, '', location.pathname);
    document.title = 'Telão — compartilhe sua tela por um link';
    $('room').hidden = true;
    $('home').hidden = false;
  }

  // ---------- manutenção periódica ----------
  setInterval(() => {
    if (!room || leaving) return;
    const now = Date.now();
    for (const e of [...peers.values()]) {
      if (!e.ready) { if (now - e.born > 15000) dropPeer(e.id, true); continue; }
      if (now - e.seen > 20000) { dropPeer(e.id); continue; } // aba fechada sem avisar
      send(e, { t: 'ping' });
      // diz que transmite mas a imagem não chegou (ou caiu): pede de novo
      if (e.sharing && !e.call && now - e.wanted > 8000) { e.wanted = now; send(e, { t: 'want' }); }
    }
    if (dirConn && dirConn.open) {
      if (now - dirSeen > 20000) dirConn.close(); else dirConn.send({ t: 'ping' });
    } else if (!dirConn) joinDirectory();
    if (dirPeer) {
      for (const [id, m] of dirMembers) if (now - m.seen > 20000) { dirMembers.delete(id); m.c.close(); }
      broadcastDirectory(); // também serve de sinal de vida do diretório
    }
    heal();
    refreshStatus();
    // mantém a tela acesa enquanto há transmissão
    const busy = local || $('stage').querySelector('.tile');
    if (busy && !wakeLock && navigator.wakeLock && document.visibilityState === 'visible') {
      navigator.wakeLock.request('screen').then((l) => { wakeLock = l; l.addEventListener('release', () => { wakeLock = null; }); }).catch(() => {});
    }
  }, 5000);
  setInterval(() => { if (room) updateStats(); }, 2000);

  // ---------- eventos da página ----------
  $('createBtn').addEventListener('click', () => enterRoom(randomCode(10)));
  $('joinForm').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const code = parseCode($('joinInput').value);
    $('joinError').textContent = code ? '' : 'Esse link ou código não parece de uma sala. O código tem 10 letras e números, como abcde-fgh23.';
    if (code) enterRoom(code);
  });
  for (const b of document.querySelectorAll('.js-share')) {
    b.addEventListener('click', () => (local && b === $('shareBtn') ? stopShare() : share()));
    if (!CAN_SHARE) b.hidden = true;
  }
  if (!CAN_SHARE) { $('noShare').hidden = false; document.querySelector('.dock-opts').hidden = true; }
  $('swapBtn').addEventListener('click', share);
  $('audioBtn').addEventListener('click', () => {
    audioMuted = !audioMuted;
    const a = local && local.stream.getAudioTracks()[0];
    if (a) a.enabled = !audioMuted;
    renderShareUi();
    toast(audioMuted ? 'Seu áudio foi silenciado para todos.' : 'Seu áudio voltou para todos.');
  });
  $('quality').addEventListener('change', applyQuality);
  $('hint').addEventListener('change', applyQuality);
  for (const b of [$('copyBtn'), ...document.querySelectorAll('.js-copy')]) b.addEventListener('click', () => copyLink(b));
  $('leaveBtn').addEventListener('click', leaveRoom);
  $('brandLeave').addEventListener('click', (ev) => { ev.preventDefault(); leaveRoom(); });
  $('panelBtn').addEventListener('click', () => {
    togglePanel($('panel').hidden);
    if (!$('panel').hidden) $('panelClose').focus();
  });
  $('panelClose').addEventListener('click', () => { togglePanel(false); $('panelBtn').focus(); });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !$('panel').hidden && !document.fullscreenElement) { togglePanel(false); $('panelBtn').focus(); }
  });
  $('nameInput').addEventListener('change', () => {
    myName = clean($('nameInput').value) || myName;
    $('nameInput').value = myName;
    store('name', myName);
    if (local) local.tile.setName();
    broadcast(hello());
    renderPeople();
  });
  $('chatForm').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const text = clean($('chatInput').value, 500);
    if (!text) return;
    $('chatInput').value = '';
    broadcast({ t: 'chat', text });
    addChat(myName, text, 'mine');
  });

  window.addEventListener('online', () => { refreshStatus(); if (peer && peer.disconnected && !peer.destroyed) peer.reconnect(); });
  window.addEventListener('offline', refreshStatus);
  window.addEventListener('hashchange', () => {
    const code = parseCode(location.hash);
    if (code && !room) enterRoom(code);
    else if (code && code !== room) location.reload(); // trocar de sala: recomeça limpo
    else if (!code && room) leaveRoom();
  });
  // ao fechar a aba: avisa a sala e libera os IDs na hora (senão o diretório fica preso por ~1 min)
  window.addEventListener('pagehide', () => {
    if (!room) return;
    leaving = true;
    broadcast({ t: 'bye' });
    if (dirPeer) dirPeer.destroy();
    if (peer) peer.destroy();
  });
  window.addEventListener('pageshow', (ev) => { if (ev.persisted && leaving) location.reload(); });

  // ---------- início ----------
  if (QUALITY[store('quality')]) $('quality').value = store('quality');
  if (store('hint') === 'detail') $('hint').value = 'detail';
  const initial = parseCode(location.hash);
  if (initial) enterRoom(initial);
  else if (location.hash.length > 1) $('joinError').textContent = 'O link aberto não é de uma sala válida. Confira se ele veio inteiro.';
})();
