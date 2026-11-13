/* BAGRENATION — chat de voz e compartilhamento de tela ponto a ponto (WebRTC).
 *
 * Como funciona:
 *  - Cada pessoa é um "membro" com um ID próprio no servidor público de sinalização do PeerJS.
 *  - A sala tem um ID fixo de "diretório" (bagrenation-<código>-dir). Quem chega tenta falar com ele;
 *    se ninguém responde, assume o papel. O diretório só distribui a lista de membros.
 *    Se quem o mantinha sai, outro membro assume: o link da sala nunca morre.
 *  - Os membros se conectam todos entre si (malha) por canal de dados; quem transmite
 *    abre uma chamada de mídia para cada um. Vídeo e áudio nunca passam por servidor.
 *  - Voz: entrar na sala = entrar no canal de voz. Cada par de membros tem uma conexão só de
 *    áudio (RTCPeerConnection própria, negociada pelo canal de dados), separada da tela.
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
  // Avatares desenhados em tools/pixel.py (símbolos av-* do index.html). Sem escolha = inicial do nome.
  const AV_SYM = [...document.querySelectorAll('symbol[id^="av-"]')]; // data-g = aba da galeria, data-n = nome
  const AVATARS = AV_SYM.map((el) => el.id.slice(3));
  let myAv = AVATARS.includes(store('avatar')) ? store('avatar') : '';
  // Voz. Preferências lembradas no navegador; mudo/ensurdecido valem só até fechar a página.
  const voice = {
    track: null,      // faixa do microfone que vai para a sala (ligada/desligada pelo portão)
    tap: null,        // cópia sempre ligada, só para medir o nível e para o teste de microfone
    err: '',          // por que não há microfone (nome do erro do navegador)
    muted: false, deaf: false, wasMuted: false,
    mode: store('vmode') === 'ptt' ? 'ptt' : 'vad',
    sens: Math.min(100, Math.max(0, Number(store('vsens') ?? 0) || 0)), // 0 = sempre aberto (padrão)
    key: store('vkey') || 'KeyV',
    ec: store('vec') !== '0', ns: store('vns') !== '0',
    mic: store('vmic') || '', out: store('vout') || '',
    keyDown: false, loudAt: 0, talking: false, db: -100, testing: false,
  };

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
  function paintAvatar(el, name, av) { // sem avatar escolhido: inicial com cor fixa por nome
    let h = 0;
    for (const ch of name) h = (h * 31 + ch.codePointAt(0)) % 360;
    el.style.setProperty('--h', String(h));
    if (!AVATARS.includes(av)) { delete el.dataset.av; el.textContent = [...name.trim()][0] || '?'; return; }
    if (el.dataset.av === av) return;
    el.dataset.av = av;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('aria-hidden', 'true');
    svg.append(document.createElementNS('http://www.w3.org/2000/svg', 'use'));
    svg.firstChild.setAttribute('href', `#av-${av}`);
    el.replaceChildren(svg);
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
      e = { id, name: 'Convidado', av: '', named: false, ready: false, born: Date.now(), seen: Date.now(),
        conn: null, sharing: false, call: null, out: null, tile: null,
        volume: 1, muted: false, blocked: false, wanted: 0, fails: 0, chatAt: 0, bytes: 0, bytesAt: 0,
        // voz
        audio: document.body.appendChild(Object.assign(document.createElement('audio'), { autoplay: true })),
        vpc: null, vsend: null, vq: [], vAt: 0, vfails: 0, vvol: 1,
        vmuted: false, vdeaf: false, talking: false, ping: null, lat: null, vinfo: '', vprev: null };
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
      if (myId > id) voiceStart(e);
      renderPeople();
    });
    c.on('data', (d) => { if (e.conn === c) onData(e, d); });
    c.on('close', () => { if (e.conn === c) dropPeer(id); });
    c.on('error', () => {});
  }

  const hello = () => ({ t: 'hello', name: myName, av: myAv, sharing: !!local, muted: voice.muted || !voice.track, deaf: voice.deaf, talking: voice.talking });
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
      e.av = AVATARS.includes(d.av) ? d.av : '';
      e.vmuted = d.muted === true;
      e.vdeaf = d.deaf === true;
      e.talking = d.talking === true && !e.vmuted; // quem chega no meio de uma fala já vê o anel aceso
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
    } else if (d.t === 'talk') {
      e.talking = d.on === true && !e.vmuted;
      ring(e.id, e.talking);
    } else if (d.t === 'vo' || d.t === 'va') {
      if (typeof d.sdp !== 'string' || d.sdp.length > 20000) return;
      if (d.t === 'vo') { if (myId < e.id) voiceAnswer(e, d.sdp); } // só aceito oferta de quem deve oferecer (maior ID)
      else if (e.vpc && e.vpc.signalingState === 'have-local-offer') {
        const pc = e.vpc;
        pc.setRemoteDescription({ type: 'answer', sdp: voiceSdp(d.sdp) })
          .then(() => { if (e.vpc === pc) voiceFlush(e); })
          .catch((err) => console.warn('BAGRENATION: resposta de voz recusada', err));
      }
    } else if (d.t === 'vi') {
      if (!e.vpc || !d.c || typeof d.c !== 'object' || e.vq.length > 60) return;
      e.vq.push(d.c);
      voiceFlush(e);
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
    voiceClose(e);
    e.audio.remove();
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
      paintAvatar(q('.avatar'), isLocal ? myName : e.name, isLocal ? myAv : e.av);
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
      video.muted = e.muted || e.blocked || voice.deaf; // ensurdecido: nem a voz nem o som das telas
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
    if (!isLocal) { volume(); sink(video); }
    $('stage').append(el);

    return {
      el, video,
      setName: labels,
      sync: () => { if (!isLocal) volume(); },
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
    for (const e of peers.values()) await voiceStats(e);
    renderPeople();
  }

  // ---------- pessoas e chat ----------
  // Lista lateral + cartões do canal de voz no palco. Atualiza no lugar (não recria),
  // para não derrubar o controle de volume que a pessoa está arrastando.
  function renderPeople() {
    const list = $('people');
    const grid = $('voiceGrid');
    const all = [{
      id: 'me', name: myName, av: myAv, you: true, sharing: !!local, talking: voice.talking,
      muted: voice.muted || !voice.track, deaf: voice.deaf, off: !voice.track,
      sub: !voice.track ? (voice.err ? 'sem microfone' : 'ligando o microfone…')
        : voice.deaf ? 'som desligado' : voice.muted ? 'microfone mudo'
          : voice.mode === 'ptt' ? `push-to-talk · ${keyName(voice.key)}` : 'na voz',
    }];
    for (const e of peers.values()) {
      if (!e.ready) continue;
      const on = !!e.vpc && e.vpc.connectionState === 'connected';
      all.push({
        id: e.id, name: e.name, av: e.av, e, sharing: e.sharing, talking: e.talking, muted: e.vmuted, deaf: e.vdeaf, off: !on,
        sub: !on ? 'conectando a voz…' : e.ping === null ? 'na voz' : `ping ${e.ping} ms · atraso ${e.lat} ms`,
        tip: on ? e.vinfo : '',
      });
    }
    const ids = new Set(all.map((p) => p.id));
    for (const el of [...list.children, ...grid.children]) if (!ids.has(el.dataset.id)) el.remove();
    const find = (box, id) => [...box.children].find((el) => el.dataset.id === id);
    for (const p of all) {
      let li = find(list, p.id);
      if (!li) {
        li = $('personTpl').content.firstElementChild.cloneNode(true);
        li.dataset.id = p.id;
        const range = li.querySelector('.pvol');
        if (p.e) {
          range.addEventListener('input', () => {
            p.e.vvol = Number(range.value);
            range.style.setProperty('--fill', `${range.value * 100}%`);
            voiceOut(p.e);
          });
        } else range.remove();
        list.append(li);
      }
      let card = find(grid, p.id);
      if (!card) {
        card = $('vcardTpl').content.firstElementChild.cloneNode(true);
        card.dataset.id = p.id;
        grid.append(card);
      }
      const label = p.you ? `${p.name} (você)` : p.name;
      li.querySelector('.nm').textContent = label;
      li.querySelector('.sub').textContent = p.sub;
      li.title = p.tip || '';
      card.querySelector('.vname').textContent = label;
      if (p.e) li.querySelector('.pvol').setAttribute('aria-label', `Volume da voz de ${p.name}`);
      for (const el of [li, card]) {
        paintAvatar(el.querySelector('.avatar'), p.name, p.av);
        el.querySelector('.avatar').classList.toggle('speaking', p.talking);
        el.classList.toggle('is-live', p.sharing);
        el.classList.toggle('is-muted', p.muted);
        el.classList.toggle('is-deaf', p.deaf);
        el.classList.toggle('is-off', p.off);
      }
    }
    $('peopleCount').textContent = String(all.length);
    $('peopleCountSide').textContent = String(all.length);
    myFace();
    $('meAvatar').classList.toggle('speaking', voice.talking);
    // faixa de estado da voz: conexão + microfone, sempre à vista (com tela aberta o canal de voz some do palco)
    const others = all.length - 1;
    const linked = all.filter((p) => p.e && !p.off).length;
    const link = !others ? 'Na voz · só você na sala' : linked < others ? `Voz conectando (${linked}/${others})` : `Na voz com ${others} ${others === 1 ? 'pessoa' : 'pessoas'}`;
    const mic = !voice.track ? (voice.err ? 'sem microfone: ninguém te ouve' : 'ligando o microfone…')
      : voice.deaf ? 'som da sala desligado' : voice.muted ? 'microfone mudo'
        : voice.mode === 'ptt' ? `push-to-talk: segure ${keyName(voice.key)} para falar` : 'microfone ligado';
    $('vbText').textContent = `${link} · ${mic}`;
    $('voiceBar').dataset.state = !voice.track ? (voice.err ? 'off' : 'wait') : voice.muted ? 'muted' : linked < others ? 'wait' : 'on';
    $('micFixBtn').hidden = !!voice.track || !voice.err;
    renderTalk();
  }
  function renderTalk() { // quem está falando agora, por nome
    const names = [...(voice.talking ? ['você'] : []), ...[...peers.values()].filter((e) => e.ready && e.talking).map((e) => e.name)];
    $('vbTalk').textContent = names.length ? `falando: ${names.join(', ')}` : '';
  }
  // anel de "falando" no avatar da pessoa (lista e canal de voz)
  function ring(id, on) {
    for (const el of document.querySelectorAll(`[data-id="${CSS.escape(id)}"] > .avatar`)) el.classList.toggle('speaking', on);
    if (id === 'me') $('meAvatar').classList.toggle('speaking', on);
    renderTalk();
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
    openMic(); // entrar na sala = entrar no canal de voz
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
    closeMic();
    $('hearBtn').hidden = true;
    togglePop('voicePop', false);
    if (peer) { const p = peer; peer = null; p.destroy(); }
    if (wakeLock) wakeLock.release().catch(() => {});
    room = null;
    history.replaceState(null, '', location.pathname);
    document.title = 'BAGRENATION';
    $('room').hidden = true;
    $('home').hidden = false;
    myFace();
  }

  // ---------- voz: microfone ----------
  // Pedido de captura pensado para atraso mínimo e fidelidade: 48 kHz, estéreo quando o aparelho dá
  // (com cancelamento de eco o navegador entrega mono) e a menor latência de captura que houver.
  // Eco/ruído são os filtros do próprio navegador, ligáveis; desligados, o som vai cru.
  // As aberturas andam em fila, e cada uma fecha a captura anterior antes de pedir a nova: o navegador
  // não troca os filtros (eco/ruído) de um microfone que ainda está aberto com a combinação antiga.
  let micSeq = 0;
  let micJob = Promise.resolve();
  function openMic(byUser) {
    const seq = ++micSeq;
    micJob = micJob.then(() => (seq === micSeq && room ? doOpenMic(byUser) : undefined));
    return micJob;
  }
  async function doOpenMic(byUser) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { voice.err = 'NotSupportedError'; renderVoice(); return; }
    closeMic(true);
    const ask = (id) => navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: voice.ec, noiseSuppression: voice.ns, autoGainControl: voice.ns,
        channelCount: { ideal: 2 }, sampleRate: { ideal: 48000 }, latency: { ideal: 0 },
        ...(id ? { deviceId: { exact: id } } : {}),
      },
    });
    let stream;
    try {
      // microfone lembrado sumiu (desplugado): cai para o padrão do sistema
      stream = await ask(voice.mic).catch((err) => { if (!voice.mic || err.name === 'NotAllowedError') throw err; return ask(''); });
    } catch (err) {
      voice.err = err.name || 'Error';
      broadcast(hello());
      renderVoice();
      if (byUser || err.name !== 'NotAllowedError') {
        toast(err.name === 'NotAllowedError' ? 'O navegador bloqueou o microfone. Libere no cadeado da barra de endereço.'
          : err.name === 'NotFoundError' ? 'Nenhum microfone encontrado. Você continua ouvindo a sala.'
            : 'Não foi possível abrir o microfone. Você continua ouvindo a sala.', 7000);
      } else toast('Sem microfone: você ouve a sala, mas ninguém te ouve.', 6000);
      return;
    }
    if (!room) { stream.getTracks().forEach((t) => t.stop()); return; } // saiu da sala durante o pedido
    const track = voice.track = stream.getAudioTracks()[0];
    voice.tap = track.clone();
    voice.err = '';
    track.addEventListener('ended', () => { // aparelho desconectado
      if (voice.track !== track) return;
      closeMic();
      voice.err = 'NotFoundError';
      toast('O microfone foi desconectado.', 6000);
      openMic();
    });
    gate();
    for (const e of peers.values()) if (e.vsend) e.vsend.replaceTrack(track).catch(() => {});
    broadcast(hello());
    renderVoice();
    listDevices();
  }
  function closeMic(swapping) {
    if (!swapping) micSeq++;
    micTest(false);
    for (const t of [voice.track, voice.tap]) if (t) t.stop();
    voice.track = voice.tap = null;
    if (voice.talking) { voice.talking = false; broadcast({ t: 'talk', on: false }); }
    if (!swapping) {
      for (const e of peers.values()) if (e.vsend) e.vsend.replaceTrack(null).catch(() => {});
      renderVoice();
    }
  }

  // Portão do microfone: a faixa enviada só fica ligada quando é para transmitir (voz detectada, ou tecla
  // do push-to-talk). Ligar/desligar a faixa não renegocia nada: a voz sai no quadro seguinte.
  const HOLD = 400; // ms com o portão aberto depois da última sílaba (não corta fim de palavra)
  const threshold = () => (voice.sens ? -70 + voice.sens * 0.5 : -50); // dB; sens 0 = sempre aberto (-50 só acende o anel)
  function gate() {
    const metering = !!ac && ac.state === 'running';
    const lv = voice.tap ? level(tapStream()) : 0;
    voice.db = lv > 0 ? 20 * Math.log10(lv) : -100;
    const now = performance.now();
    if (voice.db > threshold()) voice.loudAt = now;
    const loud = now - voice.loudAt < HOLD;
    // sem medidor (navegador ainda não liberou o áudio da página): transmite direto, sem portão
    const open = !!voice.track && !voice.muted && (voice.mode === 'ptt' ? voice.keyDown : (!voice.sens || !metering || loud));
    if (voice.track && voice.track.enabled !== open) voice.track.enabled = open;
    const talking = open && loud;
    if (talking !== voice.talking) {
      voice.talking = talking;
      broadcast({ t: 'talk', on: talking });
      ring('me', talking);
    }
    if (!$('voicePop').hidden) {
      const pct = Math.max(0, Math.min(100, (voice.db + 70) * 2));
      $('vuFill').style.width = `${pct}%`;
      $('vu').setAttribute('aria-valuenow', String(Math.round(pct)));
      $('vu').classList.toggle('is-open', open);
    }
  }
  let tapStreamOf = null;
  function tapStream() { // o medidor recebe um MediaStream; guarda um por faixa
    if (!tapStreamOf || tapStreamOf.getAudioTracks()[0] !== voice.tap) tapStreamOf = new MediaStream([voice.tap]);
    return tapStreamOf;
  }
  setInterval(() => { if (room) gate(); }, 40);

  function setMuted(on) {
    voice.muted = on;
    if (!on && voice.deaf) voice.deaf = false; // religar o microfone também religa o som (como no Discord)
    voiceChanged();
  }
  function setDeaf(on) {
    voice.deaf = on;
    if (on) { voice.wasMuted = voice.muted; voice.muted = true; } else voice.muted = voice.wasMuted;
    voiceChanged();
  }
  function voiceChanged() {
    gate();
    for (const e of peers.values()) { voiceOut(e); if (e.tile) e.tile.sync(); }
    broadcast(hello());
    renderVoice();
  }

  const keyName = (code) => code.replace(/^(Key|Digit)/, '').replace(/^Numpad/, 'Num ');
  function renderVoice() {
    const has = !!voice.track;
    const mic = $('micBtn');
    mic.dataset.state = has ? 'on' : 'none';
    mic.setAttribute('aria-pressed', String(has && voice.muted));
    setIcon($('micIcon'), has && !voice.muted ? 'mic' : 'mic-off');
    mic.setAttribute('aria-label', !has ? 'Ligar o microfone' : voice.muted ? 'Microfone mudo. Reativar' : 'Silenciar microfone');
    mic.title = mic.getAttribute('aria-label');
    const deaf = $('deafBtn');
    deaf.setAttribute('aria-pressed', String(voice.deaf));
    setIcon($('deafIcon'), voice.deaf ? 'headset-off' : 'headset');
    deaf.setAttribute('aria-label', voice.deaf ? 'Som da sala desligado. Reativar' : 'Desligar o som da sala');
    deaf.title = deaf.getAttribute('aria-label');
    $('voiceMode').value = voice.mode;
    $('sensWrap').hidden = voice.mode !== 'vad';
    $('pttWrap').hidden = voice.mode !== 'ptt';
    $('sens').value = voice.sens;
    $('sens').style.setProperty('--fill', `${voice.sens}%`);
    $('sensOut').textContent = voice.sens ? `${Math.round(threshold())} dB` : 'sempre aberto';
    $('vuMark').style.left = `${voice.sens}%`;
    $('vuMark').hidden = voice.mode !== 'vad' || !voice.sens;
    $('pttKeyBtn').textContent = pickingKey ? 'Aperte…' : keyName(voice.key);
    $('pttKeyBtn').setAttribute('aria-pressed', String(pickingKey));
    $('ecToggle').checked = voice.ec;
    $('nsToggle').checked = voice.ns;
    $('micTestBtn').disabled = !has;
    $('micTestBtn').setAttribute('aria-pressed', String(voice.testing));
    $('micTestBtn').textContent = voice.testing ? 'Parar' : 'Testar';
    renderPeople();
  }

  // Aparelhos: os nomes só aparecem depois da permissão do microfone.
  async function listDevices() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    const devs = await navigator.mediaDevices.enumerateDevices().catch(() => []);
    const fill = (sel, kind, cur, word) => {
      const list = devs.filter((d) => d.kind === kind && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications');
      sel.textContent = '';
      sel.append(new Option('Padrão do sistema', ''));
      list.forEach((d, i) => sel.append(new Option(d.label || `${word} ${i + 1}`, d.deviceId)));
      sel.value = list.some((d) => d.deviceId === cur) ? cur : '';
      return list.length;
    };
    fill($('micSelect'), 'audioinput', voice.mic, 'Microfone');
    const outs = fill($('outSelect'), 'audiooutput', voice.out, 'Saída');
    $('outWrap').hidden = !outs || !('setSinkId' in HTMLMediaElement.prototype); // Firefox/Safari: só a saída do sistema
  }
  function sink(el) { // manda o som do elemento para a saída escolhida
    if (el.setSinkId && (voice.out || el.sinkId)) el.setSinkId(voice.out).catch(() => {});
  }

  // Teste de microfone: você se ouve (retorno direto da captura, com os mesmos filtros que a sala recebe).
  const testAudio = new Audio();
  function micTest(on) {
    on = on && !!voice.tap;
    if (on === voice.testing) return;
    voice.testing = on;
    testAudio.srcObject = on ? tapStream() : null;
    if (on) { sink(testAudio); testAudio.play().catch(() => {}); }
    renderVoice();
  }

  // ---------- voz: conexão com cada pessoa ----------
  // Uma RTCPeerConnection só de áudio por pessoa, direta (malha), negociada pelo canal de dados.
  // Separada da chamada da tela: volume, mudo e qualidade de cada uma não se misturam.
  const VOICE_KBPS = 128;
  // Opus para conversa com atraso mínimo e som cheio: 48 kHz estéreo, até 128 kb/s, correção de perda
  // embutida (FEC), sem DTX (não corta o som ambiente) e quadros de 10 ms em vez dos 20 ms de fábrica.
  // Vale nos dois sentidos: aplico na minha descrição e na que chega.
  function voiceSdp(sdp) {
    const pt = (sdp.match(/a=rtpmap:(\d+) opus\/48000\/2/i) || [])[1];
    if (!pt) return sdp;
    const fmtp = `a=fmtp:${pt} minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1;maxaveragebitrate=${VOICE_KBPS * 1000};maxplaybackrate=48000;usedtx=0;ptime=10`;
    sdp = sdp.replace(/a=ptime:\d+\r\n/g, '');
    const line = new RegExp(`a=fmtp:${pt} [^\\r\\n]*`);
    sdp = line.test(sdp) ? sdp.replace(line, fmtp) : sdp.replace(new RegExp(`a=rtpmap:${pt} [^\\r\\n]*`), `$&\r\n${fmtp}`);
    return sdp.replace(fmtp, `${fmtp}\r\na=ptime:10`);
  }

  function voicePc(e) {
    voiceClose(e);
    e.vAt = Date.now();
    const pc = e.vpc = new RTCPeerConnection({ iceServers: ICE });
    pc.addEventListener('icecandidate', (ev) => { if (ev.candidate && e.vpc === pc) send(e, { t: 'vi', c: ev.candidate.toJSON() }); });
    pc.addEventListener('track', (ev) => {
      if (e.vpc !== pc) return;
      // Reprodução com o menor atraso que a rede permitir: o alvo do buffer de jitter vai a zero
      // (o navegador ainda segura o mínimo necessário para não picotar).
      ev.receiver.jitterBufferTarget = 0;
      ev.receiver.playoutDelayHint = 0; // nome antigo da mesma regulagem
      e.audio.srcObject = new MediaStream([ev.track]);
      voiceOut(e);
      sink(e.audio);
      e.audio.play().catch((err) => { if (err.name === 'NotAllowedError') needGesture(); });
    });
    pc.addEventListener('connectionstatechange', () => {
      if (e.vpc !== pc) return;
      if (pc.connectionState === 'connected') { e.vfails = 0; voiceTune(pc); }
      if (pc.connectionState === 'failed') {
        voiceClose(e);
        e.vAt = Date.now() - 12000; // nova tentativa em ~3 s (manutenção periódica)
        if (++e.vfails === 2) toast(`A voz com ${e.name} não conectou. Redes muito restritas (CGNAT, rede corporativa) bloqueiam a conexão direta.`, 8000);
      }
      renderPeople();
    });
    return pc;
  }
  function voiceClose(e) {
    const pc = e.vpc;
    e.vpc = null; e.vsend = null; e.vq = []; e.vprev = null; e.ping = e.lat = null; e.vinfo = '';
    if (pc) pc.close();
    e.audio.srcObject = null;
  }
  function voiceFlush(e) { // candidatos que chegaram antes da descrição remota esperam aqui
    if (!e.vpc || !e.vpc.remoteDescription) return;
    for (const c of e.vq.splice(0)) e.vpc.addIceCandidate(c).catch(() => {});
  }
  const voiceFail = (e, pc) => (err) => {
    console.warn('BAGRENATION: negociação de voz falhou', err);
    if (e.vpc === pc) { voiceClose(e); e.vAt = Date.now() - 12000; }
  };
  function voiceStart(e) { // quem tem o maior ID oferece
    if (!e.conn || !e.conn.open || typeof RTCPeerConnection === 'undefined') return;
    const pc = voicePc(e);
    e.vsend = pc.addTransceiver(voice.track || 'audio', { direction: 'sendrecv' }).sender;
    pc.createOffer()
      .then((o) => pc.setLocalDescription({ type: 'offer', sdp: voiceSdp(o.sdp) }))
      .then(() => { if (e.vpc === pc) send(e, { t: 'vo', sdp: pc.localDescription.sdp }); })
      .catch(voiceFail(e, pc));
  }
  async function voiceAnswer(e, sdp) {
    if (typeof RTCPeerConnection === 'undefined') return;
    const pc = voicePc(e);
    try {
      await pc.setRemoteDescription({ type: 'offer', sdp: voiceSdp(sdp) });
      const tr = pc.getTransceivers()[0];
      if (!tr) throw new Error('oferta sem áudio');
      tr.direction = 'sendrecv';
      e.vsend = tr.sender;
      if (voice.track) await tr.sender.replaceTrack(voice.track);
      const a = await pc.createAnswer();
      await pc.setLocalDescription({ type: 'answer', sdp: voiceSdp(a.sdp) });
      if (e.vpc !== pc) return;
      send(e, { t: 'va', sdp: pc.localDescription.sdp });
      voiceFlush(e);
    } catch (err) { voiceFail(e, pc)(err); }
  }
  function voiceTune(pc) { // teto de 128 kb/s e prioridade alta para a voz na fila de envio
    for (const sender of pc.getSenders()) {
      const params = sender.getParameters();
      if (!params.encodings || !params.encodings.length) continue;
      Object.assign(params.encodings[0], { maxBitrate: VOICE_KBPS * 1000, priority: 'high', networkPriority: 'high' });
      sender.setParameters(params).catch((err) => console.warn('BAGRENATION: ajuste de voz não aplicado', err));
    }
  }
  function voiceOut(e) { // volume desta pessoa + ensurdecer
    e.audio.volume = e.vvol;
    e.audio.muted = voice.deaf || e.vvol === 0;
  }
  // Navegador recusou tocar som antes de um clique na página: o primeiro clique/tecla libera.
  let soundBlocked = false;
  function needGesture() {
    if (soundBlocked) return;
    soundBlocked = true;
    $('hearBtn').hidden = false; // o botão é o convite; qualquer clique ou tecla na página serve
    const go = () => {
      if (!soundBlocked) return;
      soundBlocked = false;
      $('hearBtn').hidden = true;
      for (const e of peers.values()) {
        if (e.audio.srcObject) e.audio.play().catch(() => {});
        if (e.blocked && e.tile) e.tile.unblock(); // o mesmo clique libera o som das telas
      }
    };
    document.addEventListener('pointerdown', go, { once: true, capture: true });
    document.addEventListener('keydown', go, { once: true, capture: true });
  }

  // Números da voz com cada pessoa (getStats): ping = ida e volta da rede; atraso estimado de boca a
  // ouvido = metade do ping + buffer de jitter + fila da placa de som + 1 quadro de 10 ms.
  async function voiceStats(e) {
    const pc = e.vpc;
    if (!pc || pc.connectionState !== 'connected') return null;
    let st;
    try { st = await pc.getStats(); } catch { return null; }
    if (e.vpc !== pc) return null;
    let rtt, inb, out, play, pair;
    st.forEach((r) => {
      if (r.type === 'candidate-pair' && r.nominated && r.currentRoundTripTime !== undefined) { rtt = r.currentRoundTripTime; pair = r; }
      if (r.type === 'inbound-rtp' && r.kind === 'audio') inb = r;
      if (r.type === 'outbound-rtp' && r.kind === 'audio') out = r;
      if (r.type === 'media-playout') play = r;
    });
    if (rtt === undefined) st.forEach((r) => { if (r.type === 'remote-inbound-rtp' && r.roundTripTime !== undefined) rtt = r.roundTripTime; });
    const now = performance.now();
    const cur = {
      at: now,
      jbd: inb ? inb.jitterBufferDelay || 0 : 0, jbe: inb ? inb.jitterBufferEmittedCount || 0 : 0,
      pd: play ? play.totalPlayoutDelay || 0 : 0, ps: play ? play.totalSamplesCount || 0 : 0,
      sent: out ? out.packetsSent || 0 : 0, bytes: out ? out.bytesSent || 0 : 0,
      recv: inb ? inb.packetsReceived || 0 : 0, lost: inb ? inb.packetsLost || 0 : 0,
    };
    const prev = e.vprev || cur;
    e.vprev = cur;
    const per = (a, b) => (b > 0 ? a / b : 0);
    const dt = (cur.at - prev.at) / 1000;
    const buffer = per(cur.jbd - prev.jbd, cur.jbe - prev.jbe) * 1000 || (inb && inb.jitterBufferEmittedCount ? per(inb.jitterBufferDelay, inb.jitterBufferEmittedCount) * 1000 : 0);
    const playout = per(cur.pd - prev.pd, cur.ps - prev.ps) * 1000 || (play ? per(play.totalPlayoutDelay, play.totalSamplesCount) * 1000 : 0);
    const codec = (id) => (id && st.get(id)) || {};
    const info = {
      name: e.name,
      rttMs: rtt === undefined ? null : rtt * 1000,
      bufferMs: buffer, playoutMs: playout,
      latencyMs: rtt === undefined ? null : rtt * 500 + buffer + playout + 10,
      jitterMs: inb && inb.jitter !== undefined ? inb.jitter * 1000 : null,
      lossPct: per(cur.lost - prev.lost, (cur.recv - prev.recv) + (cur.lost - prev.lost)) * 100,
      packetsPerSecond: per(cur.sent - prev.sent, dt), kbpsSent: per((cur.bytes - prev.bytes) * 8, dt) / 1000,
      audioLevelIn: inb ? inb.audioLevel : null,
      sendCodec: codec(out && out.codecId), recvCodec: codec(inb && inb.codecId),
      route: pair && st.get(pair.localCandidateId) ? `${st.get(pair.localCandidateId).candidateType}/${(st.get(pair.remoteCandidateId) || {}).candidateType}` : '',
    };
    if (info.rttMs !== null) {
      e.ping = Math.round(info.rttMs);
      e.lat = Math.round(info.latencyMs);
      e.vinfo = `Atraso estimado de boca a ouvido: ${e.lat} ms = metade do ping (${e.ping} ms) + buffer ${Math.round(buffer)} ms + saída de som ${Math.round(playout)} ms + 10 ms de quadro`
        + (info.jitterMs !== null ? ` · jitter ${info.jitterMs.toFixed(1).replace('.', ',')} ms` : '')
        + ` · perda ${info.lossPct.toFixed(1).replace('.', ',')}%`;
    }
    return info;
  }
  // Para conferir no console (e no teste automático): números e codec reais de cada conexão de voz.
  window.BAGRENATION = {
    voiceStats: async () => (await Promise.all([...peers.values()].map(voiceStats))).filter(Boolean),
    mic: () => (voice.track ? { ...voice.track.getSettings(), enabled: voice.track.enabled, levelDb: Math.round(voice.db), talking: voice.talking } : null),
  };

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
      // voz que não fechou (ou caiu): quem oferece tenta de novo
      if (myId > e.id && (!e.vpc || e.vpc.connectionState !== 'connected') && now - e.vAt > 15000) voiceStart(e);
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
    // mantém a tela acesa enquanto há conversa ou transmissão
    const busy = local || peers.size;
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
  // Teclado mecânico antigo ao digitar nos campos: estalo curto de ruído filtrado + batida grave.
  // Espaço, Enter e Backspace soam mais graves. Baixo, e no mesmo liga/desliga dos cliques.
  let clack = null;
  function keySound(key) {
    if (!sfxOn() || (navigator.userActivation && !navigator.userActivation.hasBeenActive)) return;
    if (!ac) ac = new AudioContext();
    if (ac.state === 'suspended') ac.resume().catch(() => {});
    if (!clack) {
      clack = ac.createBuffer(1, Math.round(ac.sampleRate * 0.03), ac.sampleRate);
      const d = clack.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length) ** 2;
    }
    const big = key === ' ' || key === 'Enter' || key === 'Backspace';
    const t = ac.currentTime;
    const src = ac.createBufferSource();
    src.buffer = clack;
    src.playbackRate.value = (big ? 0.55 : 0.9) + Math.random() * 0.25; // cada tecla um pouco diferente
    const band = ac.createBiquadFilter();
    band.type = 'bandpass'; band.frequency.value = big ? 1400 : 2600; band.Q.value = 1.2;
    const gain = ac.createGain();
    gain.gain.value = 0.1;
    src.connect(band).connect(gain).connect(ac.destination);
    src.start(t);
    const thud = ac.createOscillator();
    const env = ac.createGain();
    thud.type = 'square'; thud.frequency.value = big ? 70 : 110;
    env.gain.setValueAtTime(0.025, t);
    env.gain.exponentialRampToValueAtTime(0.0001, t + 0.03);
    thud.connect(env).connect(ac.destination);
    thud.start(t); thud.stop(t + 0.035);
  }
  document.addEventListener('keydown', (ev) => {
    const el = ev.target;
    if (!(el instanceof HTMLInputElement) || el.type !== 'text' || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    if (ev.key.length === 1 || ev.key === 'Backspace' || ev.key === 'Enter' || ev.key === 'Delete') keySound(ev.key);
  });
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
    if (local) local.tile.el.classList.toggle('speaking', mine > SOUND);
    for (const e of peers.values()) {
      if (e.tile) e.tile.el.classList.toggle('speaking', level(e.tile.video.srcObject) > SOUND);
    }
  }, 120);

  // ---------- eventos da página ----------
  function setName(v) {
    myName = clean(v) || myName;
    $('nameInput').value = $('homeName').value = myName;
    store('name', myName);
    myFace();
  }
  function myFace() { // meu avatar no início e na sala; fora da sala vale o nome que está no campo
    const name = room ? myName : clean($('homeName').value) || '?';
    for (const el of document.querySelectorAll('.js-avatar')) paintAvatar(el, name, myAv);
  }
  // Galeria de avatares: a primeira opção é a inicial do nome (padrão)
  function renderGallery(tab) { // sem aba pedida: abre na aba do avatar atual
    const group = (av) => $('av-' + av).dataset.g;
    const groups = [...new Set(AVATARS.map(group))];
    tab = tab || (myAv ? group(myAv) : groups[0]);
    const tabs = $('avatarTabs');
    tabs.textContent = '';
    for (const g of groups) {
      const t = document.createElement('button');
      t.type = 'button';
      t.className = 'chip';
      t.textContent = g;
      t.setAttribute('aria-pressed', String(g === tab));
      t.addEventListener('click', () => { renderGallery(g); tabs.querySelector('[aria-pressed="true"]').focus(); sfx('tick'); });
      tabs.append(t);
    }
    const grid = $('avatarGrid');
    grid.textContent = '';
    for (const av of ['', ...AVATARS.filter((a) => group(a) === tab)]) {
      const label = av ? $('av-' + av).dataset.n || av.replace('-', ' ') : 'inicial do nome';
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'avatar';
      b.setAttribute('aria-pressed', String(av === myAv));
      b.setAttribute('aria-label', av ? `Avatar ${label}` : 'Inicial do nome');
      b.title = label;
      paintAvatar(b, room ? myName : clean($('homeName').value) || '?', av);
      b.addEventListener('click', () => {
        myAv = av;
        store('avatar', av);
        $('avatarDlg').close();
        if (local) local.tile.setName();
        broadcast(hello());
        renderPeople();
        sfx('ok');
      });
      grid.append(b);
    }
  }
  for (const b of document.querySelectorAll('.js-avatar')) {
    b.addEventListener('click', () => { renderGallery(); $('avatarDlg').showModal(); });
  }
  $('homeName').addEventListener('input', myFace);
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
    setIcon($('discordIcon'), on ? 'chat-off' : 'chat');
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
  const POPS = { settings: 'settingsBtn', voicePop: 'voiceBtn' }; // painel -> botão que abre
  function togglePop(id, open) {
    $(id).hidden = !open;
    $(POPS[id]).setAttribute('aria-expanded', String(open));
    if (id === 'voicePop') { if (open) { listDevices(); renderVoice(); } else micTest(false); }
  }
  const toggleSettings = (open) => togglePop('settings', open);
  for (const [id, btn] of Object.entries(POPS)) {
    $(btn).addEventListener('click', () => {
      const open = $(id).hidden;
      for (const other of Object.keys(POPS)) if (other !== id && !$(other).hidden) togglePop(other, false);
      togglePop(id, open);
    });
  }
  document.addEventListener('pointerdown', (ev) => {
    for (const [id, btn] of Object.entries(POPS)) {
      if (!$(id).hidden && !ev.target.closest(`#${id}, #${btn}`)) togglePop(id, false);
    }
  });

  // ---------- eventos da voz ----------
  $('micBtn').addEventListener('click', () => { if (voice.track) setMuted(!voice.muted); else openMic(true); });
  $('micFixBtn').addEventListener('click', () => openMic(true));
  $('deafBtn').addEventListener('click', () => setDeaf(!voice.deaf));
  $('micSelect').addEventListener('change', () => { voice.mic = $('micSelect').value; store('vmic', voice.mic); openMic(true); });
  $('outSelect').addEventListener('change', () => {
    voice.out = $('outSelect').value; store('vout', voice.out);
    for (const e of peers.values()) { sink(e.audio); if (e.tile) sink(e.tile.video); }
    sink(testAudio);
  });
  $('micTestBtn').addEventListener('click', () => micTest(!voice.testing));
  $('voiceMode').addEventListener('change', () => {
    voice.mode = $('voiceMode').value === 'ptt' ? 'ptt' : 'vad';
    store('vmode', voice.mode);
    voice.keyDown = false;
    renderVoice();
  });
  $('sens').addEventListener('input', () => { voice.sens = Number($('sens').value); store('vsens', String(voice.sens)); renderVoice(); });
  for (const [id, key] of [['ecToggle', 'ec'], ['nsToggle', 'ns']]) {
    $(id).addEventListener('change', () => {
      voice[key] = $(id).checked;
      store(`v${key}`, voice[key] ? '1' : '0');
      openMic(true); // os filtros são do navegador: reabre o microfone com a nova combinação
    });
  }
  let pickingKey = false;
  $('pttKeyBtn').addEventListener('click', () => { pickingKey = true; renderVoice(); });
  const typing = (el) => !!(el && el.closest && el.closest('input:not([type="range"]):not([type="checkbox"]), textarea, select, [contenteditable]'));
  document.addEventListener('keydown', (ev) => {
    if (pickingKey) { // escolhendo a tecla do push-to-talk (Esc cancela)
      ev.preventDefault(); ev.stopPropagation();
      if (ev.code !== 'Escape') { voice.key = ev.code; store('vkey', ev.code); }
      pickingKey = false;
      renderVoice();
    } else if (room && voice.mode === 'ptt' && ev.code === voice.key && !typing(ev.target)) {
      ev.preventDefault(); // Espaço como tecla não aciona o botão em foco
      voice.keyDown = true;
    }
  }, true);
  document.addEventListener('keyup', (ev) => { if (ev.code === voice.key) voice.keyDown = false; }, true);
  window.addEventListener('blur', () => { voice.keyDown = false; }); // o navegador só entrega teclas com a guia em foco
  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) navigator.mediaDevices.addEventListener('devicechange', listDevices);
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
    else if (!$('voicePop').hidden) { togglePop('voicePop', false); $('voiceBtn').focus(); }
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
  renderVoice();
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
