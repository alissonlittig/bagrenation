/* BAGRENATION — compartilhamento de tela ponto a ponto (WebRTC).
 *
 * Como funciona:
 *  - Cada pessoa é um "membro" com um ID próprio no servidor público de sinalização do PeerJS.
 *  - A sala tem um ID fixo de "diretório" (bagrenation-<código>-dir). Quem chega tenta falar com ele;
 *    se ninguém responde, assume o papel. O diretório só distribui a lista de membros.
 *    Se quem o mantinha sai, outro membro assume: o link da sala nunca morre.
 *  - Os membros se conectam todos entre si (malha) por canal de dados; quem transmite
 *    abre uma chamada de mídia para cada um. Vídeo e áudio nunca passam por servidor.
 */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // sem 0/o, 1/l/i
  // ID novo: 6 caracteres (31^6 ≈ 887 milhões), fácil de ditar. Links antigos de 10 seguem valendo.
  const CODE_RE = new RegExp(`^(?:[${ALPHABET}]{6}|[${ALPHABET}]{10})$`);
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
  // A biblioteca PeerJS testa o WebRTC do navegador ao iniciar (centenas de ms em aparelho fraco):
  // só é carregada quando vai ser usada (Press Start ou link de sala), não junto com a página.
  let peerLib = null;
  function loadPeer() { // Promise<boolean>: a biblioteca está pronta?
    if (!peerLib) {
      peerLib = new Promise((resolve) => {
        const s = document.createElement('script');
        s.src = 'vendor/peerjs.min.js';
        s.onload = () => resolve(true);
        s.onerror = () => { peerLib = null; s.remove(); resolve(false); }; // falhou: a próxima tentativa baixa de novo
        document.head.append(s);
      });
    }
    return peerLib;
  }
  function store(key, value) {
    try {
      if (value === undefined) return localStorage.getItem(`bagrenation:${key}`);
      localStorage.setItem(`bagrenation:${key}`, value);
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
  const half = (code) => Math.ceil(code.length / 2);
  const pretty = (code) => `${code.slice(0, half(code))}-${code.slice(half(code))}`.toUpperCase();
  const dirId = () => `bagrenation-${room}-dir`;
  const isMember = (id) => typeof id === 'string' && id.startsWith(`bagrenation-${room}-m-`) && id.length < 64;
  const setIcon = (use, name) => use.setAttribute('href', `#i-${name}`);
  const narrow = () => window.matchMedia('(max-width: 960px)').matches;
  function paintAvatar(el, name) { // cor fixa por nome: a mesma pessoa tem a mesma cor em todas as telas
    let h = 0;
    for (const ch of name) h = (h * 31 + ch.codePointAt(0)) % 360;
    el.style.setProperty('--h', String(h));
    el.textContent = [...name.trim()][0] || '?';
  }

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
    myId = `bagrenation-${room}-m-${randomCode(8)}`;
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
        toast('Este navegador não tem o WebRTC necessário para o BAGRENATION.', 8000);
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
      if (first) { note(`${e.name} entrou`); sfx('in'); e.wanted = Date.now(); }
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
    if (e.named && !silent && !leaving) { note(`${e.name} saiu`); sfx('out'); }
    renderPeople();
  }

  function resetMesh() {
    for (const id of [...peers.keys()]) dropPeer(id, true);
    known = [];
    if (dirConn) { const c = dirConn; dirConn = null; c.close(); }
    if (dirPeer) { const d = dirPeer; dirPeer = null; dirMembers.clear(); d.destroy(); }
  }

  // ---------- mídia: enviar ----------
  // Ajustes na negociação (SDP), só nas chamadas do BAGRENATION:
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
      sender.setParameters(params).catch((err) => console.warn('BAGRENATION: limite de envio não aplicado', err));
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

  // "Sem Discord": nenhum navegador separa um app de dentro do som do sistema. O que dá certo é
  // não oferecer a tela inteira (som do sistema = Discord junto) e pedir só janela ou guia, cujo
  // áudio é só delas (windowAudio 'window' no Chrome/Edge recentes; guia em qualquer Chromium).
  const noDiscord = () => store('nodiscord') === '1';

  async function capture() {
    const q = QUALITY[$('quality').value];
    const nd = noDiscord();
    try {
      return await navigator.mediaDevices.getDisplayMedia({
        video: { width: { max: q.w }, height: { max: q.h }, frameRate: { ideal: q.fps, max: q.fps } },
        // áudio de jogo/vídeo: sem os filtros de voz, que abafam música e efeitos
        // restrictOwnAudio: ao capturar o som do sistema, deixa de fora o que o próprio BAGRENATION está tocando (evita eco entre duas transmissões)
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2, restrictOwnAudio: true },
        systemAudio: nd ? 'exclude' : 'include',
        windowAudio: 'window',
        monitorTypeSurfaces: nd ? 'exclude' : 'include',
        selfBrowserSurface: 'exclude', // não oferecer a própria guia do BAGRENATION (efeito espelho infinito)
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
        console.warn('BAGRENATION: captura falhou', err);
        toast('Não foi possível capturar a tela. Feche o seletor e tente de novo.');
      }
      return;
    }
    const video = stream.getVideoTracks()[0];
    let audio = stream.getAudioTracks()[0];
    if (!video) { stream.getTracks().forEach((t) => t.stop()); return; }
    const surface = video.getSettings().displaySurface;
    let cut = false;
    if (audio && noDiscord() && surface === 'monitor') {
      // navegador sem monitorTypeSurfaces deixou escolher a tela inteira: o som dela leva o Discord
      stream.removeTrack(audio); audio.stop(); audio = null; cut = true;
    }
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
    if (cut) toast('Tela inteira com "Sem Discord" ligado: o áudio foi cortado, porque o som do sistema leva o Discord junto. Para ter som, troque para a janela do jogo ou uma guia.', 9000);
    else if (!audio) {
      toast(surface === 'window'
        ? 'Sem áudio: este navegador não envia o som de janelas. Para ter som, use "Trocar tela" e escolha uma guia' + (noDiscord() ? '.' : ' ou a tela inteira.')
        : 'Sem áudio nesta transmissão. Para enviar som, use "Trocar tela" e marque "Compartilhar áudio" no seletor.', 8000);
    } else if (noDiscord()) {
      toast(surface === 'browser' ? 'Enviando só o som desta guia. O Discord fica de fora.' : 'Enviando só o som desta janela. O Discord fica de fora.', 5000);
    } else if (surface === 'monitor') {
      toast('Enviando o som do computador todo, Discord incluído. Para tirar, ligue "Sem Discord".', 6000);
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
    $('shareLabel').textContent = on ? 'Parar' : 'Compartilhar tela';
    $('shareBtn').setAttribute('aria-label', on ? 'Parar de transmitir' : 'Compartilhar tela');
    setIcon($('shareIcon'), on ? 'stop' : 'cast');
    $('swapBtn').hidden = !on;
    $('audioBtn').hidden = !on;
    $('audioBtn').disabled = !audio;
    $('audioBtn').setAttribute('aria-pressed', String(!!audio && audioMuted));
    $('audioLabel').textContent = !audio ? 'Sem som' : audioMuted ? 'Som mudo' : 'Som';
    $('audioBtn').setAttribute('aria-label', !audio ? 'Transmissão sem áudio' : audioMuted ? 'Seu áudio está silenciado para todos. Reativar' : 'Seu áudio está indo para todos. Silenciar');
    $('meter').hidden = !audio;
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
      paintAvatar(q('.avatar'), isLocal ? myName : e.name);
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
      el.classList.toggle('blocked', e.blocked);
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
    const row = (id, name, you, sharing, stats) => {
      const li = document.createElement('li');
      li.dataset.id = id;
      li.classList.toggle('is-live', sharing);
      const av = document.createElement('span');
      av.className = 'avatar'; av.setAttribute('aria-hidden', 'true');
      paintAvatar(av, name);
      const who = document.createElement('span');
      who.className = 'who';
      const nm = document.createElement('span');
      nm.className = 'nm'; nm.textContent = you ? `${name} (você)` : name;
      const sub = document.createElement('span');
      sub.className = 'sub'; sub.textContent = sharing ? `transmitindo${stats ? ` · ${stats}` : ''}` : 'assistindo';
      who.append(nm, sub);
      li.append(av, who);
      if (sharing) {
        const tag = document.createElement('span');
        tag.className = 'pill-live'; tag.textContent = 'ao vivo';
        li.append(tag);
      }
      list.append(li);
    };
    const res = (s) => (s && s.height ? `${s.height}p` : '');
    row('me', myName, true, !!local, local && res(local.stream.getVideoTracks()[0].getSettings()));
    let n = 1;
    for (const e of peers.values()) if (e.ready) { row(e.id, e.name, false, e.sharing, e.tile && e.tile.video.videoHeight ? `${e.tile.video.videoHeight}p` : ''); n++; }
    $('peopleCount').textContent = String(n);
    $('peopleCountSide').textContent = String(n);
    paintAvatar($('meAvatar'), myName);
    $('emptyText').textContent = '';
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

  async function copy(text, btn, done) {
    try {
      await navigator.clipboard.writeText(text);
      toast(done); sfx('ok');
      if (btn === $('copyBtn')) {
        btn.classList.add('done'); setIcon($('copyIcon'), 'check'); $('copyLabel').textContent = 'Copiado';
        setTimeout(() => { btn.classList.remove('done'); setIcon($('copyIcon'), 'copy'); $('copyLabel').textContent = 'Copiar ID'; }, 1600);
      }
    } catch {
      toast(`Não deu para copiar sozinho. O ID é ${pretty(room)}.`, 6000);
    }
  }

  // ---------- campo de ID em casas ----------
  function otp(input) {
    const box = input.parentElement;
    const cells = [...box.querySelectorAll('.otp-cells span:not(.gap)')];
    const paint = () => {
      let v = input.value;
      if (/[#/]/.test(v)) { const c = parseCode(v); if (c) v = c; } // colou o link inteiro
      v = v.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
      if (input.value !== v) input.value = v;
      const focused = document.activeElement === input;
      cells.forEach((c, i) => {
        c.textContent = v[i] || '';
        c.classList.toggle('filled', !!v[i]);
        c.classList.toggle('cur', focused && i === v.length);
      });
      box.classList.remove('bad');
    };
    for (const ev of ['input', 'focus', 'blur']) input.addEventListener(ev, paint);
    return { reset() { input.value = ''; paint(); }, bad() { box.classList.add('bad'); sfx('err'); } };
  }

  // A sala existe? Pergunta ao servidor se o "diretório" dela está no ar, sem entrar nela.
  // true = existe · false = ninguém nessa sala · null = sem resposta (rede)
  async function probe(code) {
    if (!(await loadPeer())) return null;
    return new Promise((resolve) => {
      const p = new Peer(`bagrenation-${code}-q-${randomCode(8)}`, PEER_OPTS);
      let over = false;
      const end = (v) => { if (over) return; over = true; clearTimeout(t); p.destroy(); resolve(v); };
      const t = setTimeout(() => end(null), 12000);
      p.on('open', () => { p.connect(`bagrenation-${code}-dir`, CONN_OPTS).on('open', () => end(true)); });
      p.on('error', (err) => end(err.type === 'peer-unavailable' ? false : null));
    });
  }

  async function tryJoin(input, errEl, field, btn) {
    const code = parseCode(input.value);
    errEl.textContent = '';
    if (!code) {
      errEl.textContent = 'O ID tem 6 letras e números, como K7Q-M4P. Não usamos 0, O, 1, I nem L.';
      field.bad(); input.focus();
      return;
    }
    if (code === room) { errEl.textContent = 'Você já está nesta sala.'; return; }
    btn.disabled = true;
    const lbl = btn.querySelector('.lbl'); const was = lbl.textContent;
    lbl.textContent = 'Procurando a sala…';
    const found = await probe(code);
    btn.disabled = false; lbl.textContent = was;
    if (found) {
      if (room) location.hash = pretty(code); // troca de sala: a página recomeça limpa na nova
      else enterRoom(code);
      return;
    }
    errEl.textContent = found === false
      ? `Nenhuma sala ${pretty(code)} aberta agora. Confira o ID com quem te passou.`
      : 'O servidor de conexão não respondeu. Confira a internet e tente de novo.';
    field.bad();
  }

  // ---------- entrar e sair ----------
  let visits = 0;
  function enterRoom(code) {
    const visit = ++visits;
    room = code;
    leaving = false; everOk = false; backoff = 0;
    if (parseCode(location.hash) !== code) location.hash = pretty(code);
    document.title = `Sala ${pretty(code)} · BAGRENATION`;
    $('title').hidden = true;
    $('home').hidden = true;
    $('room').hidden = false;
    const id = $('roomId');
    id.textContent = '';
    id.classList.toggle('long', code.length > 6);
    for (const ch of pretty(code)) {
      const el = document.createElement(ch === '-' ? 'i' : 'b');
      if (ch !== '-') el.textContent = ch;
      id.append(el);
    }
    id.setAttribute('aria-label', `ID da sala: ${[...code.toUpperCase()].join(' ')}`);
    $('roomTitle').textContent = pretty(code);
    $('emptyId').textContent = pretty(code);
    $('nameInput').value = myName;
    $('chatLog').textContent = '';
    togglePanel(!narrow());
    renderShareUi(); renderPeople(); layout(); refreshStatus();
    loadPeer().then((ok) => {
      if (visit !== visits || room !== code) return; // saiu ou trocou de sala enquanto a biblioteca carregava
      if (ok) connect();
      else toast('A biblioteca de conexão não carregou. Confira a internet e recarregue a página.', 8000);
    });
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
    document.title = 'BAGRENATION';
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

  // ---------- nível de áudio: medidor de quem transmite e "som tocando" em cada tela ----------
  let ac = null;
  const meters = new WeakMap(); // faixa de áudio -> analisador
  function level(stream) { // RMS 0..1 do áudio que está saindo/chegando
    const track = stream && stream.getAudioTracks()[0];
    if (!track || !track.enabled || track.readyState !== 'live') return 0;
    if (!ac) {
      // antes do primeiro clique o navegador recusa o AudioContext (e reclama no console)
      if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return 0;
      ac = new AudioContext();
    }
    if (ac.state === 'suspended') { ac.resume().catch(() => {}); return 0; }
    let m = meters.get(track);
    if (!m) {
      const an = ac.createAnalyser();
      an.fftSize = 512;
      const src = ac.createMediaStreamSource(new MediaStream([track]));
      src.connect(an);
      track.addEventListener('ended', () => src.disconnect());
      m = { an, buf: new Float32Array(an.fftSize) };
      meters.set(track, m);
    }
    m.an.getFloatTimeDomainData(m.buf);
    let sum = 0;
    for (const v of m.buf) sum += v * v;
    return Math.sqrt(sum / m.buf.length);
  }
  // ---------- sons 8-bit da interface (desligados por padrão; liga no botão "Som 8-bit") ----------
  const SFX = { // [frequência em Hz, duração em s] em sequência
    tap: [[660, 0.04]],
    ok: [[660, 0.06], [990, 0.1]],
    err: [[196, 0.09], [147, 0.14]],
    in: [[523, 0.06], [784, 0.09]],
    out: [[523, 0.06], [392, 0.09]],
    start: [[392, 0.07], [523, 0.07], [659, 0.07], [784, 0.16]],
  };
  const sfxOn = () => store('sfx') === '1';
  function sfx(name) {
    if (!sfxOn() || (navigator.userActivation && !navigator.userActivation.hasBeenActive)) return;
    if (!ac) ac = new AudioContext();
    if (ac.state === 'suspended') ac.resume().catch(() => {});
    let t = ac.currentTime;
    for (const [hz, dur] of SFX[name]) {
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.type = 'square';
      osc.frequency.value = hz;
      gain.gain.value = 0.04;
      osc.connect(gain).connect(ac.destination);
      osc.start(t); osc.stop(t += dur);
    }
  }
  function renderSfx() {
    for (const b of document.querySelectorAll('.js-sfx')) {
      b.setAttribute('aria-pressed', String(sfxOn()));
      setIcon(b.querySelector('use'), sfxOn() ? 'vol' : 'mute');
      b.querySelector('.lbl').textContent = sfxOn() ? 'Som 8-bit: on' : 'Som 8-bit: off';
    }
  }
  for (const b of document.querySelectorAll('.js-sfx')) {
    b.addEventListener('click', () => { store('sfx', sfxOn() ? '0' : '1'); renderSfx(); });
  }
  document.addEventListener('click', (ev) => { if (ev.target.closest('button')) sfx('tap'); });
  renderSfx();

  const SOUND = 0.015; // acima disso a tela "acende" (alguém falando, música, tiro…)
  setInterval(() => {
    if (!room) return;
    const mine = local ? level(local.stream) : 0;
    const db = mine > 0 ? 20 * Math.log10(mine) : -99;
    const lit = Math.max(0, Math.min(5, Math.round(((db + 50) / 44) * 5))); // -50 dB..-6 dB -> 0..5 barras
    [...$('meter').children].forEach((bar, i) => bar.classList.toggle('on', i < lit));
    const on = mine > SOUND;
    if (local) local.tile.el.classList.toggle('speaking', on);
    $('meAvatar').classList.toggle('speaking', on);
    const meRow = $('people').querySelector('li[data-id="me"] .avatar');
    if (meRow) meRow.classList.toggle('speaking', on);
    for (const e of peers.values()) {
      const loud = !!e.tile && level(e.tile.video.srcObject) > SOUND;
      if (e.tile) e.tile.el.classList.toggle('speaking', loud);
      const row = $('people').querySelector(`li[data-id="${CSS.escape(e.id)}"] .avatar`);
      if (row) row.classList.toggle('speaking', loud);
    }
  }, 120);

  // ---------- eventos da página ----------
  function setName(v) {
    myName = clean(v) || myName;
    $('nameInput').value = $('homeName').value = myName;
    store('name', myName);
  }
  $('homeName').value = store('name') ? myName : '';
  $('homeName').addEventListener('change', () => setName($('homeName').value));
  $('createBtn').addEventListener('click', () => { setName($('homeName').value); enterRoom(randomCode(6)); });
  const homeOtp = otp($('joinInput'));
  $('joinForm').addEventListener('submit', (ev) => {
    ev.preventDefault();
    setName($('homeName').value);
    tryJoin($('joinInput'), $('joinError'), homeOtp, ev.target.querySelector('[type=submit]'));
  });
  const otherOtp = otp($('joinOtherInput'));
  $('joinOtherBtn').addEventListener('click', () => {
    otherOtp.reset(); $('joinOtherError').textContent = '';
    $('joinDlg').showModal();
  });
  $('joinOtherForm').addEventListener('submit', (ev) => {
    ev.preventDefault();
    tryJoin($('joinOtherInput'), $('joinOtherError'), otherOtp, ev.target.querySelector('[type=submit]'));
  });
  for (const b of document.querySelectorAll('.dlg .js-close')) b.addEventListener('click', () => b.closest('dialog').close());
  for (const d of document.querySelectorAll('.dlg')) d.addEventListener('click', (ev) => { if (ev.target === d) d.close(); }); // clique fora fecha

  // Sem Discord: vale para a próxima escolha de tela; durante a transmissão, reabre o seletor na hora
  function renderDiscord() {
    const on = noDiscord();
    $('discordBtn').setAttribute('aria-pressed', String(on));
    setIcon($('discordIcon'), on ? 'headset-off' : 'headset');
    $('discordBtn').title = on ? 'Sem Discord ligado: o seletor só oferece janela e guia' : 'Ligar para o som do Discord não ir junto';
  }
  $('discordBtn').addEventListener('click', () => {
    store('nodiscord', noDiscord() ? '0' : '1');
    renderDiscord();
    if (!noDiscord()) { toast('Sem Discord desligado. A tela inteira volta a aparecer no seletor.'); return; }
    if (local) { toast('Escolha a janela do jogo ou uma guia para tirar o Discord.', 5000); share(); }
    else toast('Ao compartilhar, escolha a janela do jogo ou uma guia: o som do Discord não vai junto.', 6000);
  });
  $('guideBtn').addEventListener('click', () => $('guideDlg').showModal());
  function toggleSettings(open) {
    $('settings').hidden = !open;
    $('settingsBtn').setAttribute('aria-expanded', String(open));
  }
  $('settingsBtn').addEventListener('click', () => toggleSettings($('settings').hidden));
  document.addEventListener('pointerdown', (ev) => {
    if (!$('settings').hidden && !ev.target.closest('#settings, #settingsBtn')) toggleSettings(false);
  });
  for (const b of document.querySelectorAll('.js-share')) {
    b.addEventListener('click', () => (local && b === $('shareBtn') ? stopShare() : share()));
    if (!CAN_SHARE) b.hidden = true;
  }
  if (!CAN_SHARE) { $('noShare').hidden = false; for (const el of document.querySelectorAll('.js-sender')) el.hidden = true; }
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
  $('copyBtn').addEventListener('click', () => copy(pretty(room), $('copyBtn'), `ID ${pretty(room)} copiado. Quem digitar entra na sala.`));
  $('copyLinkBtn').addEventListener('click', () => copy(location.href, null, 'Link copiado. Quem abrir entra direto na sala.'));
  $('leaveBtn').addEventListener('click', leaveRoom);
  $('brandLeave').addEventListener('click', (ev) => { ev.preventDefault(); leaveRoom(); });
  $('panelBtn').addEventListener('click', () => {
    togglePanel($('panel').hidden);
    if (!$('panel').hidden) $('panelClose').focus();
  });
  $('panelClose').addEventListener('click', () => { togglePanel(false); $('panelBtn').focus(); });
  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape' || document.fullscreenElement || document.querySelector('dialog[open]')) return;
    if (!$('settings').hidden) { toggleSettings(false); $('settingsBtn').focus(); }
    else if (!$('panel').hidden && narrow()) { togglePanel(false); $('panelBtn').focus(); }
  });
  $('nameInput').addEventListener('change', () => {
    setName($('nameInput').value);
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
  renderDiscord();
  // Abertura (PRESS START): clique em qualquer lugar ou qualquer tecla leva ao início
  function start() {
    if ($('title').hidden) return;
    $('title').hidden = true;
    $('home').hidden = false;
    sfx('start');
    loadPeer(); // adianta o carregamento enquanto a pessoa digita o nick
    if (window.matchMedia('(hover: hover)').matches) $('homeName').focus(); // no celular não abre o teclado sozinho
  }
  $('title').addEventListener('click', start);
  document.addEventListener('keydown', (ev) => {
    if (!ev.ctrlKey && !ev.metaKey && !ev.altKey && !['Tab', 'Shift', 'Escape'].includes(ev.key) && !/^F\d+$/.test(ev.key)) start();
  });

  const initial = parseCode(location.hash);
  if (initial) enterRoom(initial);
  else if (location.hash.length > 1) {
    start();
    $('joinError').textContent = 'O link aberto não é de uma sala válida. Confira se ele veio inteiro ou digite o ID.';
  }
})();
