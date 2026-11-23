/* BAGRENATION — chat de voz e compartilhamento de tela ponto a ponto (WebRTC).
 *
 * Como funciona:
 *  - Cada pessoa é um "membro" com um ID próprio na sinalização do Worker do BAGRENATION (signal.js; sem servidor de terceiros).
 *  - A sala tem um ID fixo de "diretório" (bagrenation-<código>-dir). Quem chega tenta falar com ele;
 *    se ninguém responde, assume o papel. O diretório só distribui a lista de membros.
 *    Se quem o mantinha sai, outro membro assume: o link da sala nunca morre.
 *  - Os membros se conectam todos entre si (malha) por canal de dados; quem transmite
 *    abre uma chamada de mídia para cada um. Vídeo e áudio nunca passam por servidor.
 *  - Servidor fixo (como um servidor do Discord): abrir = já estar na sala, vendo quem está online e o chat.
 *    O canal de voz é à parte: entra e sai pelo botão. Cada par de membros que está no canal tem uma conexão
 *    só de áudio (RTCPeerConnection própria, negociada pelo canal de dados), separada da tela.
 *  - Chat de texto permanente (com imagem, GIF e vídeo) fica num Worker da Cloudflare (server/worker.js).
 */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // sem 0/o, 1/l/i
  // Servidor único e permanente. ?servidor=nome abre outro (os testes usam isso para não entrar no de verdade).
  const asked = new URLSearchParams(location.search).get('servidor') || '';
  const SERVER = /^[a-z0-9-]{1,40}$/.test(asked) ? asked : 'bagrenation';
  const CHAT = `https://bagrenation-chat.alissondelittig.workers.dev/s/${SERVER}`;
  // S-0065: servidor fechado. O convite chega no link (#convite=<token>) ou colado na tela de entrar; fica guardado só até entrar.
  const invFrom = (v) => { const t = String(v || '').trim(); const m = t.match(/convite=([A-Za-z0-9_-]{40,80})/) || t.match(/^([A-Za-z0-9_-]{40,80})$/); return m ? m[1] : ''; };
  if (invFrom(location.hash)) { store('inv', invFrom(location.hash)); history.replaceState(null, '', location.pathname + location.search); }
  // Qualidade da transmissão (S-1363): resolução 720p / 1080p / fonte (sem reduzir) e 30 / 60 fps. Padrão 720p30.
  // Escolha antiga (até a 1.2.0) é convertida: 1440p60 vira fonte a 60 fps.
  const RES = { 720: { w: 1280, h: 720 }, 1080: { w: 1920, h: 1080 }, src: null };
  const oldQ = { '720p30': ['720', 30], '1080p30': ['1080', 30], '1080p60': ['1080', 60], '1440p60': ['src', 60] }[store('quality')] || [];
  let qRes = ['720', '1080', 'src'].includes(store('qres')) ? store('qres') : oldQ[0] || '720';
  let qFps = [30, 60].includes(Number(store('qfps'))) ? Number(store('qfps')) : oldQ[1] || 30;
  // ICE (STUN + TURN do Cloudflare, quando ligado) vem do Worker junto com a sinalização: ver signal.js.
  const PEER_OPTS = {};
  const CONN_OPTS = { reliable: true, serialization: 'json' };
  const CAN_SHARE = !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
  // App para PC (desktop/, Tauri): esta mesma página com tecla global, bandeja e avisos. No navegador é undefined.
  const DESK = window.__TAURI__ || null;
  // App para Android (mobile/, Capacitor, S-0057): esta mesma página; mobile.js põe a ponte nativa em window.BAGRE_MOB.
  const MOB = window.BAGRE_MOB || null;

  // ---------- estado ----------
  let room = null;          // nome do servidor (fixo) quando conectado
  let inVoice = false;      // estou num canal de voz?
  // Canais (S-1363): vários de texto e de voz, guardados no servidor do chat. 'chat' (com o histórico de antes)
  // e 'voz' (o canal das versões antigas) são fixos. Na malha, cada pessoa diz em que canal de voz está (vch).
  const FIXED_CH = ['chat', 'voz'];
  let chans = [{ id: 'chat', kind: 'text', name: 'chat', uid: '', last: 0 }, { id: 'voz', kind: 'voice', name: 'Canal de voz', uid: '', last: 0 }];
  let textCh = 'chat';      // canal de texto aberto
  let myVch = '';           // canal de voz em que estou ('' = fora)
  let viewVch = 'voz';      // canal de voz mostrado no palco
  const unreadBy = new Map(); // canal de texto -> mensagens que chegaram sem eu ver
  const chanOf = (id) => chans.find((c) => c.id === id);
  const chanLabel = (id) => (chanOf(id) || { name: id === 'voz' ? 'Canal de voz' : 'chat' }).name;
  const withMe = (e) => inVoice && !!e.vch && e.vch === myVch; // está comigo no mesmo canal de voz
  // Modo foco (S-1351): '' normal · 'screen' tela grande · 'people' grade de quem está no canal. Lembrado no navegador.
  let focusMode = ['screen', 'people'].includes(store('focus')) ? store('focus') : '';
  let chatOff = store('chatoff') === '1'; // S-1378: chat da direita retraído no canal de voz (lembrado no navegador)
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
  const isUp = (a) => /^u-[a-z2-7]{20}$/.test(a || ''); // imagem enviada pela pessoa (S-1397): u-<id da mídia no Worker>
  const avOk = (a) => (AVATARS.includes(a) || isUp(a) ? a : a ? 'bagre' : ''); // avatar que não existe mais volta para o bagre clássico
  let myAv = avOk(store('avatar'));
  // Identidade (S-1357): chave aleatória deste aparelho (só fica aqui); o servidor do chat guarda o hash dela (uid),
  // que é o que os outros veem. Com ela dá para editar e apagar as próprias mensagens. Site e app são aparelhos diferentes.
  let myKey = store('key');
  if (!/^[a-f0-9]{32}$/.test(myKey || '')) {
    myKey = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
    store('key', myKey);
  }
  let myUid = /^[a-f0-9]{16}$/.test(store('uid') || '') ? store('uid') : '';
  const sess = { ok: false, mt: '', owner: false, locked: '' }; // S-0065
  const sq = () => (sess.mt && myUid ? `u=${myUid}&t=${sess.mt}` : '');
  const mediaUrl = (id) => `${CHAT}/m/${id}${sq() ? `?${sq()}` : ''}`;
  // Status: 'auto' = online (vira ausente sozinho após 10 min parado) · 'idle' = ausente fixo · 'off' = invisível
  let stPick = ['auto', 'idle', 'off'].includes(store('status')) ? store('status') : 'auto';
  let autoIdle = false;
  const members = new Map(); // uid -> { uid, name, av, seen, st } (lista que o servidor do chat guarda)
  // Voz. Preferências lembradas no navegador; mudo/ensurdecido valem só até fechar a página.
  const voice = {
    track: null,      // faixa do microfone que vai para a sala (ligada/desligada pelo portão)
    tap: null,        // cópia sempre ligada, só para medir o nível e para o teste de microfone
    err: '',          // por que não há microfone (nome do erro do navegador)
    muted: false, deaf: false, wasMuted: false,
    mode: store('vmode') === 'ptt' ? 'ptt' : 'vad',
    sens: Math.min(100, Math.max(0, Number(store('vsens') ?? 0) || 0)), // 0 = sempre aberto (padrão)
    key: store('vkey') || 'KeyV',
    muteKey: store('vmutekey') || '', // só no app para PC: tecla global de mutar
    ec: store('vec') !== '0', ns: store('vns') !== '0',
    mic: store('vmic') || '', out: store('vout') || '',
    keyDown: false, loudAt: 0, talking: false, db: -100, testing: false,
  };

  // Bagre DJ (S-1566): estado da música de cada canal de voz (vem do servidor do chat) e o player deste aparelho
  const PLAYER = `${DESK || MOB ? 'https://alissonlittig.github.io/bagrenation/' : ''}player.html?v=1566`;
  const PLAYER_ORIGIN = new URL(PLAYER, location.href).origin;
  const djVol0 = Number(store('djvol'));
  const dj = {
    st: new Map(),            // canal de voz -> { q, i, at, pos, paused, loop, v }
    off: null, rtt: Infinity, // relógio do servidor menos o meu (ms)
    frame: null, ready: false, tk: null, hello: 0, // iframe do player e o último aviso dele
    aud: null, urls: new Map(), fb: new Set(), pre: '', // app (S-1580): <audio> com o endereço do yt-dlp; fb = vídeos que voltaram ao player oficial
    loaded: '', loadAt: 0, fixAt: 0, endSent: '', durSent: '', badSent: '', sentVol: '', blocked: false, err153: false,
    vol: Number.isFinite(djVol0) && store('djvol') !== null ? Math.min(100, Math.max(0, djVol0)) : 70,
    mute: store('djmute') === '1',
    pref: 'auto',             // painel: 'auto' (aparece quando toca) · 'open' · 'closed' (só nesta sessão)
    n: 0, res: null, auto: null, qKey: '', eph: 0, fixes: 0,
  };

  // ---------- utilidades ----------
  // A sinalização (signal.js) só é carregada quando vai ser usada (Press Start ou link de sala), não junto com a página.
  let peerLib = null;
  function loadPeer() { // Promise<boolean>: a biblioteca está pronta?
    if (!peerLib) {
      peerLib = new Promise((resolve) => {
        const s = document.createElement('script');
        s.src = 'signal.js?v=0065';
        s.onload = () => { Peer.setup(() => `${CHAT.replace('https:', 'wss:')}/rtc${sq() ? `?${sq()}` : ''}`); resolve(true); }; // S-0065: com a sessão
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
  const dirId = () => `bagrenation-${room}-dir`;
  const isMember = (id) => typeof id === 'string' && id.startsWith(`bagrenation-${room}-m-`) && id.length < 64;
  const setIcon = (use, name) => use.setAttribute('href', `#i-${name}`);
  const narrow = () => window.matchMedia('(max-width: 960px)').matches;
  function paintAvatar(el, name, av) { // sem avatar escolhido: inicial com cor fixa por nome
    if (av === 'dj') av = 'bagre-dj'; // o Bagre DJ (bot de música)
    let h = 0;
    for (const ch of name) h = (h * 31 + ch.codePointAt(0)) % 360;
    el.style.setProperty('--h', String(h));
    if (!AVATARS.includes(av) && !isUp(av)) { delete el.dataset.av; el.textContent = [...name.trim()][0] || '?'; return; }
    if (el.dataset.av === av && (!isUp(av) || el.dataset.mt === sess.mt)) return;
    el.dataset.av = av;
    if (isUp(av)) { // foto própria (PNG/JPG/WEBP/GIF): <img> do Worker, igual para todos (S-0065: com a sessão)
      el.dataset.mt = sess.mt;
      el.replaceChildren(Object.assign(document.createElement('img'), { src: mediaUrl(av.slice(2)), alt: '', draggable: false }));
      return;
    }
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
      e = { id, name: 'Convidado', av: '', named: false, invoice: false, ready: false, born: Date.now(), seen: Date.now(),
        conn: null, sharing: false, call: null, out: null, tile: null,
        muted: false, blocked: false, wanted: 0, fails: 0, bytes: 0, bytesAt: 0, vch: '',
        // voz
        audio: document.body.appendChild(Object.assign(document.createElement('audio'), { autoplay: true })),
        vpc: null, vsend: null, vq: [], vAt: 0, vfails: 0,
        vmuted: false, vdeaf: false, talking: false, ping: null, lat: null, vinfo: '', vprev: null };
      peers.set(id, e);
    }
    const old = e.conn;
    e.conn = c;
    if (old) old.close();
    c.on('open', () => {
      if (e.conn !== c) return;
      e.ready = true; e.seen = Date.now();
      c.send(hello()); // voz e tela começam quando a resposta disser que a pessoa está no canal (linkVoice)
      renderPeople();
    });
    c.on('data', (d) => { if (e.conn === c) onData(e, d); });
    c.on('close', () => { if (e.conn === c) dropPeer(id); });
    c.on('error', () => {});
  }

  // voice: só o canal de sempre, para a versão antiga (que não conhece vch) não tentar falar com outro canal
  const hello = () => ({ t: 'hello', uid: myUid, name: myName, av: myAv, voice: inVoice && myVch === 'voz', vch: inVoice ? myVch : '', sharing: !!local, muted: voice.muted || !voice.track, deaf: voice.deaf, talking: voice.talking });
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
      e.av = avOk(d.av);
      e.uid = /^[a-f0-9]{16}$/.test(d.uid || '') ? d.uid : '';
      e.vmuted = d.muted === true;
      e.vdeaf = d.deaf === true;
      e.talking = d.talking === true && !e.vmuted; // quem chega no meio de uma fala já vê o anel aceso
      const before = withMe(e);
      const prev = e.vch;
      e.vch = typeof d.vch === 'string' && /^[a-z0-9]{1,12}$/.test(d.vch) ? d.vch : d.voice === true ? 'voz' : ''; // versão antiga: canal de sempre
      e.invoice = !!e.vch;
      const after = withMe(e);
      if (prev && prev !== e.vch) offVoice(e);
      if (before && !after) { note(`${e.name} saiu do canal de voz`); sfx('out'); }
      if (e.vch && e.vch !== prev) {
        e.wanted = Date.now();
        const where = e.vch === 'voz' ? 'no canal de voz' : `em ${chanLabel(e.vch)}`;
        if (after || (!first && !inVoice)) { note(`${e.name} entrou ${where}`); sfx('in'); }
        if (!first && (after || !inVoice) && DESK && (!document.hasFocus() || document.documentElement.classList.contains('app-hidden'))) DESK.core.invoke('notify', { body: `${e.name} entrou ${where}` }).catch(() => {});
        else if (!first && (after || !inVoice) && MOB && MOB.hidden()) MOB.notify(`${e.name} entrou ${where}`);
      }
      if (!e.sharing) { e.stopped = false; removeStream(e); }
      if (e.tile) e.tile.setName(e.name);
      linkVoice(e);
      renderPeople();
    } else if (d.t === 'want') {
      if (local) callPeer(e);
    } else if (d.t === 'unwatch') { // parou de assistir: some só para ele, a voz (outra conexão) segue
      e.nowatch = true;
      if (e.out) { const c = e.out; e.out = null; c.close(); } // fecha o par de vídeo/áudio da tela: nada mais é enviado a ele
      renderPeople();
    } else if (d.t === 'watch') {
      e.nowatch = false;
      if (local) callPeer(e);
      renderPeople();
    } else if (d.t === 'talk') {
      e.talking = d.on === true && !e.vmuted;
      ring(e.id, e.talking);
    } else if (d.t === 'vo' || d.t === 'va') {
      if (typeof d.sdp !== 'string' || d.sdp.length > 20000) return;
      if (d.t === 'vo') { if (myId < e.id && withMe(e)) voiceAnswer(e, d.sdp); } // só aceito oferta de quem deve oferecer (maior ID), os dois no canal
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
    if (e.named && withMe(e) && !silent && !leaving) { note(`${e.name} saiu do canal de voz`); sfx('out'); }
    renderPeople();
  }

  // ---------- canal de voz: entrar e sair ----------
  // Voz e tela só existem entre quem está no canal. Fora dele a pessoa segue online (lista e chat).
  function linkVoice(e) {
    if (!withMe(e) || !e.conn || !e.conn.open) return;
    if (myId > e.id && !e.vpc) voiceStart(e); // quem tem o maior ID oferece
    if (local && !e.out) callPeer(e);
  }
  function offVoice(e) { // a pessoa (ou eu) saiu do canal: fecha voz e tela com ela
    voiceClose(e);
    removeStream(e);
    e.stopped = false; e.nowatch = false; e.talking = false;
    if (e.out) { const c = e.out; e.out = null; c.close(); }
  }
  function joinVoice(ch) { // entrar num canal de voz (o mostrado, se não disser qual); trocar de canal = sair e entrar
    const c = typeof ch === 'string' ? chanOf(ch) : null;
    ch = c && c.kind === 'voice' ? c.id : viewVch;
    if (inVoice && myVch !== ch) leaveVoice(true);
    viewVch = ch;
    setView('voice');
    if (inVoice || !room) return;
    inVoice = true;
    myVch = ch;
    vcSend(); // S-0059: o servidor conta o tempo de chamada
    layout(); // mostra o botão Retrair do topo
    openMic(); // negado = aviso curto + botão "Ativar microfone" na faixa da voz
    sfx('in');
    broadcast(hello());
    for (const e of peers.values()) linkVoice(e);
    renderVoice(); layout();
  }
  function leaveVoice(swapping) {
    if (!inVoice) return;
    stopShare();
    inVoice = false;
    myVch = '';
    vcSend(); // S-0059
    for (const e of peers.values()) offVoice(e);
    closeMic();
    voice.keyDown = false;
    $('hearBtn').hidden = true;
    togglePop('voicePop', false);
    broadcast(hello());
    if (swapping !== true) sfx('out');
    renderVoice(); layout();
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
    if (e.nowatch || !local || !withMe(e) || !peer || !peer.open || !e.conn || !e.conn.open) return;
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
    const q = target(local && local.stream.getVideoTracks()[0]);
    const motion = $('hint').value === 'motion';
    for (const sender of pc.getSenders()) {
      if (!sender.track) continue;
      const params = sender.getParameters();
      if (!params.encodings || !params.encodings.length) continue;
      if (sender.track.kind === 'video') {
        params.encodings[0].maxBitrate = q.bitrate;
        params.encodings[0].maxFramerate = q.fps;
        params.encodings[0].scaleResolutionDownBy = q.scale; // captura maior que o escolhido (navegador ignorou o limite): o codificador reduz
        params.degradationPreference = motion ? 'maintain-framerate' : 'maintain-resolution';
      } else {
        params.encodings[0].maxBitrate = 256_000;
      }
      sender.setParameters(params).catch((err) => console.warn('BAGRENATION: limite de envio não aplicado', err));
    }
  }

  // O que vai de fato para o codificador: o tamanho que sai da captura (cabendo na resolução escolhida), os fps e a
  // taxa de bits proporcional (~0,09 bit por pixel por quadro: 720p30 ~2,5 Mb/s, 1080p60 ~11 Mb/s; teto 20 Mb/s).
  function target(track) {
    const s = track ? track.getSettings() : {};
    const r = RES[qRes];
    let w = s.width || (r ? r.w : 1920);
    let h = s.height || (r ? r.h : 1080);
    const scale = r && h > r.h ? h / r.h : 1;
    w = Math.round(w / scale); h = Math.round(h / scale);
    return { w, h, fps: qFps, scale, bitrate: Math.round(Math.min(20e6, Math.max(1.5e6, w * h * qFps * 0.09))) };
  }
  const qName = () => `${qRes === 'src' ? 'Fonte' : `${qRes}p`} · ${qFps} fps`;
  const mbps = (bps) => `${(bps / 1e6).toFixed(1).replace('.', ',')} Mb/s`;
  const videoWant = () => { const r = RES[qRes]; return { ...(r ? { width: { max: r.w }, height: { max: r.h } } : {}), frameRate: { ideal: qFps, max: qFps } }; };
  function renderQuality() {
    for (const b of $('qRes').children) b.setAttribute('aria-pressed', String(b.dataset.v === qRes));
    for (const b of $('qFps').children) b.setAttribute('aria-pressed', String(Number(b.dataset.v) === qFps));
    const t = target(local && local.stream.getVideoTracks()[0]);
    $('qNote').textContent = `${qName()}: até ${mbps(t.bitrate)} de envio para cada pessoa assistindo.`;
    $('settingsBtn').title = `Qualidade da transmissão: ${qName()}`;
  }
  function applyQuality() {
    store('qres', qRes); store('qfps', String(qFps));
    store('hint', $('hint').value);
    band.n = 0; band.warned = ''; $('qWarn').hidden = true;
    renderQuality();
    if (!local) return;
    const track = local.stream.getVideoTracks()[0];
    track.contentHint = $('hint').value;
    // applyConstraints troca o conjunto inteiro: na "fonte" o limite de tamanho sai
    track.applyConstraints(videoWant()).catch(() => {}).then(() => {
      renderQuality();
      for (const e of peers.values()) if (e.out && e.out.peerConnection) tune(e.out.peerConnection);
    });
  }
  // Internet não aguenta: 3 leituras seguidas (~6 s) limitadas pela rede ou com banda estimada abaixo de 60% do pedido.
  const band = { n: 0, warned: '' };
  function checkBand(limited, avail, t) {
    band.n = limited || (avail > 0 && avail < t.bitrate * 0.6) ? band.n + 1 : 0;
    if (band.n < 3 || band.warned === qName()) return;
    band.warned = qName();
    const msg = `Sua internet não está aguentando ${qName()}${avail > 0 ? ` (envio estimado ${mbps(avail)}, pedido ${mbps(t.bitrate)})` : ''}. Baixe a resolução ou os fps.`;
    $('qWarn').textContent = msg;
    $('qWarn').hidden = false;
    toast(msg, 9000);
  }

  // "Sem Discord": nenhum navegador separa um app de dentro do som do sistema. O que dá certo é
  // não oferecer a tela inteira (som do sistema = Discord junto) e pedir só janela ou guia, cujo
  // áudio é só delas (windowAudio 'window' no Chrome/Edge recentes; guia em qualquer Chromium).
  const noDiscord = () => store('nodiscord') === '1';

  async function capture() {
    const nd = noDiscord();
    try {
      return await navigator.mediaDevices.getDisplayMedia({
        video: videoWant(),
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

  // Som do PC sem a voz do BAGRENATION (S-1354). O som do sistema que o navegador captura leva junto a voz
  // dos amigos tocando aqui, e quem assiste se escuta. No app, o Windows captura tudo menos o próprio app
  // (sysaudio.rs) e esta faixa entra no lugar. No site, o Chromium recente faz o mesmo com restrictOwnAudio.
  let pcAudio = null;
  async function startPcAudio() {
    stopPcAudio(); // trocar de tela: a captura anterior sai
    const ac = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
    await ac.audioWorklet.addModule('pcm-worklet.js?v=1354');
    const node = new AudioWorkletNode(ac, 'pcm-in', { numberOfInputs: 0, outputChannelCount: [2] });
    const dest = ac.createMediaStreamDestination();
    dest.channelCount = 2;
    node.connect(dest);
    const ch = new DESK.core.Channel();
    ch.onmessage = (m) => { const b = m instanceof ArrayBuffer ? m : new Uint8Array(m).buffer; node.port.postMessage(b, [b]); };
    try {
      await DESK.core.invoke('sys_audio_start', { onChunk: ch });
    } catch (err) {
      ac.close();
      throw err;
    }
    await ac.resume();
    const track = dest.stream.getAudioTracks()[0];
    pcAudio = { track, stop() { DESK.core.invoke('sys_audio_stop').catch(() => {}); track.stop(); ac.close().catch(() => {}); } };
    return track;
  }
  function stopPcAudio() { if (pcAudio) { pcAudio.stop(); pcAudio = null; } }

  async function share() {
    if (!CAN_SHARE) return;
    if (!inVoice) joinVoice(); // tela é dentro do canal de voz, como no Discord
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
    let leak = false; // som do sistema com risco de levar a voz do BAGRENATION junto
    if (audio && surface === 'monitor') {
      if (DESK) {
        try {
          const pc = await startPcAudio();
          stream.removeTrack(audio); audio.stop(); stream.addTrack(pc); audio = pc;
        } catch (err) {
          console.warn('BAGRENATION: som do PC sem a voz não abriu (Windows 10 2004+)', err);
          leak = true;
        }
      } else if (!audio.getSettings().restrictOwnAudio) leak = true;
    }
    video.contentHint = $('hint').value;
    video.addEventListener('ended', () => { if (local && local.stream === stream) stopShare(); });
    if (audio) { audio.contentHint = 'music'; audio.enabled = !audioMuted; }

    const swapping = !!local;
    if (swapping) { local.stream.getTracks().forEach((t) => t.stop()); if (pcAudio && pcAudio.track !== audio) stopPcAudio(); }
    else local = { stream, tile: makeTile(null) };
    local.stream = stream;
    local.tile.attach(stream);
    for (const e of peers.values()) callPeer(e);
    if (!swapping) broadcast(hello());
    renderShareUi();
    renderPeople();
    layout();
    band.n = 0; band.warned = ''; $('qWarn').hidden = true;
    renderQuality();
    if (leak) toast(DESK ? 'Este Windows não separa o som do BAGRENATION: quem assiste pode ouvir a própria voz. Atualize o Windows ou compartilhe a janela do jogo/vídeo.'
      : 'Para não vazar a voz do BAGRENATION na tela inteira, compartilhe pelo app para PC (ou escolha a janela/guia do vídeo).', 9000);
    else if (cut) toast('Tela inteira com "Sem Discord" ligado: o áudio foi cortado, porque o som do sistema leva o Discord junto. Para ter som, troque para a janela do jogo ou uma guia.', 9000);
    else if (!audio) {
      toast(surface === 'window'
        ? 'Sem áudio: este navegador não envia o som de janelas. Para ter som, use "Trocar tela" e escolha uma guia' + (noDiscord() ? '.' : ' ou a tela inteira.')
        : 'Sem áudio nesta transmissão. Para enviar som, use "Trocar tela" e marque "Compartilhar áudio" no seletor.', 8000);
    } else if (noDiscord()) {
      toast(surface === 'browser' ? 'Enviando só o som desta guia. O Discord fica de fora.' : 'Enviando só o som desta janela. O Discord fica de fora.', 5000);
    } else if (surface === 'monitor') {
      toast('Enviando o som do computador todo (sem a voz do BAGRENATION), Discord incluído. Para tirar o Discord, ligue "Sem Discord".', 6000);
    }
  }

  function stopShare() {
    if (!local) return;
    local.stream.getTracks().forEach((t) => t.stop());
    stopPcAudio();
    local.tile.el.remove();
    local = null;
    for (const e of peers.values()) { e.nowatch = false; if (e.out) e.out.close(); }
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
    if (!e || e.stopped || !withMe(e)) { call.close(); return; } // só aceito tela de quem está comigo no canal de voz (e que eu não parei de assistir)
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

  // "Parar de assistir" (como no Discord): fecha a chamada da tela (vídeo e som dela) e avisa quem transmite
  // para parar de enviar a esta pessoa. A voz é outra conexão e continua.
  function unwatch(e) {
    e.stopped = true;
    send(e, { t: 'unwatch' });
    removeStream(e);
    renderPeople();
  }
  function watch(e) {
    e.stopped = false;
    e.wanted = Date.now();
    send(e, { t: 'watch' });
    renderPeople();
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
    el.classList.toggle('is-local', isLocal);
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
    function volume() { // volume da tela desta pessoa (lembrado por pessoa, até 200%)
      const pf = pref(e);
      const silent = e.muted || pf.m || pf.s === 0;
      outLevel(video, pf.s, e.muted || pf.m || e.blocked || voice.deaf); // ensurdecido: nem a voz nem o som das telas
      range.value = e.muted || pf.m ? 0 : pf.s;
      range.style.setProperty('--fill', `${range.value * 50}%`);
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
        const pf = pref(e);
        if (pf.m) { e.muted = false; setPref(e, { m: false, s: pf.s || 0.5 }); return; }
        e.muted = !(e.muted || pf.s === 0);
        if (!e.muted && pf.s === 0) setPref(e, { s: 0.5 }); else volume();
      });
      range.addEventListener('input', () => { e.muted = false; setPref(e, { s: Number(range.value), m: false }); });
      q('.unblock').addEventListener('click', () => { // um clique já autoriza o som na página inteira
        for (const p of peers.values()) if (p.blocked && p.tile) p.tile.unblock();
      });
    }

    q('.js-focus').addEventListener('click', () => {
      const on = !el.classList.contains('focused');
      for (const t of $('stage').querySelectorAll('.tile')) t.classList.remove('focused', 'auto-focused');
      el.classList.toggle('focused', on);
      layout();
    });
    el.addEventListener('click', (ev) => { // modo foco na tela: clicar na miniatura troca a tela grande
      if (focusOn() === 'screen' && !el.classList.contains('focused') && !ev.target.closest('button, input')) pickTile(el);
    });
    q('.tile-video').addEventListener('dblclick', (ev) => { if (!ev.target.closest('button, input')) toggleFull(el); });
    q('.js-full').addEventListener('click', () => toggleFull(el));
    if (document.pictureInPictureEnabled) {
      q('.js-pip').addEventListener('click', () => {
        if (document.pictureInPictureElement === video) document.exitPictureInPicture();
        else video.requestPictureInPicture().catch(() => toast('A janela flutuante só abre depois que o vídeo começa.'));
      });
    } else q('.js-pip').hidden = true;

    labels();
    if (!isLocal) {
      volume(); sink(video);
      q('.js-unwatch').addEventListener('click', () => unwatch(e));
    } else q('.js-unwatch').hidden = true;
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
        unboost(video);
        video.srcObject = null;
        el.remove();
      },
    };
  }

  // ---------- tela cheia imersiva (S-1564): só a transmissão, como no YouTube; controles e cursor somem parados ----------
  let fsTimer = 0;
  function toggleFull(el) {
    const video = el.querySelector('video');
    if (document.fullscreenElement) { document.exitFullscreen().catch(() => {}); return; }
    if (el.requestFullscreen) {
      el.requestFullscreen({ navigationUI: 'hide' }).then(() => { // celular: tela deitada gira junto (onde o navegador deixa)
        if (video.videoWidth > video.videoHeight && screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape').catch(() => {});
      }).catch(() => {});
    } else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen(); // iPhone: tela cheia nativa do vídeo
  }
  function fsWake() {
    const t = document.fullscreenElement;
    if (!t || !t.classList.contains('tile')) return;
    t.classList.remove('fs-idle');
    clearTimeout(fsTimer);
    fsTimer = setTimeout(() => { if (t.querySelector('.tile-bar:hover')) fsWake(); else t.classList.add('fs-idle'); }, 2500);
  }
  document.addEventListener('fullscreenchange', () => {
    const t = document.fullscreenElement;
    for (const x of document.querySelectorAll('.tile')) {
      const on = x === t;
      x.classList.toggle('is-full', on);
      if (!on) x.classList.remove('fs-idle');
      const b = x.querySelector('.js-full');
      setIcon(b.querySelector('use'), on ? 'full-exit' : 'full');
      b.setAttribute('aria-label', on ? 'Sair da tela cheia (Esc)' : `Tela cheia: ${x.querySelector('.tile-name').textContent}`);
      b.title = b.getAttribute('aria-label');
    }
    clearTimeout(fsTimer);
    if (t) fsWake();
    else if (screen.orientation && screen.orientation.unlock) try { screen.orientation.unlock(); } catch { /* sem trava */ }
    if (DESK) DESK.core.invoke('fullscreen', { on: !!t }).catch(() => {}); // app: a janela inteira em tela cheia (cobre a barra do Windows)
    if (MOB) { const v = t && t.querySelector('video'); MOB.fullscreen(!!t, !!v && v.videoWidth > v.videoHeight); } // Android: tela deitada gira o celular
  });
  for (const t of ['pointermove', 'pointerdown', 'keydown', 'wheel']) document.addEventListener(t, fsWake, { passive: true, capture: true });
  document.addEventListener('keydown', (ev) => { // Esc sai mesmo onde o navegador/WebView não tira sozinho
    if (ev.key === 'Escape' && document.fullscreenElement && document.fullscreenElement.classList.contains('tile')) document.exitFullscreen().catch(() => {});
  });

  function layout() {
    const stage = $('stage');
    const tiles = [...stage.querySelectorAll('.tile')];
    const n = tiles.length;
    const fm = focusOn();
    if (fm === 'screen' && n && !stage.querySelector('.tile.focused')) { // foco na tela: sempre uma grande, a de outra pessoa antes da minha prévia
      (tiles.find((t) => !t.classList.contains('is-local')) || tiles[0]).classList.add('focused', 'auto-focused');
    }
    $('empty').hidden = n > 0 && fm !== 'people';
    if (n) stage.dataset.count = n > 4 ? 'many' : String(n); else delete stage.dataset.count;
    stage.classList.toggle('has-focus', !!stage.querySelector('.tile.focused'));
    stage.classList.toggle('only-one', n === 1);
    for (const t of tiles) t.querySelector('.js-focus').setAttribute('aria-pressed', String(t.classList.contains('focused')));
    renderFocus(tiles);
  }

  // ---------- modo foco: esconde lateral, #chat e barras; fica só o canal de voz ----------
  function focusOn() { return (inVoice && $('room').dataset.view === 'voice' && focusMode) || ''; }
  function renderFocus(tiles) {
    const fm = focusOn();
    const box = $('room');
    if (fm) box.dataset.focus = fm; else delete box.dataset.focus;
    $('focusBar').hidden = !fm;
    $('focusTop').hidden = !inVoice || box.dataset.view !== 'voice'; // botão óbvio no topo enquanto se está no canal
    if (chatOff) box.dataset.chatoff = ''; else delete box.dataset.chatoff;
    $('chatTop').hidden = box.dataset.view !== 'voice' || !!fm; // só aparece onde o chat fica à direita (CSS esconde abaixo de 1200px)
    $('chatTop').setAttribute('aria-pressed', String(chatOff));
    $('chatTopLabel').textContent = chatOff ? 'Mostrar chat' : 'Retrair chat';
    $('focusBtn').setAttribute('aria-pressed', String(!!fm));
    $('focusScreen').setAttribute('aria-pressed', String(fm === 'screen'));
    $('focusPeople').setAttribute('aria-pressed', String(fm === 'people'));
    const pick = $('focusScreens'); // mais de uma tela aberta: escolher qual fica grande
    pick.hidden = fm !== 'screen' || tiles.length < 2;
    if (!pick.hidden) {
      pick.replaceChildren(...tiles.map((t) => {
        const name = t.querySelector('.tile-name').textContent;
        const b = Object.assign(document.createElement('button'), { type: 'button', className: 'seg-btn', textContent: name, title: `Tela de ${name}` });
        b.setAttribute('aria-pressed', String(t.classList.contains('focused')));
        b.setAttribute('aria-label', `Tela de ${name}`);
        b.addEventListener('click', () => pickTile(t));
        return b;
      }));
    }
    if (fm && narrow()) togglePanel(false);
  }
  function pickTile(t) {
    for (const x of $('stage').querySelectorAll('.tile')) x.classList.remove('focused', 'auto-focused');
    t.classList.add('focused');
    layout();
  }
  function setFocus(m) {
    focusMode = m;
    store('focus', m);
    if (m) store('focuslast', m);
    else for (const t of $('stage').querySelectorAll('.tile.auto-focused')) t.classList.remove('focused', 'auto-focused');
    const go = () => { layout(); if (chatSeen()) readAll(); };
    if (document.startViewTransition && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      document.startViewTransition(go).ready.catch(() => {}); // pulada (janela escondida etc.): só não anima
    } else go();
  }
  function toggleChat() {
    chatOff = !chatOff;
    store('chatoff', chatOff ? '1' : '0');
    layout();
    if (chatSeen()) readAll();
  }
  function toggleFocus() {
    if (focusOn()) { setFocus(''); return; }
    const last = store('focuslast');
    setFocus(last === 'screen' || last === 'people' ? last : $('stage').querySelector('.tile') ? 'screen' : 'people');
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
          checkBand(o.qualityLimitationReason === 'bandwidth', avail || 0, target(local.stream.getVideoTracks()[0]));
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

  // ---------- pessoas ----------
  // Lateral: quem está no canal de voz (embaixo do canal) e quem está só online; cartões do canal no palco.
  // Atualiza no lugar (não recria), para não derrubar o controle de volume que a pessoa está arrastando.
  function renderPeople() {
    const vlist = $('people');
    const olist = $('online');
    const grid = $('voiceGrid');
    const all = [{
      id: 'me', name: myName, av: myAv, you: true, invoice: inVoice, vch: myVch, sharing: !!local, talking: voice.talking,
      muted: inVoice && (voice.muted || !voice.track), deaf: inVoice && voice.deaf, off: inVoice && !voice.track,
      sub: !inVoice ? 'online' : !voice.track ? (voice.err ? 'sem microfone' : 'ligando o microfone…')
        : voice.deaf ? 'som desligado' : voice.muted ? 'microfone mudo'
          : voice.mode === 'ptt' ? `push-to-talk · ${keyName(voice.key)}` : 'na voz',
    }];
    for (const e of peers.values()) {
      if (!e.ready) continue;
      const on = !!e.vpc && e.vpc.connectionState === 'connected';
      const linked = withMe(e);
      all.push({
        id: e.id, name: e.name, av: e.av, e, invoice: e.invoice, vch: e.vch, sharing: e.sharing, stopped: e.stopped, talking: e.invoice && e.talking,
        muted: e.invoice && e.vmuted, deaf: e.invoice && e.vdeaf, off: linked && !on,
        sub: !e.invoice ? 'online' : !linked ? (e.vdeaf ? 'som desligado' : e.vmuted ? 'microfone mudo' : 'na voz')
          : !on ? 'conectando a voz…' : e.ping === null ? 'na voz' : `ping ${e.ping} ms · atraso ${e.lat} ms`,
        tip: linked && on ? e.vinfo : '',
      });
    }
    for (const [ch, s] of dj.st) { // o Bagre DJ aparece no canal enquanto tem música, como um bot do Discord
      const c = djCur(s);
      const wait = !c && s.stay > srvNow(); // S-0033: !join ou a fila acabou: o DJ fica um pouco no canal esperando
      if ((c || wait) && chanOf(ch)) all.push({ id: `dj-${ch}`, name: 'Bagre DJ', av: 'dj', bot: true, invoice: true, vch: ch, sub: c ? `${s.paused ? 'pausado' : 'tocando'}: ${c.t}` : 'esperando: !p <nome>', tip: c ? c.t : 'Peça com !p <nome ou link>', sharing: false, stopped: false, talking: false, muted: false, deaf: false, off: false });
    }
    // cada canal de voz tem a sua lista embaixo dele; o palco mostra o canal de voz aberto (viewVch)
    const lists = new Map([...document.querySelectorAll('ul.people-voice[data-ch]')].map((ul) => [ul.dataset.ch, ul]));
    const where = new Map(all.filter((p) => p.invoice).map((p) => [p.id, p.vch]));
    for (const [vch, ul] of lists) for (const el of [...ul.children]) if (where.get(el.dataset.id) !== vch) el.remove();
    for (const el of [...grid.children]) if (where.get(el.dataset.id) !== viewVch) el.remove();
    const find = (box, id) => [...box.children].find((el) => el.dataset.id === id);
    const counts = new Map();
    for (const p of all) {
      if (!p.invoice) continue;
      counts.set(p.vch, (counts.get(p.vch) || 0) + 1);
      const vl = lists.get(p.vch);
      let li = vl ? find(vl, p.id) : null;
      if (vl && !li) {
        li = $('personTpl').content.firstElementChild.cloneNode(true);
        li.dataset.id = p.id;
        const range = li.querySelector('.pvol');
        if (p.e) {
          li.tabIndex = 0; // Enter, botão direito ou toque longo: volume desta pessoa
          range.addEventListener('input', () => {
            range.style.setProperty('--fill', `${range.value * 50}%`);
            setPref(p.e, { v: Number(range.value), m: false });
          });
          li.querySelector('.wbtn').addEventListener('click', () => (p.e.stopped ? watch(p.e) : unwatch(p.e)));
        } else { range.remove(); li.querySelector('.wbtn').remove(); }
        vl.append(li);
      }
      let card = p.vch === viewVch ? find(grid, p.id) : null;
      if (!card && p.vch === viewVch) {
        card = $('vcardTpl').content.firstElementChild.cloneNode(true);
        card.dataset.id = p.id;
        if (p.e) card.querySelector('.vwatch').addEventListener('click', () => watch(p.e));
        else card.querySelector('.vwatch').remove();
        grid.append(card);
      }
      const label = p.you ? `${p.name} (você)` : p.name;
      const mine = p.you || p.bot || withMe(p.e);
      const els = [];
      if (li) {
        li.querySelector('.nm').textContent = label;
        const pf = p.e ? pref(p.e) : null;
        li.querySelector('.sub').textContent = pf && pf.m ? 'silenciado para você' : pf && pf.v !== 1 ? `${p.sub} · ${Math.round(pf.v * 100)}%` : p.sub;
        li.title = p.e ? `${p.tip ? `${p.tip}\n` : ''}Botão direito: volume de ${p.name}` : '';
        li.classList.toggle('is-hushed', !!(pf && pf.m));
        const wb = li.querySelector('.wbtn');
        if (wb) {
          wb.hidden = !(p.sharing && mine);
          wb.textContent = p.stopped ? 'Assistir' : 'Parar de assistir';
          wb.setAttribute('aria-label', `${p.stopped ? 'Assistir' : 'Parar de assistir'} a tela de ${p.name}`);
        }
        const pv = li.querySelector('.pvol');
        if (pv) {
          pv.hidden = !mine;
          pv.setAttribute('aria-label', `Volume da voz de ${p.name}`);
          if (document.activeElement !== pv) { pv.value = pf.m ? 0 : pf.v; pv.style.setProperty('--fill', `${pv.value * 50}%`); }
        }
        els.push(li);
      }
      if (card) {
        const vw = card.querySelector('.vwatch');
        if (vw) { vw.hidden = !(p.sharing && p.stopped && mine); vw.setAttribute('aria-label', `Assistir a tela de ${p.name}`); }
        card.querySelector('.vname').textContent = label;
        els.push(card);
      }
      for (const el of els) {
        el.querySelector('.avatar').dataset.st = p.you ? myStatus() : p.bot ? 'on' : stOf(p.e.uid) || 'on';
        el.classList.toggle('is-bot', !!p.bot);
        paintAvatar(el.querySelector('.avatar'), p.name, p.av);
        el.querySelector('.avatar').classList.toggle('speaking', p.talking);
        el.classList.toggle('is-live', p.sharing);
        el.classList.toggle('is-stopped', !!p.stopped);
        el.classList.toggle('is-muted', p.muted);
        el.classList.toggle('is-deaf', p.deaf);
        el.classList.toggle('is-off', p.off);
      }
    }
    renderMembers();
    renderDj();
    for (const el of document.querySelectorAll('.chan[data-ch] .chan-count')) { const n = counts.get(el.closest('.chan').dataset.ch); el.textContent = n ? String(n) : ''; }
    $('emptyTitle').textContent = chanLabel(viewVch);
    const others = all.filter((p) => !p.you && !p.bot && p.invoice && p.vch === viewVch);
    $('emptySay').textContent = inVoice ? (others.length ? `Você e mais ${others.length} no canal` : '')
      : others.length ? `${others.length} ${others.length === 1 ? 'pessoa' : 'pessoas'} no canal` : 'Ninguém no canal ainda';
    myFace();
    $('meAvatar').classList.toggle('speaking', voice.talking);
    // faixa de estado da voz: conexão + microfone, sempre à vista no canal (com tela aberta os cartões saem do palco)
    const linked = others.filter((p) => !p.off).length;
    const link = !others.length ? 'Na voz · só você no canal' : linked < others.length ? `Voz conectando (${linked}/${others.length})` : `Na voz com ${others.length} ${others.length === 1 ? 'pessoa' : 'pessoas'}`;
    const mic = !voice.track ? (voice.err ? 'sem microfone: ninguém te ouve' : 'ligando o microfone…')
      : voice.deaf ? 'som da sala desligado' : voice.muted ? 'microfone mudo'
        : voice.mode === 'ptt' ? `push-to-talk: segure ${keyName(voice.key)} para falar` : 'microfone ligado';
    $('vbText').textContent = `${link} · ${mic}`;
    $('voiceBar').dataset.state = !voice.track ? (voice.err ? 'off' : 'wait') : voice.muted ? 'muted' : linked < others.length ? 'wait' : 'on';
    $('micFixBtn').hidden = !!voice.track || !voice.err;
    for (const id of ['voiceBar', 'dockWrap', 'vconn']) $(id).hidden = !inVoice;
    if (inVoice) $('vconnGo').textContent = chanLabel(myVch);
    $('focusFaces').replaceChildren(...all.filter((p) => p.invoice && !p.bot && inVoice && p.vch === myVch).map((p) => { // faixa de rostos do modo foco na tela
      const li = Object.assign(document.createElement('li'), { title: p.you ? `${p.name} (você)` : p.name });
      li.dataset.id = p.id;
      const av = Object.assign(document.createElement('span'), { className: 'avatar' });
      av.setAttribute('aria-hidden', 'true');
      av.dataset.st = p.you ? myStatus() : stOf(p.e.uid) || 'on';
      paintAvatar(av, p.name, p.av);
      av.classList.toggle('speaking', !!p.talking);
      li.append(av, Object.assign(document.createElement('span'), { className: 'sr-only', textContent: li.title }));
      return li;
    }));
    $('joinVoiceBtn').hidden = inVoice;
    for (const b of $('empty').querySelectorAll('.js-share')) b.hidden = !inVoice || !CAN_SHARE;
    for (const b of document.querySelectorAll('.chan[data-ch]')) b.classList.toggle('is-in', inVoice && b.dataset.ch === myVch);
    renderTalk();
  }
  // ---------- membros (S-1357): Online / Ausente / Offline, como no Discord ----------
  // A lista vem do servidor do chat (todo mundo que já entrou, com o estado de agora). Quem está no canal de voz
  // ganha o ícone e o anel de "falando" pela malha. Versão antiga (sem uid) aparece online como antes.
  const myStatus = () => (stPick === 'off' ? 'off' : stPick === 'idle' || autoIdle ? 'idle' : 'on');
  const ST_NAME = { on: 'Online', idle: 'Ausente', off: 'Offline' };
  function stOf(uid) {
    if (!uid) return '';
    if (uid === myUid) return myStatus();
    const m = members.get(uid);
    if (m) return m.st;
    return [...peers.values()].some((e) => e.uid === uid && e.ready) ? 'on' : '';
  }
  function renderMembers() {
    const mesh = new Map();
    const groups = { on: [], idle: [], off: [] };
    for (const e of peers.values()) {
      if (!e.ready || !e.named) continue; // ainda não disse quem é: não vira um "Convidado" a mais na lista
      if (e.uid && e.uid !== myUid) mesh.set(e.uid, e);
      if (!e.uid || !members.has(e.uid)) groups.on.push({ id: e.id, uid: e.uid, name: e.name, av: e.av, st: 'on', invoice: e.invoice, talking: e.invoice && e.talking });
    }
    groups[myStatus()].push({ id: 'me', uid: myUid, name: myName, av: myAv, st: myStatus(), you: true, invoice: inVoice, talking: voice.talking });
    for (const m of members.values()) {
      if (m.uid === myUid) continue;
      const e = mesh.get(m.uid);
      groups[m.st].push({ ...m, id: e ? e.id : `u-${m.uid}`, invoice: !!(e && e.invoice), talking: !!(e && e.invoice && e.talking) });
    }
    const byName = (a, b) => a.name.localeCompare(b.name, 'pt-BR', { sensitivity: 'base' });
    const item = (p) => {
      const li = document.createElement('li');
      li.dataset.id = p.id;
      if (p.uid) li.tabIndex = 0; // Enter abre o perfil
      li.classList.toggle('is-voice', !!p.invoice);
      const av = document.createElement('span');
      av.className = 'avatar';
      av.setAttribute('aria-hidden', 'true');
      if (p.uid) av.dataset.uid = p.uid;
      av.dataset.st = p.st;
      paintAvatar(av, p.name, p.av);
      av.classList.toggle('speaking', !!p.talking);
      const who = Object.assign(document.createElement('span'), { className: 'who' });
      who.append(Object.assign(document.createElement('span'), { className: 'nm', textContent: p.you ? `${p.name} (você)` : p.name }));
      const sub = p.you && stPick === 'off' ? 'invisível' : p.st === 'idle' ? 'ausente' : p.st === 'off' && p.seen ? `visto ${when(p.seen)}` : '';
      if (sub) who.append(Object.assign(document.createElement('span'), { className: 'sub', textContent: sub }));
      li.append(av, who);
      li.title = `${p.name} · ${p.you && stPick === 'off' ? 'Invisível' : ST_NAME[p.st]}${p.invoice ? ' · no canal de voz' : ''}`;
      if (p.invoice) li.insertAdjacentHTML('beforeend', '<svg class="ic on-voice" role="img" aria-label="no canal de voz"><use href="#i-vol"/></svg>');
      return li;
    };
    $('online').replaceChildren(...groups.on.sort(byName).map(item));
    $('idle').replaceChildren(...groups.idle.sort(byName).map(item));
    $('offline').replaceChildren(...groups.off.sort(byName).map(item));
    const up = groups.on.length + groups.idle.length;
    $('peopleCountSide').textContent = String(groups.on.length);
    $('peopleCount').textContent = String(up);
    $('idleCount').textContent = String(groups.idle.length);
    $('offCount').textContent = String(groups.off.length);
    $('idleHead').hidden = !groups.idle.length;
    $('offHead').hidden = !groups.off.length;
    if ($('profDlg').open) paintProfile(true);
  }
  function refreshDots() { // bolinha de status nos avatares do #chat
    for (const el of document.querySelectorAll('#chatLog .avatar[data-uid]')) el.dataset.st = stOf(el.dataset.uid);
    renderTyping();
  }
  function renderStatus() {
    const st = myStatus();
    const label = stPick === 'off' ? 'Invisível' : ST_NAME[st];
    $('statusLabel').textContent = label;
    $('statusBtn').querySelector('.st-dot').dataset.st = st;
    $('statusBtn').setAttribute('aria-label', `Status: ${label}. Trocar status`);
    $('meAvatar').dataset.st = st;
    for (const b of $('statusPop').querySelectorAll('.st-opt')) b.setAttribute('aria-checked', String(b.dataset.st === stPick));
  }
  function sendMe() { // quem sou eu e como quero aparecer (só depois de ter nome)
    if (chatOpen() && store('name')) chat.ws.send(JSON.stringify({ t: 'me', key: myKey, name: myName, av: myAv, st: myStatus(), ...(store('bio') !== null ? { bio: store('bio') } : {}),
      ...(store('inv') ? { inv: store('inv') } : {}), ...(DESK ? { dev: 'App de PC (Windows)' } : MOB ? { dev: 'App Android' } : {}) })); // S-0065
    vcSend();
  }
  // ---------- tempo de chamada (S-0059, como no Discord) ----------
  // O servidor guarda quando a 1ª pessoa entrou em cada canal de voz e zera quando ele esvazia: todos veem o mesmo tempo.
  const vct = new Map(); // canal de voz -> início (relógio do servidor)
  let vcOff = 0;         // relógio do servidor - o meu
  function vcSend() { if (chatOpen() && store('name')) chat.ws.send(JSON.stringify({ t: 'vc', ch: inVoice ? myVch : '' })); }
  function vcOnTimes(d) {
    vct.clear();
    for (const [ch, ts] of Object.entries(d.m)) if (/^[a-z0-9]{1,12}$/.test(ch) && Number.isFinite(ts)) vct.set(ch, ts);
    if (Number.isFinite(d.now)) vcOff = d.now - Date.now();
    vcTick();
  }
  function vcFmt(ms) { // 04:12 · 1:04:12
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    return h ? `${h}:${two(m)}:${two(s % 60)}` : `${two(m)}:${two(s % 60)}`;
  }
  function vcTick() {
    const now = Date.now() + vcOff;
    for (const el of document.querySelectorAll('.chan[data-ch] .chan-time')) {
      const ts = vct.get(el.closest('.chan').dataset.ch);
      el.hidden = !ts;
      el.textContent = ts ? vcFmt(now - ts) : '';
    }
    const ts = $('room').dataset.view === 'voice' ? vct.get(viewVch) : 0;
    $('callTime').hidden = !ts;
    if (ts) { $('callTime').textContent = vcFmt(now - ts); $('callTime').title = `Chamada desde ${new Date(ts - vcOff).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`; }
  }
  setInterval(vcTick, 1000);
  // Ausente automático: 10 min sem mexer. No app vale o teclado/mouse do Windows inteiro (jogando = ativo).
  let lastInput = Date.now();
  let idleMs = 600000;
  async function checkIdle() {
    if (voice.talking) lastInput = Date.now();
    let quiet = Date.now() - lastInput;
    if (DESK) { try { quiet = Math.min(quiet, (await DESK.core.invoke('idle_secs')) * 1000); } catch { /* sem o comando: vale só a página */ } }
    const idle = quiet >= idleMs;
    if (idle === autoIdle) return;
    autoIdle = idle;
    renderStatus(); sendMe(); renderPeople(); refreshDots();
  }
  for (const t of ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart']) {
    window.addEventListener(t, () => { lastInput = Date.now(); if (autoIdle) checkIdle(); }, { capture: true, passive: true });
  }
  setInterval(checkIdle, 15000);

  function renderTalk() { // quem está falando agora, por nome
    const names = [...(voice.talking ? ['você'] : []), ...[...peers.values()].filter((e) => e.ready && withMe(e) && e.talking).map((e) => e.name)];
    $('vbTalk').textContent = names.length ? `falando: ${names.join(', ')}` : '';
  }
  // anel de "falando" no avatar da pessoa (lista e canal de voz)
  function ring(id, on) {
    for (const el of document.querySelectorAll(`[data-id="${CSS.escape(id)}"] > .avatar`)) el.classList.toggle('speaking', on);
    if (id === 'me') $('meAvatar').classList.toggle('speaking', on);
    renderTalk();
  }
  const note = (text) => toast(text);

  // ---------- canais: #chat e Canal de voz ----------
  // Tela larga: no canal de voz o chat fica à direita. Estreita: um canal por vez.
  const wideChat = () => window.matchMedia('(min-width: 1200px)').matches;
  function setView(v) {
    $('room').dataset.view = v;
    renderView();
    if (narrow()) togglePanel(false);
    if (chatSeen()) readAll();
    layout();
  }
  function renderView() { // canal aberto em destaque na lateral e nome dele no topo
    const v = $('room').dataset.view;
    for (const b of document.querySelectorAll('.chan[data-ch]')) {
      const id = b.dataset.ch;
      b.setAttribute('aria-current', (v === 'chat' && id === textCh) || (v === 'voice' && id === viewVch) ? 'page' : 'false');
    }
    $('roomTitle').textContent = v === 'chat' ? chanLabel(textCh) : chanLabel(viewVch);
    setIcon($('topIcon'), v === 'chat' ? 'hash' : 'vol');
    vcTick();
    renderDj();
  }
  const chatSeen = () => document.visibilityState === 'visible' && !document.documentElement.classList.contains('app-hidden')
    && ($('room').dataset.view === 'chat' || (wideChat() && !focusOn() && !chatOff));

  function togglePanel(open, lado) { // celular: lado 'esq' = canais (e online) pela esquerda, 'dir' = só quem está online, pela direita
    const panel = $('panel');
    if (open) panel.dataset.lado = lado || panel.dataset.lado || 'esq';
    panel.hidden = !open;
    panel.classList.remove('arrastando');
    panel.style.transform = '';
    $('panelScrim').hidden = !(open && narrow());
    $('panelScrim').style.opacity = '';
    $('chanBtn').setAttribute('aria-expanded', String(open && panel.dataset.lado !== 'dir'));
    $('panelBtn').setAttribute('aria-expanded', String(open && panel.dataset.lado === 'dir'));
  }

  // ---------- chat de texto permanente ----------
  // Histórico e arquivos ficam no Worker (server/worker.js): Durable Object com SQLite, plano grátis da Cloudflare.
  const FILE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'video/mp4', 'video/webm', 'video/quicktime'];
  const MAX_FILE = 25 * 1024 * 1024;
  const chat = { ws: null, backoff: 0, timer: 0, list: [], more: false, unread: 0, pending: [], notifyAt: 0 };

  function chatConnect() {
    clearTimeout(chat.timer);
    if (!navigator.onLine) { chat.timer = setTimeout(chatConnect, 3000); return; }
    const ws = chat.ws = new WebSocket(`${CHAT.replace(/^http/, 'ws')}/ws`);
    ws.addEventListener('open', () => {
      chat.backoff = 0;
      ws.send(JSON.stringify({ t: 'v' })); // entendo canais: o servidor manda também as mensagens dos outros canais
      chatState(); sendMe(); // S-0065: o histórico de outro canal é pedido depois do portão (onOk)
      djClock(ws);
    });
    ws.addEventListener('message', (ev) => {
      let d;
      try { d = JSON.parse(ev.data); } catch { return; }
      if (chat.ws === ws && d && typeof d === 'object') onChat(d);
    });
    ws.addEventListener('close', () => {
      if (chat.ws !== ws) return;
      chat.ws = null;
      sess.ok = false;
      chatState();
      typers.clear(); renderTyping();
      if (sess.locked) return; // S-0065: sem convite ou expulso: espera a pessoa colar um convite
      chat.timer = setTimeout(chatConnect, Math.min(1000 * 2 ** chat.backoff++, 15000));
    });
    chatState();
  }
  const chatOpen = () => !!chat.ws && chat.ws.readyState === WebSocket.OPEN;
  function chatState() {
    $('chatState').textContent = chatOpen() ? (chat.loading ? 'carregando…' : '') : chat.list.length ? 'reconectando…' : 'conectando…';
  }
  function onChat(d) {
    if (d.t === 'hi') { if (d.gate && !store('name') && !store('inv')) lockShow('need'); return; } // S-0065: servidor fechado, sem convite
    if (d.t === 'ok' && /^[a-f0-9]{40}$/.test(d.mt || '')) { onOk(d); return; }
    if (d.t === 'locked' || d.t === 'kicked') { lockShow(d.t === 'kicked' ? 'ban' : String(d.why || 'need')); return; }
    if (d.t === 'adminv' && /^[A-Za-z0-9_-]{40,80}$/.test(d.tok || '')) { admInv(d.tok); return; }
    if (d.t === 'admlist' && Array.isArray(d.list)) { admRender(d.list); return; }
    if (d.t === 'hist' && Array.isArray(d.list)) {
      if ((d.ch || 'chat') !== textCh) return; // histórico de outro canal (o do #chat chega sozinho ao conectar)
      chat.loading = false;
      chat.list = d.list.filter(okMsg);
      chat.more = d.list.length >= 150;
      renderChat(true);
    } else if (d.t === 'old' && Array.isArray(d.list)) {
      if ((d.ch || 'chat') !== textCh) return;
      const box = $('chatScroll');
      const fromBottom = box.scrollHeight - box.scrollTop;
      chat.list = [...d.list.filter(okMsg), ...chat.list];
      chat.more = d.list.length >= 150;
      renderChat(false);
      box.scrollTop = box.scrollHeight - fromBottom; // continua vendo a mesma mensagem
      if (chat.jump) { const j = chat.jump; chat.jump = null; jumpTo(j.id, j.tries); }
    } else if (d.t === 'msg' && okMsg(d.m)) {
      const ch = d.m.ch || 'chat';
      const c = chanOf(ch);
      if (c) c.last = Math.max(c.last || 0, d.m.id);
      if (ch !== textCh) { if (!mine(d.m)) incoming(d.m); renderUnread(); return; } // outro canal: só conta como não lida
      if (chat.loading || chat.list.some((m) => m.id === d.m.id)) return;
      const stick = atBottom();
      chat.list.push(d.m);
      $('chatLog').append(msgEl(d.m, chat.list[chat.list.length - 2]));
      if (stick || mine(d.m)) scrollDown();
      $('chatLog').querySelector('.chat-start')?.remove();
      if (!mine(d.m)) incoming(d.m); else readAll();
      if (d.m.uid && typers.delete(d.m.uid)) renderTyping();
    } else if (d.t === 'del') {
      if (editing && editing.id === d.id) editing = null;
      if (replyTo === d.id) cancelReply();
      chat.list = chat.list.filter((m) => m.id !== d.id);
      renderChat(false);
    } else if (d.t === 'edit' && Number.isInteger(d.id) && typeof d.text === 'string') {
      patch(d.id, { text: d.text, edited: Number(d.edited) || Date.now() });
    } else if (d.t === 'react' && Number.isInteger(d.id) && d.reacts && typeof d.reacts === 'object') {
      patch(d.id, { reacts: d.reacts });
    } else if (d.t === 'you' && /^[a-f0-9]{16}$/.test(d.uid || '')) {
      const changed = d.uid !== myUid;
      myUid = d.uid;
      store('uid', myUid);
      broadcast(hello());
      if (changed) renderChat(false); // minhas mensagens ganham editar/apagar
      renderPeople();
    } else if (d.t === 'members' && Array.isArray(d.list)) {
      members.clear();
      for (const m of d.list) if (okMember(m)) members.set(m.uid, m);
      renderPeople(); refreshDots();
    } else if (d.t === 'pres' && okMember(d.m)) {
      const old = members.get(d.m.uid);
      members.set(d.m.uid, d.m);
      renderPeople(); refreshDots();
      if (old && (old.name !== d.m.name || old.av !== d.m.av) && chat.list.some((m) => m.uid === d.m.uid)) { // trocou nome/avatar: as mensagens dela acompanham
        const box = $('chatScroll');
        const top = box.scrollTop;
        renderChat(false);
        box.scrollTop = top;
      }
    } else if (d.t === 'chans' && Array.isArray(d.list)) {
      onChans(d.list);
    } else if (d.t === 'chanok' && typeof d.id === 'string') {
      if (!d.op && chanOf(d.id)) { if (d.kind === 'text') { openText(d.id); $('chatInput').focus(); } else joinVoice(d.id); }
    } else if (d.t === 'mus' || d.t === 'clk' || d.t === 'ytres' || d.t === 'musok' || d.t === 'lyrres') {
      onDj(d);
    } else if (d.t === 'djn' && typeof d.text === 'string') { // S-0059: aviso do Bagre DJ: só no painel de música
      djNotice(d);
    } else if (d.t === 'vct' && d.m && typeof d.m === 'object') { // S-0059: tempo de chamada de cada canal de voz (início no servidor)
      vcOnTimes(d);
    } else if (d.t === 'err' && typeof d.text === 'string') {
      if (Date.now() - (dj.cmdAt || 0) < 15000) djFeedAdd(d.text.slice(0, 200), null, true); // erro de um pedido de música: no painel de música
      else toast(d.text.slice(0, 200), 6000);
    } else if (d.t === 'typing' && /^[a-f0-9]{16}$/.test(d.uid || '') && d.uid !== myUid && (d.ch || 'chat') === textCh) {
      typers.set(d.uid, Date.now());
      renderTyping();
    }
  }
  const okMsg = (m) => !!m && Number.isInteger(m.id) && typeof m.name === 'string' && typeof m.text === 'string' && m.uid !== 'dj'; // S-0059: o DJ não fala no chat
  const okMember = (m) => !!m && /^[a-f0-9]{16}$/.test(m.uid || '') && typeof m.name === 'string' && ['on', 'idle', 'off'].includes(m.st)
    && ((m.av = avOk(m.av)), true);
  const mine = (m) => (m.uid ? m.uid === myUid : m.name === myName); // antigas (sem uid): pelo nome, como antes
  const canEdit = (m) => !!m && !!m.uid && m.uid === myUid;
  const msgById = (id) => chat.list.find((m) => m.id === id);
  const author = (m) => { const x = m.uid && members.get(m.uid); return x ? x : { name: m.name, av: m.av }; };
  const snippet = (m) => (m.text || (m.media ? 'imagem ou vídeo' : '')).slice(0, 140);
  const listNames = (n) => (n.length < 2 ? n.join('') : `${n.slice(0, -1).join(', ')} e ${n[n.length - 1]}`);
  function patch(id, fields) { // mensagem mudou (editada, reação): troca só ela, no lugar
    const i = chat.list.findIndex((m) => m.id === id);
    if (i < 0) return;
    const m = chat.list[i] = { ...chat.list[i], ...fields };
    const el = $('chatLog').querySelector(`.msg[data-id="${id}"]`);
    if (el) {
      const stick = atBottom();
      if (el.contains($('msgTools'))) parkTools();
      el.replaceWith(msgEl(m, chat.list[i - 1]));
      if (editing && editing.id === id) paintEdit();
      if (stick) scrollDown();
    }
    if ('text' in fields) for (const q of $('chatLog').querySelectorAll(`.msg-reply[data-to="${id}"] .rp-text`)) q.textContent = snippet(m);
  }

  // "Fulano está digitando…": o aviso chega a cada ~3 s enquanto a pessoa digita e some 6 s depois do último
  const typers = new Map(); // uid -> quando avisou
  let typedAt = 0;
  function renderTyping() {
    const now = Date.now();
    for (const [u, t] of typers) if (now - t > 6000 || u === myUid) typers.delete(u);
    const names = [...typers.keys()].map((u) => (members.get(u) || {}).name).filter(Boolean);
    const el = $('typing');
    el.classList.toggle('on', names.length > 0);
    if (!names.length) { el.textContent = ''; return; }
    const dots = Object.assign(document.createElement('span'), { className: 'typing-dots' });
    dots.setAttribute('aria-hidden', 'true');
    dots.append(document.createElement('i'), document.createElement('i'), document.createElement('i'));
    const parts = [dots];
    if (names.length > 3) parts.push('Várias pessoas estão digitando…');
    else {
      names.forEach((n, i) => {
        if (i) parts.push(i === names.length - 1 ? ' e ' : ', ');
        parts.push(Object.assign(document.createElement('b'), { textContent: n }));
      });
      parts.push(names.length === 1 ? ' está digitando…' : ' estão digitando…');
    }
    el.replaceChildren(...parts);
  }
  setInterval(() => { if (typers.size) renderTyping(); }, 1000);
  setInterval(() => { if (chatOpen()) chat.ws.send('ping'); }, 25000); // sinal de vida: sem ele o servidor põe offline
  const atBottom = () => { const b = $('chatScroll'); return b.scrollHeight - b.scrollTop - b.clientHeight < 80; };
  const scrollDown = () => { const b = $('chatScroll'); b.scrollTop = b.scrollHeight; };
  function renderChat(down) {
    const log = $('chatLog');
    parkTools();
    log.textContent = '';
    chat.list.forEach((m, i) => log.append(msgEl(m, chat.list[i - 1])));
    if (!chat.list.length && !chat.loading && !chat.more && chatOpen()) { // canal vazio: começo dele, como no Discord
      const li = Object.assign(document.createElement('li'), { className: 'chat-start' });
      li.innerHTML = '<span class="cs-ic"><svg class="ic" aria-hidden="true"><use href="#i-hash"/></svg></span>';
      li.append(Object.assign(document.createElement('b'), { textContent: `Bem-vindo a #${chanLabel(textCh)}` }),
        Object.assign(document.createElement('span'), { textContent: `Este é o começo do canal #${chanLabel(textCh)}.` }));
      log.append(li);
    }
    if (editing) paintEdit();
    $('moreBtn').hidden = !chat.more;
    chatState();
    if (down) scrollDown();
  }
  function incoming(m) {
    const ch = m.ch || 'chat';
    if (ch === textCh && chatSeen()) { readAll(); return; }
    unreadBy.set(ch, (unreadBy.get(ch) || 0) + 1);
    renderUnread();
    sfx('tap');
    const now = Date.now();
    if ((DESK && document.documentElement.classList.contains('app-hidden') || MOB && MOB.hidden()) && now - chat.notifyAt > 10000) {
      chat.notifyAt = now;
      const where = ch === 'chat' ? '' : ` em #${chanLabel(ch)}`;
      const body = `${m.name}${where}: ${m.text || (m.media && m.media.mime.startsWith('video/') ? 'mandou um vídeo' : 'mandou uma imagem')}`.slice(0, 160);
      if (MOB) MOB.notify(body); else DESK.core.invoke('notify', { body }).catch(() => {});
    }
  }
  // Não lidas por canal: contador das que chegaram com o canal fechado; negrito também para o que chegou com o
  // aparelho desligado (última mensagem do canal depois da última que eu vi, guardada neste aparelho).
  const readMark = (id) => Number(store(`read:${id}`) || 0);
  function readAll() {
    unreadBy.delete(textCh);
    const c = chanOf(textCh);
    const last = Math.max(c ? c.last || 0 : 0, chat.list.length ? chat.list[chat.list.length - 1].id : 0);
    if (last > readMark(textCh)) store(`read:${textCh}`, String(last));
    renderUnread();
  }
  function renderUnread() {
    let total = 0;
    for (const c of chans) {
      if (c.kind !== 'text') continue;
      const n = unreadBy.get(c.id) || 0;
      total += n;
      const b = document.querySelector(`.chan[data-ch="${c.id}"]`);
      if (!b) continue;
      const badge = b.querySelector('.chan-badge');
      badge.hidden = !n;
      badge.textContent = n ? String(Math.min(99, n)) : '';
      b.classList.toggle('unread', !!n || (c.last || 0) > readMark(c.id));
    }
    chat.unread = total;
    for (const b of [$('unreadTop'), $('focusUnread')]) { b.hidden = !total; b.textContent = total ? String(Math.min(99, total)) : ''; }
  }

  // ---------- canais: lista, abrir, criar, renomear, apagar ----------
  function onChans(list) {
    const ok = list.filter((c) => c && /^[a-z0-9]{1,12}$/.test(c.id) && ['text', 'voice'].includes(c.kind) && typeof c.name === 'string');
    if (!ok.some((c) => c.id === 'chat') || !ok.some((c) => c.id === 'voz')) return;
    const gone = (id) => !ok.some((c) => c.id === id);
    chans = ok.map((c) => ({ id: c.id, kind: c.kind, name: c.name.slice(0, 32), uid: typeof c.uid === 'string' ? c.uid : '', last: Number(c.last) || 0 }));
    for (const c of chans) if (c.kind === 'text' && store(`read:${c.id}`) === null) store(`read:${c.id}`, String(c.last)); // canal novo para este aparelho: começa lido
    for (const id of [...unreadBy.keys()]) if (gone(id)) unreadBy.delete(id);
    if (gone(textCh)) { toast(`O canal #${$('chatTitle').textContent} foi apagado.`); openText('chat', true); }
    if (inVoice && gone(myVch)) { toast('O canal de voz em que você estava foi apagado.'); leaveVoice(); }
    if (gone(viewVch)) viewVch = 'voz';
    if (chanEdit && gone(chanEdit.id) && $('chanDlg').open) $('chanDlg').close();
    renderChans();
    renderView();
    renderPeople();
  }
  function chanRow(c) {
    const row = Object.assign(document.createElement('div'), { className: 'chan-row' });
    row.dataset.ch = c.id;
    const b = Object.assign(document.createElement('button'), { type: 'button', className: 'chan' });
    b.dataset.ch = c.id;
    b.innerHTML = `<svg class="ic" aria-hidden="true"><use href="#i-${c.kind === 'text' ? 'hash' : 'vol'}"/></svg><span class="chan-name"></span>`
      + (c.kind === 'text' ? '<span class="badge chan-badge" hidden></span>' : '<span class="chan-time" title="Tempo de chamada" hidden></span><span class="chan-count"></span>');
    const g = Object.assign(document.createElement('button'), { type: 'button', className: 'icon-btn chan-gear', title: 'Editar canal' });
    g.dataset.ch = c.id;
    g.innerHTML = '<svg class="ic" aria-hidden="true"><use href="#i-gear"/></svg>';
    row.append(b, g);
    if (c.kind === 'text') return [row];
    const ul = Object.assign(document.createElement('ul'), { className: 'people people-voice' });
    ul.dataset.ch = c.id;
    ul.setAttribute('aria-label', `No canal ${c.name}`);
    return [row, ul];
  }
  function renderChans() {
    for (const kind of ['text', 'voice']) {
      const box = $(kind === 'text' ? 'textChans' : 'voiceChans');
      const want = chans.filter((c) => c.kind === kind && !FIXED_CH.includes(c.id));
      const ids = want.map((c) => c.id).join();
      if (box.dataset.ids !== ids) { box.dataset.ids = ids; box.replaceChildren(...want.flatMap(chanRow)); }
    }
    for (const c of chans) {
      for (const el of document.querySelectorAll(`.chan[data-ch="${c.id}"] .chan-name`)) el.textContent = c.name;
      for (const g of document.querySelectorAll(`.chan-gear[data-ch="${c.id}"]`)) g.setAttribute('aria-label', `Editar canal ${c.name}`);
    }
    renderUnread();
    renderChanTitle();
  }
  function renderChanTitle() {
    const n = chanLabel(textCh);
    $('chatTitle').textContent = n;
    $('chatInput').placeholder = `Conversar em #${n}`;
    document.querySelector('#chat .drop p').textContent = `Solte para enviar em #${n}`;
  }
  function openText(ch, quiet) {
    const c = chanOf(ch);
    ch = c && c.kind === 'text' ? c.id : 'chat';
    if (ch !== textCh) {
      if (editing) stopEdit(true);
      cancelReply(); closeMenus();
      textCh = ch;
      chat.list = []; chat.more = false; chat.jump = null;
      chat.loading = chatOpen();
      typers.clear(); renderTyping();
      renderChat(true);
      renderChanTitle();
      if (chatOpen()) chat.ws.send(JSON.stringify({ t: 'hist', ch }));
    }
    if (quiet) { renderView(); return; }
    setView('chat');
  }
  let chanEdit = null; // canal aberto no diálogo (null = criando)
  let delArmed = false;
  const chanKind = () => (chanEdit ? chanEdit.kind : $('chanForm').elements.kind.value);
  function openChanDlg(id, kind) {
    const c = id ? chanOf(id) : null;
    if (id && !c) return;
    chanEdit = c;
    delArmed = false;
    $('chanTitle').textContent = c ? `Editar ${c.kind === 'text' ? '#' : ''}${c.name}` : 'Criar canal';
    $('chanKinds').hidden = !!c;
    for (const r of $('chanForm').elements.kind) r.checked = r.value === (c ? c.kind : kind || 'text');
    $('chanName').value = c ? c.name : '';
    $('chanDel').hidden = !c || FIXED_CH.includes(c.id);
    $('chanDel').textContent = 'Apagar canal';
    $('chanOk').textContent = c ? 'Salvar' : 'Criar canal';
    chanIcon();
    $('chanDlg').showModal();
    $('chanName').focus();
  }
  function chanIcon() {
    const text = chanKind() === 'text';
    setIcon($('chanNameIcon'), text ? 'hash' : 'vol');
    $('chanName').placeholder = text ? 'novo-canal' : 'Sala nova';
  }
  function chanSend(op) {
    if (!chatOpen()) { toast('O chat está reconectando. Tente de novo em instantes.'); return false; }
    chat.ws.send(JSON.stringify({ t: 'chan', op, id: chanEdit ? chanEdit.id : undefined, kind: chanKind(), name: $('chanName').value }));
    return true;
  }

  const two = (n) => String(n).padStart(2, '0');
  function when(ts) {
    const d = new Date(ts);
    const today = new Date().toDateString() === d.toDateString();
    const hm = `${two(d.getHours())}:${two(d.getMinutes())}`;
    return today ? `hoje ${hm}` : `${two(d.getDate())}/${two(d.getMonth() + 1)} ${hm}`;
  }
  function linkify(el, text) { // links viram <a>: site = aba nova; app de PC e celular = navegador padrão do sistema (S-0059)
    for (const part of text.split(/(https?:\/\/[^\s<>"]+)/)) {
      if (/^https?:\/\//.test(part)) {
        const tail = (/[.,;:!?)\]}'»]+$/.exec(part) || [''])[0]; // "veja https://x.com/a." -> o ponto final não entra no link
        const url = tail ? part.slice(0, -tail.length) : part;
        let ok = false;
        try { ok = ['http:', 'https:'].includes(new URL(url).protocol); } catch { /* não é link */ }
        if (!ok) { el.append(part); continue; }
        el.append(Object.assign(document.createElement('a'), { href: url, textContent: url, target: '_blank', rel: 'noopener noreferrer', className: 'msg-link' }));
        if (tail) el.append(tail);
      } else if (part) el.append(part);
    }
  }
  function linkPreview(text) { // S-0059: prévia pequena só do 1º link do YouTube (capa pelo id; nada é buscado em site de fora)
    const m = /https?:\/\/(?:www\.|m\.|music\.)?(?:youtube\.com\/(?:watch\?(?:[^\s#]*&)?v=|shorts\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/.exec(text);
    if (!m) return null;
    const a = Object.assign(document.createElement('a'), { className: 'msg-prev', href: `https://www.youtube.com/watch?v=${m[1]}`, target: '_blank', rel: 'noopener noreferrer', title: 'Abrir no YouTube' });
    a.append(Object.assign(document.createElement('img'), { src: thumb(m[1]), alt: '', loading: 'lazy', width: 160, height: 90 }), Object.assign(document.createElement('span'), { textContent: 'YouTube' }));
    return a;
  }
  function msgEl(m, prev) {
    const li = document.createElement('li');
    li.className = 'msg';
    li.dataset.id = String(m.id);
    const who = author(m);
    // mensagens seguidas da mesma pessoa em até 5 min ficam juntas (sem repetir nome e avatar); resposta sempre mostra
    const same = prev && (m.uid || prev.uid ? prev.uid === m.uid : prev.name === m.name);
    if (same && m.ts - prev.ts < 300000 && !m.reply) li.classList.add('cont');
    if (mine(m)) li.classList.add('mine');
    const av = document.createElement('span');
    av.className = 'avatar';
    av.setAttribute('aria-hidden', 'true');
    if (m.uid) { av.dataset.uid = m.uid; av.dataset.st = stOf(m.uid); }
    paintAvatar(av, who.name, who.av);
    if (m.reply && Number.isInteger(m.reply.id)) li.append(replyEl(m.reply));
    const body = document.createElement('div');
    body.className = 'msg-body';
    const head = document.createElement('p');
    head.className = 'msg-head';
    const nm = Object.assign(document.createElement('b'), { className: 'msg-name', textContent: who.name });
    const t = Object.assign(document.createElement('time'), { textContent: when(m.ts), dateTime: new Date(m.ts).toISOString() });
    t.title = new Date(m.ts).toLocaleString('pt-BR');
    head.append(nm);
    if (m.uid === 'dj') { li.classList.add('is-bot'); head.append(Object.assign(document.createElement('span'), { className: 'bot-tag', textContent: 'BOT' })); }
    head.append(t);
    body.append(head);
    const edited = () => {
      const e = Object.assign(document.createElement('span'), { className: 'msg-edited', textContent: '(editada)' });
      e.title = `editada ${when(m.edited)}`;
      return e;
    };
    if (m.text) {
      const p = document.createElement('p');
      p.className = 'msg-text';
      linkify(p, m.text);
      if (m.edited) p.append(' ', edited());
      body.append(p);
      const pv = linkPreview(m.text);
      if (pv) body.append(pv);
    }
    if (m.media && /^[a-z0-9]{20}$/.test(m.media.id)) body.append(mediaEl(m.media));
    if (m.uid === 'dj' && m.card && typeof m.card === 'object' && ['np', 'add'].includes(m.card.k) && /^[A-Za-z0-9_-]{11}$/.test(m.card.id || '')) { // S-0033
      const p = body.querySelector('.msg-text');
      if (p) p.remove();
      body.append(djCardEl(m.card));
      li.classList.add('has-djc');
    }
    if (!m.text && m.edited) body.append(edited());
    if (m.reacts && typeof m.reacts === 'object') {
      const row = Object.assign(document.createElement('div'), { className: 'reacts' });
      for (const [e, uids] of Object.entries(m.reacts)) {
        if (!EMOJI.includes(e) || !Array.isArray(uids) || !uids.length) continue;
        const b = Object.assign(document.createElement('button'), { type: 'button', className: 'react' });
        const me = uids.includes(myUid);
        b.setAttribute('aria-pressed', String(me));
        b.append(Object.assign(document.createElement('span'), { className: 'emo', textContent: e }), Object.assign(document.createElement('b'), { textContent: String(uids.length) }));
        const names = uids.map((u) => (u === myUid ? 'você' : (members.get(u) || {}).name || 'alguém'));
        b.title = `${listNames(names)} ${names.length === 1 ? 'reagiu' : 'reagiram'} com ${e}`;
        b.setAttribute('aria-label', `${b.title}. ${me ? 'Clique para tirar a sua' : 'Clique para reagir também'}`);
        b.addEventListener('click', () => react(m.id, e));
        row.append(b);
      }
      if (row.childElementCount) body.append(row);
    }
    li.append(av, body);
    return li;
  }
  function replyEl(r) { // citação clicável da mensagem respondida (leva até ela)
    const orig = msgById(r.id);
    const name = orig ? author(orig).name : (r.uid && members.get(r.uid) || r).name;
    const q = Object.assign(document.createElement('button'), { type: 'button', className: 'msg-reply' });
    q.dataset.to = String(r.id);
    q.setAttribute('aria-label', `Resposta a ${name}. Ir para a mensagem`);
    q.innerHTML = '<svg class="ic" aria-hidden="true"><use href="#i-reply"/></svg>';
    q.append(Object.assign(document.createElement('b'), { className: 'rp-name', textContent: name }),
      Object.assign(document.createElement('span'), { className: 'rp-text', textContent: orig ? snippet(orig) : r.text || (r.media ? 'imagem ou vídeo' : '') }));
    q.addEventListener('click', () => jumpTo(r.id));
    return q;
  }
  function jumpTo(id, tries = 0) {
    const el = $('chatLog').querySelector(`.msg[data-id="${id}"]`);
    if (el) {
      el.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
      el.classList.remove('flash');
      void el.offsetWidth; // reinicia a animação
      el.classList.add('flash');
      setTimeout(() => el.classList.remove('flash'), 2200);
      return;
    }
    const gone = chat.list.length && id > chat.list[0].id; // estaria carregada: foi apagada
    if (gone || !chat.more || tries >= 10 || !chatOpen()) { toast('Essa mensagem foi apagada.'); return; }
    chat.jump = { id, tries: tries + 1 }; // carrega as antigas até achar
    chat.ws.send(JSON.stringify({ t: 'more', before: chat.list[0].id, ch: textCh }));
  }

  // ---------- ações na mensagem: reagir, responder, editar, copiar, apagar ----------
  const EMOJI = ['👍', '❤️', '😂', '😮', '😢', '😡', '🔥', '🎉', '👀', '💀', '🐟', '🙏', '👏', '🤡', '💯', '✅'];
  let toolsFor = null; // mensagem com a barra de ações aberta
  let replyTo = null;
  let editing = null; // { id, draft }
  function parkTools() { const t = $('msgTools'); t.hidden = true; if (t.parentElement !== $('chat')) $('chat').append(t); toolsFor = null; }
  function showTools(li) {
    const m = li && msgById(Number(li.dataset.id));
    if (!m || li.classList.contains('editing')) return;
    const t = $('msgTools');
    for (const b of t.querySelectorAll('.js-own')) b.hidden = !canEdit(m);
    t.querySelector('[data-act="copy"]').hidden = !m.text;
    li.append(t);
    t.hidden = false;
    toolsFor = m.id;
  }
  function closeMenus() { $('msgMenu').hidden = true; $('reactPop').hidden = true; $('userMenu').hidden = true; menuFor = null; }
  function place(el, x, y) { // menu flutuante perto do ponto, sem sair da janela; no celular vira folha de baixo
    el.classList.toggle('sheet', narrow());
    el.style.left = el.style.top = '';
    if (narrow()) return;
    const w = el.offsetWidth, h = el.offsetHeight;
    el.style.left = `${Math.max(8, Math.min(x, innerWidth - w - 8))}px`;
    el.style.top = `${Math.max(8, y + h + 8 > innerHeight ? y - h : y)}px`;
  }
  function openMenu(id, x, y) {
    const m = msgById(id);
    if (!m) return;
    closeMenus(); parkTools();
    const menu = $('msgMenu');
    menu.dataset.id = String(id);
    for (const b of menu.querySelectorAll('.js-own')) b.hidden = !canEdit(m);
    menu.querySelector('[data-act="copy"]').hidden = !m.text;
    menu.querySelector('.menu-emojis').replaceChildren(...EMOJI.slice(0, 6).map((e) => emojiBtn(m, e)));
    menu.hidden = false;
    place(menu, x, y);
    menu.querySelector('button').focus();
  }
  function emojiBtn(m, e) {
    const b = Object.assign(document.createElement('button'), { type: 'button', className: 'emo-btn', textContent: e });
    b.setAttribute('aria-label', `Reagir com ${e}`);
    b.setAttribute('aria-pressed', String(!!(m.reacts && Array.isArray(m.reacts[e]) && m.reacts[e].includes(myUid))));
    b.addEventListener('click', () => { react(m.id, e); closeMenus(); });
    return b;
  }
  function openReact(id, anchor) {
    const m = msgById(id);
    if (!m) return;
    const pop = $('reactPop');
    $('msgMenu').hidden = true;
    pop.replaceChildren(...EMOJI.map((e) => emojiBtn(m, e)));
    pop.hidden = false;
    const r = anchor.getBoundingClientRect();
    place(pop, r.right - pop.offsetWidth, r.top - pop.offsetHeight - 6);
    pop.querySelector('button').focus();
  }
  function react(id, e) {
    if (!chatOpen()) { toast('O chat está reconectando. Tente de novo em instantes.'); return; }
    chat.ws.send(JSON.stringify({ t: 'react', id, e }));
  }
  function startReply(id) {
    const m = msgById(id);
    if (!m) return;
    replyTo = id;
    $('replyName').textContent = author(m).name;
    $('replyBar').hidden = false;
    $('chatInput').focus();
  }
  function cancelReply() { replyTo = null; $('replyBar').hidden = true; }
  function startEdit(id) {
    const m = msgById(id);
    if (!canEdit(m)) return;
    if (editing) stopEdit(true);
    parkTools(); closeMenus();
    editing = { id, draft: m.text };
    paintEdit();
  }
  function paintEdit() { // caixa de edição no lugar do texto da mensagem
    const li = $('chatLog').querySelector(`.msg[data-id="${editing.id}"]`);
    if (!li) return;
    li.classList.add('editing');
    const body = li.querySelector('.msg-body');
    const box = Object.assign(document.createElement('div'), { className: 'msg-edit' });
    const input = Object.assign(document.createElement('input'), { type: 'text', className: 'field field-sm', maxLength: 2000, value: editing.draft, autocomplete: 'off' });
    input.setAttribute('aria-label', 'Editar mensagem');
    input.addEventListener('input', () => { editing.draft = input.value; });
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); saveEdit(); }
      else if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); stopEdit(); }
    });
    const hint = document.createElement('p');
    hint.className = 'edit-hint';
    const link = (label, fn) => { const b = Object.assign(document.createElement('button'), { type: 'button', className: 'linkish', textContent: label }); b.addEventListener('click', fn); return b; };
    hint.append('Esc para ', link('cancelar', () => stopEdit()), ' · Enter para ', link('salvar', saveEdit));
    box.append(input, hint);
    const text = body.querySelector('.msg-text');
    if (text) text.replaceWith(box); else body.querySelector('.msg-head').after(box);
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }
  function saveEdit() {
    const m = msgById(editing.id);
    const text = clean(editing.draft, 2000);
    if (!m) { stopEdit(); return; }
    if (!text && !m.media) { const id = m.id; stopEdit(); confirmDel(id); return; } // texto vazio = quer apagar
    if (text !== m.text) {
      if (!chatOpen()) { toast('O chat está reconectando. Tente de novo em instantes.'); return; }
      chat.ws.send(JSON.stringify({ t: 'edit', id: m.id, text }));
    }
    stopEdit();
  }
  function stopEdit(keepFocus) {
    const id = editing && editing.id;
    editing = null;
    if (id) patch(id, {});
    if (!keepFocus) $('chatInput').focus();
  }
  let delId = null;
  function confirmDel(id) {
    const m = msgById(id);
    if (!m) return;
    delId = id;
    $('delPrev').replaceChildren(msgEl(m, null));
    $('delDlg').returnValue = '';
    $('delDlg').showModal();
  }
  function delMsg(id) {
    if (!chatOpen()) { toast('O chat está reconectando. Tente de novo em instantes.'); return; }
    chat.ws.send(JSON.stringify({ t: 'del', id }));
  }
  function act(kind, id, ev, anchor) {
    const m = msgById(id);
    if (!m) return;
    if (kind === 'react') { openReact(id, anchor); return; }
    closeMenus();
    if (kind === 'reply') startReply(id);
    else if (kind === 'edit') startEdit(id);
    else if (kind === 'copy') {
      navigator.clipboard.writeText(m.text).then(() => toast('Texto copiado.')).catch(() => toast('Não deu para copiar o texto.'));
    } else if (kind === 'del') { if (ev.shiftKey) delMsg(id); else confirmDel(id); }
  }
  function mediaEl(md) {
    const src = mediaUrl(md.id); // S-0065: só com a sessão
    const video = String(md.mime).startsWith('video/');
    const box = document.createElement('div');
    box.className = 'msg-media';
    if (md.w && md.h) { box.style.aspectRatio = `${md.w} / ${md.h}`; box.style.setProperty('--w', `${md.w}px`); }
    const gone = () => { box.className = 'msg-gone'; box.style.cssText = ''; box.textContent = 'arquivo expirou'; };
    if (video) {
      const v = Object.assign(document.createElement('video'), { controls: true, preload: 'metadata', playsInline: true, src });
      v.setAttribute('aria-label', md.name ? `Vídeo ${md.name}` : 'Vídeo');
      v.addEventListener('error', gone);
      sink(v);
      box.append(v);
    } else {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'msg-img';
      b.setAttribute('aria-label', `Ampliar ${md.mime === 'image/gif' ? 'GIF' : 'imagem'}${md.name ? ` ${md.name}` : ''}`);
      const img = Object.assign(new Image(), { src, alt: md.name || (md.mime === 'image/gif' ? 'GIF' : 'imagem'), loading: 'lazy', decoding: 'async' });
      img.addEventListener('error', gone);
      img.addEventListener('load', () => { if (atBottom()) scrollDown(); });
      b.append(img);
      if (md.mime === 'image/gif') b.append(Object.assign(document.createElement('span'), { className: 'gif-tag', textContent: 'GIF' }));
      b.addEventListener('click', () => { $('viewImg').src = src; $('viewImg').alt = img.alt; $('viewOpen').href = src; $('viewDlg').showModal(); });
      box.append(b);
    }
    return box;
  }

  // Anexos: botão, colar (Ctrl+V) ou arrastar. Prévia antes de enviar, até 5 por vez, 25 MB cada.
  function mediaSize(file, url) {
    return new Promise((resolve) => {
      const done = (w, h) => { clearTimeout(t); resolve({ w: Math.round(w) || 0, h: Math.round(h) || 0 }); };
      const t = setTimeout(() => done(0, 0), 6000);
      if (file.type.startsWith('video/')) {
        const v = Object.assign(document.createElement('video'), { preload: 'metadata', muted: true, src: url });
        v.addEventListener('loadedmetadata', () => done(v.videoWidth, v.videoHeight));
        v.addEventListener('error', () => done(0, 0));
      } else {
        const img = new Image();
        img.addEventListener('load', () => done(img.naturalWidth, img.naturalHeight));
        img.addEventListener('error', () => done(0, 0));
        img.src = url;
      }
    });
  }
  async function addFiles(files) {
    for (const file of files) {
      if (!FILE_TYPES.includes(file.type)) { toast(`${file.name || 'Arquivo'}: só imagem (PNG, JPG, WebP), GIF ou vídeo (MP4, WebM, MOV).`, 5000); continue; }
      if (file.size > MAX_FILE) { toast(`${file.name || 'Arquivo'} passa de 25 MB.`, 5000); continue; }
      if (chat.pending.length >= 5) { toast('No máximo 5 arquivos por vez.'); break; }
      const url = URL.createObjectURL(file);
      chat.pending.push({ file, url, ...(await mediaSize(file, url)) });
      renderAttach();
    }
    $('chatInput').focus();
  }
  function renderAttach() {
    const box = $('attach');
    box.textContent = '';
    box.hidden = !chat.pending.length;
    chat.pending.forEach((p, i) => {
      const item = document.createElement('div');
      item.className = 'att';
      const prev = p.file.type.startsWith('video/')
        ? Object.assign(document.createElement('video'), { src: p.url, muted: true, preload: 'metadata' })
        : Object.assign(new Image(), { src: p.url, alt: '' });
      const nm = Object.assign(document.createElement('span'), { className: 'att-name', textContent: `${p.file.name || 'arquivo'} · ${p.file.size < 1048576 ? `${Math.max(1, Math.round(p.file.size / 1024))} KB` : `${(p.file.size / 1048576).toFixed(1).replace('.', ',')} MB`}` });
      const x = Object.assign(document.createElement('button'), { type: 'button', className: 'icon-btn att-x' });
      x.setAttribute('aria-label', `Tirar ${p.file.name || 'arquivo'}`);
      x.innerHTML = '<svg class="ic" aria-hidden="true"><use href="#i-close"/></svg>';
      x.addEventListener('click', () => { URL.revokeObjectURL(p.url); chat.pending.splice(i, 1); renderAttach(); });
      item.append(prev, nm, x);
      box.append(item);
    });
  }
  function upload(p, bar, path = '/up') { // XHR para ter o progresso do envio
    return new Promise((resolve) => {
      const x = new XMLHttpRequest();
      x.open('POST', `${CHAT}${path}${sq() ? `${path.includes('?') ? '&' : '?'}${sq()}` : ''}`); // S-0065: só com a sessão
      x.setRequestHeader('Content-Type', p.file.type);
      x.upload.addEventListener('progress', (ev) => { if (ev.lengthComputable) bar.style.setProperty('--p', `${(ev.loaded / ev.total) * 100}%`); });
      x.addEventListener('load', () => {
        let r = null;
        try { r = JSON.parse(x.responseText); } catch { /* resposta inválida */ }
        if (x.status === 200 && r && r.id) resolve(r);
        else { toast(`Não foi possível enviar ${p.file.name || 'o arquivo'}${r && r.error ? `: ${r.error}` : '.'}`, 6000); resolve(null); }
      });
      x.addEventListener('error', () => { toast(`Falhou o envio de ${p.file.name || 'o arquivo'}. Confira a internet.`, 6000); resolve(null); });
      x.send(p.file);
    });
  }
  function chatPost(text, media, reply) {
    if (!chatOpen()) return false;
    chat.ws.send(JSON.stringify({ t: 'msg', name: myName, av: myAv, text, media, reply: reply || undefined, ch: textCh }));
    return true;
  }
  let sending = false;
  async function chatSend() {
    const text = clean($('chatInput').value, 2000);
    if (sending || (!text && !chat.pending.length)) return;
    if (!chatOpen()) { toast('O chat está reconectando. Tente de novo em instantes.'); return; }
    if (!chat.pending.length && djCommand(text)) { $('chatInput').value = ''; return; } // /play, /skip... (Bagre DJ)
    const files = chat.pending.splice(0);
    let reply = replyTo;
    cancelReply();
    typedAt = 0;
    $('chatInput').value = '';
    renderAttach();
    if (!files.length) { chatPost(text, null, reply); return; }
    sending = true;
    let first = text;
    for (const p of files) {
      const row = document.createElement('li');
      row.className = 'msg uploading';
      row.innerHTML = '<span class="up-bar"><i></i></span>';
      row.prepend(Object.assign(document.createElement('span'), { className: 'up-name', textContent: `enviando ${p.file.name || 'arquivo'}…` }));
      $('chatLog').append(row);
      scrollDown();
      const r = await upload(p, row.querySelector('.up-bar'));
      row.remove();
      URL.revokeObjectURL(p.url);
      if (!r) continue;
      if (!chatPost(first, { id: r.id, w: p.w, h: p.h, name: p.file.name || '' }, reply)) { toast('O chat caiu no meio do envio. Mande de novo.'); break; }
      first = ''; reply = null;
    }
    if (first) chatPost(first, null, reply); // nenhum arquivo subiu: o texto vai sozinho
    sending = false;
  }

  // ---------- entrar no servidor ----------
  function enterServer() {
    room = SERVER;
    leaving = false; everOk = false; backoff = 0;
    $('nameInput').value = myName;
    togglePanel(!narrow());
    setView('chat');
    renderShareUi(); renderPeople(); layout(); refreshStatus();
    chatConnect(); // S-0065: a malha de voz só liga depois do portão (onOk), com o nome já escolhido
  }
  let meshStarted = false;
  function joinMesh() {
    if (meshStarted || !sess.ok) return;
    meshStarted = true;
    loadPeer().then((ok) => {
      if (ok) connect();
      else toast('A biblioteca de conexão não carregou. Confira a internet e recarregue a página.', 8000);
    });
  }

  function leaveAll() { // fechar o app (bandeja > Sair)
    if (!room) return;
    leaveVoice();
    leaving = true;
    clearTimeout(retryTimer);
    broadcast({ t: 'bye' });
    resetMesh();
    if (peer) { const p = peer; peer = null; p.destroy(); }
    if (chat.ws) { const w = chat.ws; chat.ws = null; w.close(); }
    if (wakeLock) wakeLock.release().catch(() => {});
    room = null;
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
    micJob = micJob.then(() => (seq === micSeq && inVoice ? doOpenMic(byUser) : undefined));
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
    if (!inVoice) { stream.getTracks().forEach((t) => t.stop()); return; } // saiu do canal durante o pedido
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
      voice.talking = talking; // fora do canal não há faixa: fica sempre false
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

  const keyName = (code) => (code ? code.replace(/^(Key|Digit)/, '').replace(/^Numpad/, 'Num ').replace(/^Mouse(\d)$/, 'Mouse $1') : 'nenhuma');
  function renderVoice() {
    const has = !!voice.track || !inVoice; // fora do canal o botão só guarda o mudo para quando entrar
    for (const [mic, icon] of [[$('micBtn'), $('micIcon')], [$('sideMic'), $('sideMic').querySelector('use')]]) {
      mic.dataset.state = has ? 'on' : 'none';
      mic.setAttribute('aria-pressed', String(has && voice.muted));
      setIcon(icon, has && !voice.muted ? 'mic' : 'mic-off');
      mic.setAttribute('aria-label', !has ? 'Ligar o microfone' : voice.muted ? 'Microfone mudo. Reativar' : 'Silenciar microfone');
      mic.title = mic.getAttribute('aria-label');
    }
    for (const [deaf, icon] of [[$('deafBtn'), $('deafIcon')], [$('sideDeaf'), $('sideDeaf').querySelector('use')]]) {
      deaf.setAttribute('aria-pressed', String(voice.deaf));
      setIcon(icon, voice.deaf ? 'headset-off' : 'headset');
      deaf.setAttribute('aria-label', voice.deaf ? 'Som da sala desligado. Reativar' : 'Desligar o som da sala');
      deaf.title = deaf.getAttribute('aria-label');
    }
    $('voiceMode').value = voice.mode;
    $('sensWrap').hidden = voice.mode !== 'vad';
    $('pttWrap').hidden = voice.mode !== 'ptt';
    $('sens').value = voice.sens;
    $('sens').style.setProperty('--fill', `${voice.sens}%`);
    $('sensOut').textContent = voice.sens ? `${Math.round(threshold())} dB` : 'sempre aberto';
    $('vuMark').style.left = `${voice.sens}%`;
    $('vuMark').hidden = voice.mode !== 'vad' || !voice.sens;
    $('pttKeyBtn').textContent = pickingKey === 'ptt' ? 'Aperte…' : keyName(voice.key);
    $('pttKeyBtn').setAttribute('aria-pressed', String(pickingKey === 'ptt'));
    if (MOB) { const c = inVoice && chanOf(myVch); MOB.callState(inVoice, inVoice ? `Na voz · ${c && c.kind === 'voice' ? c.name : 'Canal de voz'}` : ''); }
    if (DESK) {
      $('muteKeyBtn').textContent = pickingKey === 'mute' ? 'Aperte… (Backspace: nenhuma)' : keyName(voice.muteKey);
      $('muteKeyBtn').setAttribute('aria-pressed', String(pickingKey === 'mute'));
      DESK.core.invoke('tray_state', { inRoom: inVoice, muted: !!voice.track && voice.muted, deaf: voice.deaf }).catch(() => {});
      DESK.core.invoke('set_keys', { ptt: voice.mode === 'ptt' && !pickingKey ? voice.key : '', mute: pickingKey ? '' : voice.muteKey })
        .catch((err) => toast(`Essa tecla não funciona fora da janela (${err}). Escolha outra.`, 6000));
    }
    $('ecToggle').checked = voice.ec;
    $('nsToggle').checked = voice.ns;
    $('micTestBtn').disabled = !voice.track;
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
    const pc = e.vpc = new RTCPeerConnection(Peer.pcConfig());
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
    unboost(e.audio);
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
  function voiceOut(e) { // volume desta pessoa (lembrado, até 200%) + silenciar só para mim + ensurdecer
    const pf = pref(e);
    outLevel(e.audio, pf.v, voice.deaf || pf.m || pf.v === 0);
  }

  // ---------- volume por pessoa (S-1363) ----------
  // Só neste aparelho, lembrado por pessoa (pelo uid; quem ainda não tem, pelo nome). v = voz, s = som da tela,
  // de 0 a 2 (200%); m = silenciada só para mim (voz e tela).
  const prefs = (() => { try { const o = JSON.parse(store('pvol') || '{}'); return o && typeof o === 'object' ? o : {}; } catch { return {}; } })();
  const pkey = (e) => (e.uid ? `u:${e.uid}` : `n:${e.name}`);
  const num = (v, d) => (Number.isFinite(v) ? Math.min(2, Math.max(0, v)) : d);
  function pref(e) { const x = prefs[pkey(e)] || {}; return { v: num(x.v, 1), s: num(x.s, 1), m: x.m === true }; }
  function setPref(e, patch) {
    const pf = { ...pref(e), ...patch };
    if (pf.v === 1 && pf.s === 1 && !pf.m) delete prefs[pkey(e)]; else prefs[pkey(e)] = pf;
    store('pvol', JSON.stringify(prefs));
    voiceOut(e);
    if (e.tile) e.tile.sync();
    if (menuFor === e) paintUserMenu();
    renderPeople();
  }
  // Até 100% o próprio elemento toca, como sempre. Acima, o elemento fica mudo (só segura o fluxo do WebRTC, que o
  // Chrome exige para o Web Audio receber o som) e o som sai por um ganho do Web Audio. Antes do primeiro clique na
  // página o navegador não deixa o Web Audio tocar: fica em 100% até lá.
  let boostAc = null;
  const boosts = new WeakMap(); // elemento -> { src, gain, stream }
  function unboost(el) { const b = boosts.get(el); if (b) { b.src.disconnect(); b.gain.disconnect(); boosts.delete(el); } }
  function outLevel(el, vol, muted) {
    const s = el.srcObject;
    const want = !muted && vol > 1 && !!s && s.getAudioTracks().length > 0 && !(navigator.userActivation && !navigator.userActivation.hasBeenActive);
    if (!want) { unboost(el); el.volume = Math.min(1, vol); el.muted = muted; return; }
    if (!boostAc) {
      boostAc = new AudioContext({ latencyHint: 'interactive' });
      if (voice.out && boostAc.setSinkId) boostAc.setSinkId(voice.out).catch(() => {});
    }
    if (boostAc.state === 'suspended') boostAc.resume().catch(() => {});
    let b = boosts.get(el);
    if (!b || b.stream !== s) {
      unboost(el);
      const src = boostAc.createMediaStreamSource(s);
      const gain = boostAc.createGain();
      src.connect(gain).connect(boostAc.destination);
      b = { src, gain, stream: s };
      boosts.set(el, b);
    }
    b.gain.gain.value = vol;
    el.volume = 1;
    el.muted = true;
  }
  const reOut = () => { for (const e of peers.values()) { voiceOut(e); if (e.tile) e.tile.sync(); } };
  document.addEventListener('pointerdown', reOut, { once: true, capture: true });
  document.addEventListener('keydown', reOut, { once: true, capture: true });
  // menu da pessoa: botão direito (ou toque longo) em quem está no canal de voz, no cartão ou na tela dela
  let menuFor = null;
  function openUserMenu(e, x, y) {
    if (!e || !e.ready) return;
    closeMenus(); parkTools();
    menuFor = e;
    paintUserMenu();
    const menu = $('userMenu');
    menu.hidden = false;
    place(menu, x, y);
    $('umV').focus();
  }
  function paintUserMenu() {
    const e = menuFor;
    const pf = pref(e);
    paintAvatar($('umAvatar'), e.name, e.av);
    $('umName').textContent = e.name;
    for (const [id, k, what] of [['umV', 'v', 'voz'], ['umS', 's', 'tela']]) {
      const r = $(id);
      if (document.activeElement !== r) r.value = pf[k];
      r.style.setProperty('--fill', `${pf[k] * 50}%`);
      r.setAttribute('aria-label', `Volume da ${what} de ${e.name}`);
      $(`${id}Out`).textContent = `${Math.round(pf[k] * 100)}%`;
      $(`${id}Out`).classList.toggle('loud', pf[k] > 1);
    }
    $('umMute').checked = pf.m;
    $('userMenu').classList.toggle('is-hushed', pf.m);
  }
  const personAt = (t) => {
    const tile = t.closest('.tile:not(.is-local)');
    if (tile) return [...peers.values()].find((e) => e.tile && e.tile.el === tile) || null;
    const el = t.closest('.people li[data-id], .vcard[data-id], #focusFaces li[data-id]');
    return el ? peers.get(el.dataset.id) || null : null;
  };

  // ---------- perfil da pessoa (S-1412): foto grande, status, Sobre mim (público), Nota (só neste aparelho), Mensagem, volume ----------
  let profUid = '';
  const noteKey = (uid) => `note:${uid}`;
  function uidOfEl(li) {
    const id = li.dataset.id || '';
    if (id === 'me') return myUid;
    if (id.startsWith('u-')) return id.slice(2);
    const e = peers.get(id);
    return (e && e.uid) || li.querySelector('.avatar')?.dataset.uid || '';
  }
  function profInfo(uid) {
    const m = members.get(uid);
    if (uid === myUid) return { uid, name: myName, av: myAv, st: myStatus(), bio: store('bio') ?? (m ? m.bio : '') ?? '', since: m ? m.since : 0, you: true };
    if (m) return { ...m, bio: m.bio || '', you: false };
    const e = [...peers.values()].find((x) => x.uid === uid && x.ready);
    return e ? { uid, name: e.name, av: e.av, st: 'on', bio: '', since: 0, you: false } : null;
  }
  const bioSaved = () => store('bio') ?? (members.get(myUid)?.bio || '');
  function bioCount() {
    $('pfBioN').textContent = `${[...$('pfBioIn').value].length}/190`;
    $('pfBioSave').disabled = $('pfBioIn').value.trim() === bioSaved();
  }
  function paintProfile(live) {
    const p = profInfo(profUid);
    if (!p) { $('profDlg').close(); return; }
    let hue = 0;
    for (const ch of p.name) hue = (hue * 31 + ch.codePointAt(0)) % 360;
    $('pfBanner').style.setProperty('--h', String(hue));
    paintAvatar($('pfAv'), p.name, p.av);
    $('pfAv').dataset.st = p.st;
    $('pfName').textContent = p.you ? `${p.name} (você)` : p.name;
    $('pfDot').dataset.st = p.st;
    $('pfStTx').textContent = p.you && stPick === 'off' ? 'Invisível' : p.st === 'off' ? `Offline${p.seen ? ` · visto ${when(p.seen)}` : ''}` : ST_NAME[p.st];
    $('pfSince').textContent = p.since ? new Date(p.since).toLocaleDateString('pt-BR', { day: 'numeric', month: 'long', year: 'numeric' }) : '—';
    $('pfBio').hidden = p.you;
    $('pfBioEdit').hidden = !p.you;
    $('pfBio').textContent = p.bio || 'Sem nada por aqui ainda.';
    $('pfBio').classList.toggle('is-empty', !p.bio);
    if (p.you && !(live && document.activeElement === $('pfBioIn'))) { $('pfBioIn').value = p.bio; }
    if (p.you) bioCount();
    $('pfNoteSec').hidden = p.you;
    if (!p.you && !(live && document.activeElement === $('pfNote'))) $('pfNote').value = store(noteKey(p.uid)) || '';
    $('pfMsg').hidden = p.you;
    const e = [...peers.values()].find((x) => x.uid === p.uid && x.ready && x.invoice);
    $('pfVol').hidden = p.you || !e;
    if (e) {
      const pf = pref(e);
      if (document.activeElement !== $('pfVolIn')) $('pfVolIn').value = pf.m ? 0 : pf.v;
      $('pfVolIn').style.setProperty('--fill', `${$('pfVolIn').value * 50}%`);
      $('pfVolOut').textContent = `${Math.round($('pfVolIn').value * 100)}%`;
      $('pfVolIn').setAttribute('aria-label', `Volume da voz de ${p.name}`);
    }
  }
  function openProfile(uid) {
    if (!/^[a-f0-9]{16}$/.test(uid || '') || !profInfo(uid)) return;
    closeMenus();
    profUid = uid;
    paintProfile(false);
    if (!$('profDlg').open) $('profDlg').showModal();
    $('profDlg').scrollTop = 0;
  }
  $('pfAv').addEventListener('click', () => {
    const p = profInfo(profUid);
    if (!p) return;
    $('zoomAv').removeAttribute('data-av');
    paintAvatar($('zoomAv'), p.name, p.av);
    $('zoomAv').setAttribute('aria-label', `Foto de ${p.name}`);
    $('zoomDlg').showModal();
  });
  $('zoomDlg').addEventListener('click', () => $('zoomDlg').close());
  $('profDlg').addEventListener('click', (ev) => { if (ev.target === $('profDlg')) $('profDlg').close(); }); // clique fora fecha
  $('pfBioIn').addEventListener('input', bioCount);
  $('pfBioSave').addEventListener('click', () => {
    store('bio', $('pfBioIn').value.replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 190));
    sendMe(); paintProfile(false); toast('Sobre mim salvo');
  });
  $('pfNote').addEventListener('input', () => { if (profUid) store(noteKey(profUid), $('pfNote').value.slice(0, 200)); }); // só localStorage: nunca vai ao servidor
  $('pfVolIn').addEventListener('input', () => {
    const e = [...peers.values()].find((x) => x.uid === profUid && x.ready);
    if (e) setPref(e, { v: Number($('pfVolIn').value), m: false });
    $('pfVolOut').textContent = `${Math.round($('pfVolIn').value * 100)}%`;
    $('pfVolIn').style.setProperty('--fill', `${$('pfVolIn').value * 50}%`);
  });
  $('pfMsg').addEventListener('click', () => {
    const p = profInfo(profUid);
    $('profDlg').close();
    if (!p) return;
    openText(textCh || 'chat');
    const inp = $('chatInput');
    const tag = `@${p.name} `;
    if (!inp.value.includes(tag)) inp.value = `${inp.value}${inp.value && !/\s$/.test(inp.value) ? ' ' : ''}${tag}`;
    inp.focus();
    inp.setSelectionRange(inp.value.length, inp.value.length);
  });

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
    // bytes de vídeo da tela enviados/recebidos por pessoa (teste de ponta a ponta)
    screen: async () => Promise.all([...peers.values()].map(async (e) => {
      const sum = async (c, kind) => { let n = 0; if (c && c.peerConnection) (await c.peerConnection.getStats()).forEach((r) => { if (r.kind === 'video' && r.type === kind) n += r.bytesSent || r.bytesReceived || 0; }); return n; };
      return { name: e.name, out: !!e.out, call: !!e.call, sent: await sum(e.out, 'outbound-rtp'), got: await sum(e.call, 'inbound-rtp') };
    })),
    mic: () => (voice.track ? { ...voice.track.getSettings(), enabled: voice.track.enabled, levelDb: Math.round(voice.db), talking: voice.talking } : null),
    // S-1357: membros como o servidor do chat informou e "ausente automático" com prazo curto (teste)
    members: () => [...members.values()],
    me: () => ({ uid: myUid, status: myStatus(), pick: stPick }),
    idleAfter: (ms) => { idleMs = ms; return checkIdle(); },
    // S-1363: canais, volume por pessoa (ganho acima de 100%) e o que o codificador da tela recebeu
    chans: () => ({ list: chans, textCh, myVch, viewVch, unread: Object.fromEntries(unreadBy) }),
    boost: () => [...peers.values()].map((e) => ({
      name: e.name, ac: boostAc ? boostAc.state : null, audioMuted: e.audio.muted, audioVol: e.audio.volume,
      voice: boosts.has(e.audio) ? boosts.get(e.audio).gain.gain.value : null,
      screen: e.tile && boosts.has(e.tile.video) ? boosts.get(e.tile.video).gain.gain.value : null,
      screenMuted: e.tile ? e.tile.video.muted : null, screenVol: e.tile ? e.tile.video.volume : null,
    })),
    sendParams: () => [...peers.values()].filter((e) => e.out && e.out.peerConnection).map((e) => {
      const s = e.out.peerConnection.getSenders().find((x) => x.track && x.track.kind === 'video');
      return { name: e.name, enc: s ? s.getParameters().encodings[0] : null, settings: local ? local.stream.getVideoTracks()[0].getSettings() : null };
    }),
    // S-1566: Bagre DJ — estado do canal em que estou e o que o player deste aparelho está tocando
    dj: () => {
      const s = dj.st.get(myVch);
      const cur = djCur(s);
      const tk = dj.tk;
      const at = tk ? (tk.st === 1 ? tk.t + (Date.now() - tk.ts) / 1000 : tk.t) : null;
      return { id: cur && cur.id, k: cur && cur.k, title: cur && cur.t, paused: s ? s.paused : null, target: s && cur ? djPos(s) : null,
        st: tk ? tk.st : null, at, now: Date.now(), pid: tk ? tk.id : '', pv: tk ? tk.v : null, pm: tk ? tk.m : null, ready: dj.ready, frame: !!dj.frame, aud: !!dj.aud, results: !!dj.res, soundMs: dj.aud ? dj.aud.soundMs : null, fb: [...dj.fb], blocked: dj.blocked,
        q: s ? s.q.map((x) => x.t) : [], i: s ? s.i : -1, loop: s ? s.loop : 'off', auto: s ? !!s.auto : false, stay: s ? s.stay || 0 : 0, off: dj.off, rtt: dj.rtt, vol: dj.vol, mute: dj.mute || voice.deaf, fixes: dj.fixes };
    },
    musSend: (op, extra) => musSend(op, extra || {}),
    band: (limited, avail) => { if (local) checkBand(limited, avail, target(local.stream.getVideoTracks()[0])); return { n: band.n, warned: band.warned }; },
  };

  // ---------- Bagre DJ (S-1566): música do YouTube sincronizada no canal de voz, como um bot de música do Discord ----------
  // O estado de cada canal (fila, vídeo, quando começou, pausa) fica no servidor do chat e chega a todos. Cada pessoa no
  // canal toca o player oficial do YouTube no próprio aparelho (player.html do site num iframe: o app não manda o Referer
  // que o YouTube exige) e o tempo é acertado pelo relógio do servidor: desvio maior que 1 s volta para o ponto certo.
  // O som do player é só deste aparelho: não passa pelo microfone e a captura de tela deixa de fora o som do próprio
  // BAGRENATION (restrictOwnAudio no site; process loopback sem o app no PC).
  const djCur = (s) => (s && s.i >= 0 && s.i < s.q.length ? s.q[s.i] : null);
  const srvNow = () => Date.now() + (dj.off || 0);
  const djPos = (s) => (s.paused ? s.pos : Math.max(0, (srvNow() - s.at) / 1000));
  const mmss = (t) => { t = Math.max(0, Math.floor(t || 0)); const h = Math.floor(t / 3600); const m = Math.floor((t % 3600) / 60); return `${h ? `${h}:${two(m)}` : m}:${two(t % 60)}`; };
  const thumb = (id, hq) => `https://i.ytimg.com/vi/${id}/${hq ? 'hqdefault' : 'mqdefault'}.jpg`;
  const djHere = () => inVoice && myVch === viewVch;
  function djClean(s) { // estado vindo do servidor: só o que a tela usa, com tipos conferidos
    if (!s || typeof s !== 'object' || !Array.isArray(s.q)) return null;
    const q = s.q.filter((x) => x && /^[A-Za-z0-9_-]{11}$/.test(x.id) && typeof x.k === 'string').map((x) => ({
      k: x.k.slice(0, 16), id: x.id, t: String(x.t || 'Vídeo do YouTube').slice(0, 140), a: String(x.a || '').slice(0, 60), d: Number(x.d) > 0 ? Number(x.d) : 0, by: String(x.by || '').slice(0, 24),
    }));
    return { q, i: Number.isInteger(s.i) ? s.i : -1, at: Number(s.at) || 0, pos: Number(s.pos) || 0, paused: s.paused === true, loop: ['off', 'all', 'one'].includes(s.loop) ? s.loop : 'off', v: Number(s.v) || 0,
      auto: s.auto === true, stay: Number(s.stay) || 0 }; // S-0033: autoplay e até quando o DJ espera no canal sem música
  }
  function djClock(ws) { // 5 medidas do relógio do servidor; vale a de menor ida e volta
    dj.rtt = Infinity;
    for (let n = 0; n < 5; n++) setTimeout(() => { if (chat.ws === ws && chatOpen()) ws.send(JSON.stringify({ t: 'clk', c: Date.now() })); }, n * 350);
  }
  setInterval(() => { if (chatOpen()) djClock(chat.ws); }, 300000);
  function onDj(d) {
    if (d.t === 'clk') {
      const now = Date.now();
      const rtt = now - Number(d.c);
      if (Number.isFinite(rtt) && rtt >= 0 && rtt < dj.rtt && Number.isFinite(d.s)) { dj.rtt = rtt; dj.off = d.s - (Number(d.c) + rtt / 2); }
    } else if (d.t === 'mus' && typeof d.ch === 'string') {
      const s = djClean(d.s);
      if (!s) return;
      const old = dj.st.get(d.ch);
      if (old && old.v > s.v && s.v) return; // chegou fora de ordem
      if (dj.off === null && Number.isFinite(d.now)) dj.off = d.now - Date.now(); // antes da primeira medida
      dj.st.set(d.ch, s);
      renderPeople();
      djSync();
    } else if (d.t === 'ytres' && d.n === dj.n) {
      const n = d.n;
      if (typeof d.needIds === 'string' && d.needIds) { // playlist sem a Data API no servidor: o player lista os vídeos, o servidor dá os títulos
        djProbe(d.needIds).then((ids) => {
          if (n !== dj.n) return;
          if (ids.length && chatOpen()) chat.ws.send(JSON.stringify({ t: 'yt', ids, n }));
          else onDj({ t: 'ytres', n, list: [], err: 'Não consegui ler essa playlist (privada, vazia ou mix automático).' });
        });
        return;
      }
      dj.res = { list: Array.isArray(d.list) ? d.list.filter((x) => x && /^[A-Za-z0-9_-]{11}$/.test(x.id)).slice(0, 100) : [], err: String(d.err || ''), label: String(d.label || ''), q: dj.res ? dj.res.q : '',
        more: Number.isInteger(d.more) && d.more > 0 ? Math.min(d.more, 100) : 0, total: Number.isInteger(d.total) ? d.total : 0, link: typeof d.link === 'string' ? d.link.slice(0, 300) : '' }; // S-0032: playlist do Spotify (o resto o servidor põe aos poucos)
      $('djGo').disabled = false;
      if (dj.auto && dj.auto.n === n) { // /play <link de playlist>: tudo direto para a fila
        const a = dj.auto;
        dj.auto = null;
        if (dj.res.list.length) musSend('add', { items: dj.res.list, tc: a.tc, now: a.now, top: a.top });
        else djEphemeral(dj.res.err || 'Nada encontrado nessa playlist.');
        dj.res = null;
      }
      renderDjRes();
    } else if (d.t === 'lyrres' && d.n === dj.ly) { // S-0033: letra (LRCLIB) ou o aviso de que não achou
      if (d.err) djEphemeral(String(d.err).slice(0, 200));
      else djEphemeral('', djLyricsEl(d));
    } else if (d.t === 'musok' && typeof d.title === 'string') {
      if (Date.now() - (dj.cmdAt || 0) < 15000) return; // S-0059: pedido pelo chat: o aviso do DJ já entra no painel de música
      toast(typeof d.note === 'string' && d.note ? d.note.slice(0, 200) : d.n > 1 ? `${d.n} músicas na fila` : d.now ? `Tocando agora: ${d.title}` : `Na fila: ${d.title}`);
    }
  }
  function musSend(op, extra = {}) {
    if (!inVoice) { toast('Entre num canal de voz para usar o Bagre DJ.'); return false; }
    if (!chatOpen()) { toast('O chat está reconectando. Tente de novo em instantes.'); return false; }
    chat.ws.send(JSON.stringify({ t: 'mus', ch: myVch, op, ...extra }));
    return true;
  }

  // player deste aparelho (só existe enquanto estou num canal de voz com música). No app (S-1580) é um <audio> escondido:
  // o app pede ao yt-dlp o endereço do áudio do vídeo (cada PC o seu) e nada de vídeo aparece. Se não der, aquele vídeo
  // volta ao player oficial (dj.fb) e a música não para. O <audio> responde às mesmas ordens e avisa no mesmo formato (dj.tk).
  function audUrl(id) { // Promise<endereço>: guardado até perto de vencer (o endereço traz expire=<segundos>)
    const c = dj.urls.get(id);
    if (c && (c.p || c.exp - Date.now() > 120000)) return c.p || Promise.resolve(c.url);
    const p = DESK.core.invoke('dj_audio', { id }).then((url) => {
      const exp = Number(new URL(url).searchParams.get('expire')) * 1000 || Date.now() + 3600000;
      dj.urls.set(id, { url, exp });
      return url;
    }, (err) => { dj.urls.delete(id); throw err; });
    dj.urls.set(id, { p });
    if (dj.urls.size > 60) dj.urls.delete(dj.urls.keys().next().value);
    return p;
  }
  function audMake() {
    const a = new Audio();
    a.preload = 'auto';
    const x = dj.aud = { a, id: '', play: false, retried: '', t0: 0, soundMs: null, timer: 0 };
    const tell = () => {
      if (dj.aud !== x) return;
      const st = !x.id ? -1 : a.ended ? 0 : !a.src ? 3 : a.paused ? (x.play ? 3 : 2) : a.readyState < 3 ? 3 : 1;
      dj.tk = { st, t: a.currentTime || 0, d: Number.isFinite(a.duration) ? a.duration : 0, id: x.id, ts: Date.now(), v: Math.round(a.volume * 100), m: a.muted };
    };
    x.timer = setInterval(tell, 250);
    for (const ev of ['playing', 'pause', 'ended', 'waiting', 'seeked']) a.addEventListener(ev, tell);
    a.addEventListener('playing', () => { if (x.soundMs === null && x.t0) x.soundMs = Math.round(performance.now() - x.t0); });
    a.addEventListener('loadedmetadata', () => { // chegou o áudio: vai para o ponto em que o canal está agora
      const s = dj.st.get(myVch), cur = djCur(s);
      if (cur && cur.id === x.id) a.currentTime = djPos(s);
      if (x.play) a.play().catch(() => {});
    });
    a.addEventListener('error', () => { if (a.src && x.id) audFail(x, x.id, true); });
    dj.ready = true; dj.tk = null; dj.loaded = ''; dj.sentVol = '';
  }
  function audFail(x, id, media) { // endereço vencido: pede outro 1 vez; senão este vídeo toca pelo player oficial
    if (dj.aud !== x || x.id !== id) return;
    if (media && x.retried !== id) { x.retried = id; dj.urls.delete(id); x.id = ''; dj.loaded = ''; djSync(); return; }
    console.warn('Bagre DJ: áudio direto falhou, usando o player do YouTube', id);
    dj.fb.add(id);
    djSync();
  }
  function audRun(d) {
    const x = dj.aud, a = x.a;
    if (d.op === 'load') {
      if (d.id === x.id) { if (a.src) a.currentTime = d.at; x.play = d.play; if (d.play) a.play().catch(() => {}); else a.pause(); return; }
      x.id = d.id; x.play = d.play; x.t0 = performance.now(); x.soundMs = null;
      a.pause(); a.removeAttribute('src'); a.load();
      audUrl(d.id).then((url) => { if (dj.aud === x && x.id === d.id) a.src = url; }, () => audFail(x, d.id, false));
    } else if (d.op === 'play') { x.play = true; if (a.src) a.play().catch(() => {}); }
    else if (d.op === 'pause') { x.play = false; a.pause(); }
    else if (d.op === 'seek') { if (a.src) a.currentTime = Math.max(0, Number(d.at) || 0); }
    else if (d.op === 'vol') { a.volume = Math.max(0, Math.min(100, d.v)) / 100; a.muted = d.m === true; }
    else if (d.op === 'stop') { x.id = ''; x.play = false; a.pause(); a.removeAttribute('src'); a.load(); }
  }
  function djCmd(msg) { if (dj.aud) { audRun(msg); return; } if (dj.frame && dj.frame.contentWindow) dj.frame.contentWindow.postMessage({ bp: 1, ...msg }, PLAYER_ORIGIN); }
  function djFrame() {
    const f = dj.frame = document.createElement('iframe');
    f.src = PLAYER;
    f.title = 'Player do YouTube do Bagre DJ';
    f.allow = 'autoplay; encrypted-media; picture-in-picture';
    f.referrerPolicy = 'strict-origin-when-cross-origin';
    dj.ready = false; dj.tk = null; dj.loaded = ''; dj.sentVol = '';
    clearInterval(dj.hello);
    dj.hello = setInterval(() => { if (dj.frame !== f || dj.ready) clearInterval(dj.hello); else djCmd({ op: 'hello' }); }, 400);
    $('djFrame').replaceChildren(f);
  }
  function djKill() {
    clearInterval(dj.hello);
    if (dj.aud) { clearInterval(dj.aud.timer); audRun({ op: 'stop' }); dj.aud = null; }
    if (dj.frame) dj.frame.remove();
    dj.frame = null; dj.ready = false; dj.tk = null; dj.loaded = ''; dj.blocked = false;
  }
  window.addEventListener('message', (ev) => {
    if (!dj.frame || ev.source !== dj.frame.contentWindow || ev.origin !== PLAYER_ORIGIN) return;
    const d = ev.data;
    if (!d || d.bp !== 1) return;
    if (d.ev === 'ready') { dj.ready = true; dj.loaded = ''; dj.sentVol = ''; djSync(); }
    else if (d.ev === 'tick') { dj.tk = { st: Number(d.st), t: Number(d.t) || 0, d: Number(d.d) || 0, id: String(d.id || ''), ts: Date.now(), v: Number(d.v), m: d.m === true }; }
    else if (d.ev === 'error') {
      const s = dj.st.get(myVch);
      const cur = djCur(s);
      const code = Number(d.code);
      if (!cur || d.id !== cur.id) return;
      if ([2, 100, 101, 150].includes(code)) {
        if (dj.badSent === cur.k) return;
        dj.badSent = cur.k;
        musSend('bad', { k: cur.k, code });
      } else if (code === 153 && !dj.err153) { dj.err153 = true; toast('O YouTube recusou o player aqui (erro 153). Avise no #chat.', 8000); }
    }
  });
  function djVolume() {
    const m = dj.mute || voice.deaf; // som da sala desligado também cala a música (como no Discord)
    const key = `${dj.vol}|${m}`;
    if (key === dj.sentVol) return;
    dj.sentVol = key;
    djCmd({ op: 'vol', v: dj.vol, m });
  }
  function djSync() {
    if (!inVoice) { if (dj.frame || dj.aud) djKill(); renderDj(); return; } // S-0065: o <audio> do app de PC também (antes só o iframe)
    const s = dj.st.get(myVch);
    const cur = djCur(s);
    if (!cur) { // nada tocando no meu canal (!stop, !dc, fila acabou, troquei para um canal sem música): o player daqui para
      if ((dj.frame || dj.aud) && (dj.loaded || (dj.tk && dj.tk.st === 1))) { djCmd({ op: 'stop' }); dj.loaded = ''; }
      dj.blocked = false; renderDj(); return;
    }
    const aud = !!DESK && !dj.fb.has(cur.id);
    if (aud ? !dj.aud : !dj.frame) { djKill(); if (aud) audMake(); else djFrame(); }
    renderDj();
    if (!dj.ready) return;
    djVolume();
    const key = `${cur.k}:${s.at}:${s.paused}`;
    const target = djPos(s);
    if (cur.d && !s.paused && target > cur.d + 4 && dj.endSent !== cur.k + s.at) { dj.endSent = cur.k + s.at; musSend('ended', { k: cur.k }); return; } // passou do fim sem ninguém ouvindo
    if (dj.loaded !== key) { // música nova, pausa, volta ou pulo de posição: manda o player para o ponto certo
      dj.loaded = key; dj.loadAt = Date.now(); dj.fixAt = Date.now();
      djCmd({ op: 'load', id: cur.id, at: target, play: !s.paused });
      return;
    }
    const tk = dj.tk;
    if (!tk || tk.id !== cur.id) return;
    if (!cur.d && tk.d > 0 && dj.durSent !== cur.k) { dj.durSent = cur.k; musSend('dur', { k: cur.k, d: tk.d }); }
    if (tk.st === 0) { // acabou aqui: avisa (o servidor só aceita perto do fim e conta um aviso só)
      if (!s.paused && dj.endSent !== cur.k + s.at) { dj.endSent = cur.k + s.at; musSend('ended', { k: cur.k }); }
      return;
    }
    const est = tk.st === 1 ? tk.t + (Date.now() - tk.ts) / 1000 : tk.t;
    const late = Date.now() - dj.fixAt;
    if (s.paused) {
      if (tk.st === 1 || tk.st === 3) djCmd({ op: 'pause' });
      else if (Math.abs(est - target) > 1 && late > 1500) { dj.fixAt = Date.now(); djCmd({ op: 'seek', at: target }); }
      dj.blocked = false;
    } else {
      if (tk.st === 2 || tk.st === 5 || tk.st === -1) { if (late > 1000) { dj.fixAt = Date.now(); djCmd({ op: 'play' }); } }
      else if (tk.st === 1 && Math.abs(est - target) > 1 && late > 2500) { dj.fixAt = Date.now(); dj.fixes++; djCmd({ op: 'seek', at: target + 0.15 }); }
      dj.blocked = tk.st !== 1 && tk.st !== 3 && Date.now() - dj.loadAt > 5000; // navegador barrou o som sem um clique
      const nx = s.q[s.i + 1];
      if (dj.aud && tk.st === 1 && nx && dj.pre !== nx.k) { dj.pre = nx.k; audUrl(nx.id).catch(() => {}); } // a próxima já fica pronta
    }
    $('djTap').hidden = !dj.blocked;
  }
  setInterval(() => { if (room) { djSync(); djProgress(); djCardsTick(); djBeat(); } }, 500);

  // painel do Bagre DJ
  function renderDj() {
    const ch = viewVch;
    const s = dj.st.get(ch);
    const cur = djCur(s);
    const here = djHere();
    const upcoming = s ? s.q.slice(Math.max(0, s.i + 1)) : [];
    const show = $('room').dataset.view === 'voice' && (dj.pref === 'open' || (dj.pref === 'auto' && (!!cur || upcoming.length > 0)));
    $('dj').hidden = !show;
    $('djBtn').setAttribute('aria-expanded', String(show));
    $('djBtn').classList.toggle('is-on', !!djCur(dj.st.get(myVch)));
    $('dj').classList.toggle('is-here', here);
    $('dj').classList.toggle('is-playing', !!cur && !s.paused);
    paintAvatar(document.querySelector('#dj .dj-av'), 'Bagre DJ', 'dj');
    if (!show) return;
    const live = here && !!dj.frame;
    $('djFrame').hidden = !live || !cur;
    $('djCover').hidden = !cur; // a capa fica por cima: nada de vídeo na tela (S-1580)
    if (cur && $('djCover').dataset.id !== cur.id) { $('djCover').dataset.id = cur.id; $('djCover').src = thumb(cur.id, true); }
    $('djIdle').hidden = !!cur;
    $('djIdleText').textContent = s && s.q.length && !cur ? 'A fila acabou' : 'Nada tocando';
    $('djState').textContent = !cur ? 'Bagre DJ' : s.paused ? 'Pausado' : here ? 'Tocando agora' : `Tocando agora em ${chanLabel(ch)}`;
    $('djTitle').textContent = cur ? cur.t : 'Peça uma música';
    $('djTitle').title = cur ? cur.t : '';
    $('djBy').textContent = cur ? [cur.a, cur.by && `pedido por ${cur.by}`].filter(Boolean).join(' · ') : here ? 'Busque aqui do lado ou mande /play <nome ou link> no chat.' : '';
    setIcon($('djPlayIcon'), cur && s.paused ? 'play' : 'pause');
    $('djPlay').setAttribute('aria-label', cur && s.paused ? 'Tocar' : 'Pausar');
    $('djPlay').title = $('djPlay').getAttribute('aria-label');
    for (const id of ['djPlay', 'djNext', 'djStop', 'djSeek']) $(id).disabled = !here || !cur;
    $('djPrev').disabled = !here || !s || (!cur && s.i <= 0);
    $('djShuffle').disabled = !here || upcoming.length < 2;
    $('djStop').disabled = !here || !s || !s.q.length;
    $('djLoop').disabled = !here;
    const loop = s ? s.loop : 'off';
    const ln = { off: 'Repetir: desligado', all: 'Repetir: a fila', one: 'Repetir: esta música' }[loop];
    $('djLoop').setAttribute('aria-pressed', String(loop !== 'off'));
    $('djLoop').setAttribute('aria-label', ln); $('djLoop').title = ln;
    $('djLoopOne').hidden = loop !== 'one';
    const m = dj.mute || voice.deaf;
    setIcon($('djMuteIcon'), m ? 'mute' : 'vol');
    $('djMute').setAttribute('aria-pressed', String(dj.mute));
    $('djMute').setAttribute('aria-label', dj.mute ? 'Música muda para você. Reativar' : voice.deaf ? 'Som da sala desligado' : 'Mutar só a música');
    if (document.activeElement !== $('djVol')) $('djVol').value = String(dj.vol);
    $('djVol').style.setProperty('--fill', `${dj.vol}%`);
    $('djVolOut').textContent = m ? 'mudo' : `${dj.vol}%`;
    const note = !inVoice ? 'Entre no canal de voz para ouvir e controlar a música.' : !here ? `Você está em ${chanLabel(myVch)}. Entre neste canal para ouvir.` : '';
    $('djNote').hidden = !note;
    $('djNote').textContent = note;
    $('djTap').hidden = !here || !dj.blocked;
    $('djForm').classList.toggle('is-off', !here);
    $('djCount').textContent = upcoming.length ? String(upcoming.length) : '';
    const qKey = `${ch}|${s ? s.v : 0}|${here}`;
    if (qKey !== dj.qKey) { dj.qKey = qKey; renderDjQueue(s, upcoming, here); }
    djProgress();
  }
  function djRow(x, n, here, acts) { // linha de música: capa, título, canal/duração e botões
    const li = document.createElement('li');
    li.className = 'dj-item';
    if (x.k) li.dataset.k = x.k;
    if (n) li.append(Object.assign(document.createElement('span'), { className: 'dj-n', textContent: String(n) }));
    li.append(Object.assign(document.createElement('img'), { className: 'dj-thumb', src: thumb(x.id), alt: '', loading: 'lazy', width: 64, height: 36 }));
    const info = Object.assign(document.createElement('span'), { className: 'dj-info' });
    info.append(Object.assign(document.createElement('span'), { className: 'dj-t', textContent: x.t, title: x.t }),
      Object.assign(document.createElement('span'), { className: 'dj-a', textContent: [x.d ? mmss(x.d) : '', x.a, x.by && `por ${x.by}`].filter(Boolean).join(' · ') }));
    li.append(info);
    const box = Object.assign(document.createElement('span'), { className: 'dj-acts' });
    for (const [icon, label, fn, extra] of acts) {
      const b = Object.assign(document.createElement('button'), { type: 'button', className: `icon-btn ${extra || ''}`.trim(), title: label, disabled: !here });
      b.setAttribute('aria-label', `${label}: ${x.t}`);
      b.innerHTML = icon.startsWith('<') ? icon : `<svg class="ic" aria-hidden="true"><use href="#i-${icon}"/></svg>`;
      b.addEventListener('click', fn);
      box.append(b);
    }
    li.append(box);
    return li;
  }
  const UP = '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M7 3h2v1H7zM6 4h4v1H6zM5 5h6v1H5zM4 6h8v1H4zM7 7h2v6H7z"/></svg>';
  const DOWN = '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M7 3h2v6H7zM4 9h8v1H4zM5 10h6v1H5zM6 11h4v1H6zM7 12h2v1H7z"/></svg>';
  function renderDjQueue(s, upcoming, here) {
    const base = s ? Math.max(0, s.i + 1) : 0;
    $('djQueue').replaceChildren(...upcoming.map((x, n) => djRow(x, n + 1, here, [
      [UP, 'Subir na fila', () => musSend('mv', { k: x.k, to: base + n - 1 }), n === 0 ? 'is-dim' : ''],
      [DOWN, 'Descer na fila', () => musSend('mv', { k: x.k, to: base + n + 1 }), n === upcoming.length - 1 ? 'is-dim' : ''],
      ['play', 'Tocar agora', () => musSend('jump', { k: x.k })],
      ['close', 'Tirar da fila', () => musSend('rm', { k: x.k })],
    ])));
    if (!upcoming.length) $('djQueue').append(Object.assign(document.createElement('li'), { className: 'dj-empty', textContent: 'A fila está vazia.' }));
  }
  function renderDjRes() {
    const r = dj.res;
    $('djResWrap').hidden = !r;
    if (!r) return;
    const here = djHere();
    $('djResHead').textContent = r.loading ? 'Buscando…' : r.err ? 'Busca' : r.label ? `Playlist ${r.label} · ${r.more ? `${r.list.length} de ${r.list.length + r.more}` : r.list.length}` : `Resultados para “${r.q.slice(0, 40)}”`;
    const rows = [];
    if (r.err && !r.loading) rows.push(Object.assign(document.createElement('li'), { className: 'dj-empty dj-err', textContent: r.err }));
    else if (!r.loading && !r.list.length) rows.push(Object.assign(document.createElement('li'), { className: 'dj-empty', textContent: 'Nada encontrado.' }));
    if ((r.list.length > 1 || r.more) && r.label) {
      const li = Object.assign(document.createElement('li'), { className: 'dj-all' });
      const all = r.list.length + r.more;
      const b = Object.assign(document.createElement('button'), { type: 'button', className: 'btn btn-primary', textContent: `Pôr as ${all} na fila`, disabled: !here });
      b.addEventListener('click', () => { if (r.more && r.link ? musSend('play', { q: r.link }) : musSend('add', { items: r.list })) closeDjRes(); }); // Spotify: o servidor põe todas (as primeiras tocam logo)
      li.append(b);
      rows.push(li);
    }
    for (const x of r.list.slice(0, r.label ? 100 : 12)) {
      rows.push(djRow(x, 0, here, [
        ['play', 'Tocar agora', () => { if (musSend('add', { items: [x], now: true })) closeDjRes(); }, 'dj-go'],
        ['plus', 'Adicionar à fila', () => musSend('add', { items: [x] })],
      ]));
    }
    $('djResults').replaceChildren(...rows);
  }
  function closeDjRes() { dj.res = null; dj.n++; renderDjRes(); }
  function djProbe(list) { // iframe à parte (fora da tela, sem tocar) que só lê os ids de uma playlist
    return new Promise((resolve) => {
      const f = Object.assign(document.createElement('iframe'), { src: PLAYER, title: 'Lendo a playlist', className: 'dj-probe', tabIndex: -1 });
      f.setAttribute('aria-hidden', 'true');
      let done = false;
      const fin = (ids) => { if (done) return; done = true; clearInterval(h); clearTimeout(to); window.removeEventListener('message', on); f.remove(); resolve(ids); };
      const on = (ev) => {
        if (ev.source !== f.contentWindow || ev.origin !== PLAYER_ORIGIN || !ev.data || ev.data.bp !== 1) return;
        if (ev.data.ev === 'ready') { clearInterval(h); f.contentWindow.postMessage({ bp: 1, op: 'list', list }, PLAYER_ORIGIN); }
        else if (ev.data.ev === 'list' && ev.data.list === list) fin(Array.isArray(ev.data.ids) ? ev.data.ids.filter((v) => /^[A-Za-z0-9_-]{11}$/.test(v)) : []);
      };
      window.addEventListener('message', on);
      const h = setInterval(() => { if (f.contentWindow) f.contentWindow.postMessage({ bp: 1, op: 'hello' }, PLAYER_ORIGIN); }, 400);
      const to = setTimeout(() => fin([]), 20000);
      document.body.append(f);
    });
  }
  function djSearch(q, auto) {
    q = clean(q, 300);
    if (!q) return;
    if (!chatOpen()) { toast('O chat está reconectando. Tente de novo em instantes.'); return; }
    dj.n++;
    dj.auto = auto ? { ...auto, n: dj.n } : null;
    dj.res = { list: [], err: '', label: '', q, loading: true };
    $('djGo').disabled = true;
    setTimeout(() => { $('djGo').disabled = false; }, 4000);
    chat.ws.send(JSON.stringify({ t: 'yt', q, n: dj.n }));
    renderDjRes();
  }
  function djProgress() {
    const s = dj.st.get(viewVch);
    const cur = djCur(s);
    if ($('dj').hidden) return;
    const t = cur ? Math.min(djPos(s), cur.d || Infinity) : 0;
    const d = cur ? cur.d || (dj.tk && dj.tk.id === cur.id ? dj.tk.d : 0) : 0;
    $('djCurT').textContent = mmss(t);
    $('djDurT').textContent = d ? mmss(d) : cur ? '--:--' : '0:00';
    const seek = $('djSeek');
    if (!seek.matches(':active') && document.activeElement !== seek) {
      seek.max = String(Math.max(1, Math.round(d)));
      seek.value = String(Math.round(t));
    }
    seek.style.setProperty('--fill', `${d ? Math.min(100, (t / d) * 100) : 0}%`);
  }
  // S-0059 (Alisson 22/11: "Deixa só coisas de música somente na aba de música"): o Bagre DJ não escreve nada no chat de texto.
  // Resposta de comando e aviso do DJ entram no painel de música (#djFeed): aviso curto some sozinho (toast discreto ali);
  // fila, letra, ajuda e Tocando agora pedidos com comando abrem o painel e ficam lá até fechar.
  const djShown = () => !$('dj').hidden;
  function djFeedAdd(text, extra, mine) {
    const box = $('djFeed');
    const li = Object.assign(document.createElement('li'), { className: `dj-fi${extra ? ' has-djc' : ''}` });
    if (text) li.append(p_('dj-ft', text));
    if (extra) {
      li.append(extra);
      li.prepend(djBtn('close', 'Fechar', () => li.remove(), 'dj-fx djc-any'));
      for (const old of [...box.querySelectorAll('.dj-fi.has-djc')]) old.remove(); // 1 cartão por vez
    } else setTimeout(() => { li.classList.add('out'); setTimeout(() => li.remove(), 400); }, 6000);
    box.prepend(li);
    while (box.children.length > 4) box.lastElementChild.remove();
    if (extra) { dj.pref = 'open'; if ($('room').dataset.view !== 'voice') setView('voice'); renderDj(); }
    else if (mine && !djShown()) toast(text.slice(0, 200));
  }
  function djEphemeral(text, extra) { djFeedAdd(text, extra, true); } // resposta que só eu vejo: no painel de música
  function djNotice(d) { // aviso do DJ para o canal de voz d.ch (antes ia para o chat)
    if (d.ch && d.ch !== myVch && d.ch !== viewVch) return;
    djFeedAdd(d.text.slice(0, 300), null, Date.now() - (dj.cmdAt || 0) < 15000);
  }
  function djPlay(arg, now, tc, top) { // nome ou link: a 1ª música achada toca (ou entra na fila); playlist do YouTube vai inteira; top = !playtop
    if (/[?&]list=[A-Za-z0-9_-]{10,64}/.test(arg) && !/[?&]v=|youtu\.be\//.test(arg)) djSearch(arg, { tc, now, top });
    else musSend('play', { q: arg, now, tc, top: top === true });
  }
  // ---------- S-0033: comandos como os bots de música do Discord (Rythm, Groovy, FredBoat, Jockie) ----------
  // ! ou / e os apelidos de sempre (!p, !s, !q, !np, !fs, !dc...). Quem muda a música, o DJ conta para todos no chat; o que
  // é só consulta (fila, letra, ajuda, volume) responde "só você vê". Sem moderação: entre amigos, qualquer um pula e mexe.
  const DJ_CMDS = [ // [nome, apelidos, uso, o que faz]
    ['play', ['p', 'tocar'], '<nome ou link>', 'toca ou põe na fila (YouTube, Spotify; playlist entra inteira)'],
    ['playnow', ['pn', 'ps', 'playskip'], '<nome ou link>', 'toca agora, passando na frente'],
    ['playtop', ['pt', 'top'], '<nome ou link>', 'põe como a próxima da fila'],
    ['search', ['busca', 'buscar', 'find'], '<nome>', 'mostra os resultados para escolher'],
    ['skip', ['s', 'next', 'n', 'fs', 'forceskip', 'vs', 'voteskip', 'pular'], '', 'pula a música (sem votação: qualquer um pula)'],
    ['skipto', ['st', 'pularpara'], '<nº>', 'pula direto para a nº da fila'],
    ['back', ['prev', 'previous', 'voltar', 'anterior'], '', 'volta para a anterior'],
    ['replay', ['restart', 'rp', 'recomecar', 'recomeçar'], '', 'recomeça a música'],
    ['pause', ['pausar'], '', 'pausa (de novo: volta a tocar)'],
    ['resume', ['r', 'unpause', 'continuar', 'despausar'], '', 'volta a tocar'],
    ['nowplaying', ['np', 'current', 'tocando', 'agora'], '', 'o que está tocando, com barra e botões'],
    ['queue', ['q', 'fila', 'list', 'lista'], '[página]', 'a fila, 10 por página'],
    ['move', ['m', 'mv', 'mover'], '<de> [para]', 'muda a posição na fila (sem [para]: vira a próxima)'],
    ['remove', ['rm', 'tirar', 'del'], '<nº> ou <nº-nº>', 'tira da fila'],
    ['clear', ['limpar', 'cl'], '', 'limpa a fila (a atual continua)'],
    ['removedupes', ['rmd', 'rd', 'dupes', 'repetidas'], '', 'tira as repetidas da fila'],
    ['shuffle', ['sh', 'embaralhar', 'misturar'], '', 'embaralha a fila'],
    ['loop', ['repeat', 'l', 'repetir'], '[uma|fila|off]', 'repete esta música (sem nada: liga/desliga)'],
    ['loopqueue', ['lq', 'qloop', 'queueloop', 'repetirfila'], '', 'repete a fila inteira (liga/desliga)'],
    ['seek', ['se', 'ir', 'pos'], '<tempo>', 'vai para 1:30, 90, 2m45s, +10 ou -10'],
    ['forward', ['fwd', 'ff', 'avancar', 'avançar'], '[tempo]', 'avança (sem tempo: 10 s)'],
    ['rewind', ['rwd', 'rw', 'retroceder'], '[tempo]', 'volta (sem tempo: 10 s)'],
    ['volume', ['vol', 'v'], '[0-100]', 'o SEU volume da música (cada um tem o seu)'],
    ['lyrics', ['ly', 'letra'], '[nome]', 'letra da música (fonte grátis: LRCLIB)'],
    ['join', ['summon', 'entrar', 'vem'], '', 'chama o Bagre DJ para o seu canal de voz'],
    ['leave', ['dc', 'disconnect', 'stop', 'sair', 'parar'], '', 'para, limpa a fila e tira o DJ do canal'],
    ['autoplay', ['ap', 'radio', 'rádio'], '[on|off]', 'fila acabou: põe uma parecida (mesmo artista)'],
    ['help', ['h', 'commands', 'comandos', 'ajuda', 'dj'], '', 'esta lista'],
  ];
  const DJ_ALIAS = new Map(DJ_CMDS.flatMap(([n, al]) => [n, ...al].map((x) => [x, n])));
  const YT11 = /^[A-Za-z0-9_-]{11}$/;
  function djTime(v) { // '1:30', '90', '2m45s', '1h2m', '1:02:03' -> segundos (null = não entendi)
    const s = String(v || '').trim().toLowerCase().replace(',', '.');
    if (/^\d+(:\d{1,2}){1,2}$/.test(s)) return s.split(':').reduce((a, x) => a * 60 + Number(x), 0);
    if (/^\d+(\.\d+)?\s*s?$/.test(s)) return Math.round(parseFloat(s));
    const m = /^(?:(\d+)\s*h)?\s*(?:(\d+)\s*m(?:in)?)?\s*(?:(\d+)\s*s(?:eg)?)?$/.exec(s);
    return m && (m[1] || m[2] || m[3]) ? (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0) : null;
  }
  function djBtn(icon, label, fn, cls) {
    const b = Object.assign(document.createElement('button'), { type: 'button', className: `icon-btn djc-b ${cls || ''}`.trim(), title: label });
    b.setAttribute('aria-label', label);
    if (icon.startsWith('#')) b.textContent = icon.slice(1);
    else b.innerHTML = `<svg class="ic" aria-hidden="true"><use href="#i-${icon}"/></svg>`;
    b.addEventListener('click', fn);
    return b;
  }
  const p_ = (cls, text) => Object.assign(document.createElement('p'), { className: cls, textContent: text });
  function djCardEl(c) { // cartão do Bagre DJ: 'np' = Tocando agora (ao vivo: barra e botões); 'add' = entrou na fila
    const el = Object.assign(document.createElement('div'), { className: `djc djc-${c.k}` });
    el.dataset.ch = String(c.ch || '');
    el.dataset.key = String(c.key || '');
    const t = String(c.t || 'Vídeo do YouTube').slice(0, 140);
    const img = Object.assign(document.createElement('img'), { className: 'djc-cover', src: thumb(c.id, c.k === 'np'), alt: '', loading: 'lazy' });
    const main = Object.assign(document.createElement('div'), { className: 'djc-main' });
    const title = p_('djc-title', t);
    title.title = t;
    const sub = p_('djc-sub', [c.a && String(c.a).slice(0, 60), c.by && `pedido por ${String(c.by).slice(0, 24)}`].filter(Boolean).join(' · '));
    if (c.k === 'add') {
      const d = Number(c.d) > 0 ? ` · ${mmss(c.d)}` : '';
      main.append(p_('djc-kick', `Na fila · #${Number(c.n) || '?'}`), title, p_('djc-sub', `${sub.textContent}${d}`));
      if (Number.isFinite(c.eta) && c.eta !== null) main.append(p_('djc-eta', c.eta < 5 ? 'Toca logo depois desta' : `Toca em ~${mmss(c.eta)}`));
      el.append(img, main);
      return el;
    }
    const bar = Object.assign(document.createElement('div'), { className: 'djc-bar' });
    bar.append(Object.assign(document.createElement('span'), { className: 'djc-t', textContent: '0:00' }),
      Object.assign(document.createElement('span'), { className: 'djc-track', innerHTML: '<i></i>' }),
      Object.assign(document.createElement('span'), { className: 'djc-d', textContent: Number(c.d) > 0 ? mmss(c.d) : '--:--' }));
    const st = () => dj.st.get(el.dataset.ch);
    const act = (fn) => () => { if (inVoice && myVch === el.dataset.ch) fn(st()); else toast(`Entre em ${chanLabel(el.dataset.ch)} para controlar a música.`); };
    const btns = Object.assign(document.createElement('div'), { className: 'djc-btns' });
    btns.append(
      djBtn('prev', 'Voltar', act(() => musSend('prev'))),
      djBtn('pause', 'Pausar', act((s) => musSend(s && s.paused ? 'resume' : 'pause')), 'djc-play'),
      djBtn('next', 'Pular', act(() => musSend('skip'))),
      djBtn('shuffle', 'Embaralhar a fila', act(() => musSend('shuffle')), 'djc-sh'),
      djBtn('loop', 'Repetir', act((s) => musSend('loop', { mode: { off: 'all', all: 'one', one: 'off' }[s ? s.loop : 'off'] })), 'djc-loop'),
      djBtn('djstop', 'Parar e tirar o DJ do canal', act(() => musSend('leave', { tc: textCh })), 'djc-stop'),
      djBtn('#Letra', 'Letra da música', () => djLyrics('', el.dataset.ch), 'djc-txt djc-any'),
      djBtn('#Fila', 'Ver a fila', () => djEphemeral('', djQueueCard(1, el.dataset.ch)), 'djc-txt djc-any'),
    );
    btns.querySelector('.djc-loop').append(Object.assign(document.createElement('span'), { className: 'dj-one', textContent: '1', hidden: true }));
    main.append(p_('djc-kick', 'Tocando agora'), title, sub, bar, btns, p_('djc-foot', ''));
    el.append(img, main);
    djCardTick(el);
    return el;
  }
  function djCardTick(el) { // o cartão da música que está tocando fica vivo; os de antes viram uma linha 'Tocou'
    const ch = el.dataset.ch, s = dj.st.get(ch), cur = djCur(s);
    const live = !!cur && cur.k === el.dataset.key;
    if (!live) { if (!el.classList.contains('is-past')) { el.classList.remove('is-live', 'is-paused'); el.classList.add('is-past'); el.querySelector('.djc-kick').textContent = 'Tocou'; } return; }
    el.classList.remove('is-past');
    el.classList.add('is-live');
    el.classList.toggle('is-paused', s.paused);
    el.querySelector('.djc-kick').textContent = `${s.paused ? 'Pausado' : 'Tocando agora'} · ${chanLabel(ch)}`;
    const d = cur.d || (dj.tk && dj.tk.id === cur.id ? dj.tk.d : 0);
    const t = Math.min(djPos(s), d || Infinity);
    el.querySelector('.djc-t').textContent = mmss(t);
    el.querySelector('.djc-d').textContent = d ? mmss(d) : '--:--';
    el.querySelector('.djc-track i').style.width = `${d ? Math.min(100, (t / d) * 100) : 0}%`;
    const can = inVoice && myVch === ch;
    const up = s.q.slice(s.i + 1);
    for (const b of el.querySelectorAll('.djc-b:not(.djc-any)')) b.disabled = !can;
    el.querySelector('.djc-sh').disabled = !can || up.length < 2;
    const pb = el.querySelector('.djc-play');
    setIcon(pb.querySelector('use'), s.paused ? 'play' : 'pause');
    pb.setAttribute('aria-label', s.paused ? 'Tocar' : 'Pausar'); pb.title = pb.getAttribute('aria-label');
    const lb = el.querySelector('.djc-loop');
    lb.setAttribute('aria-pressed', String(s.loop !== 'off'));
    lb.title = { off: 'Repetir: desligado', all: 'Repetir: a fila', one: 'Repetir: esta música' }[s.loop];
    lb.querySelector('.dj-one').hidden = s.loop !== 'one';
    el.querySelector('.djc-foot').textContent = (up.length ? `Próxima: ${up[0].t}${up.length > 1 ? ` · +${up.length - 1} na fila` : ''}` : s.auto ? 'Fila vazia · autoplay ligado' : 'Fila vazia · !p <nome> para pedir')
      + (can ? '' : ` · entre em ${chanLabel(ch)} para controlar`);
  }
  function djCardsTick() { for (const el of document.querySelectorAll('#djFeed .djc-np')) djCardTick(el); }
  function djBeat() { // estou num canal de voz com o DJ: aviso o servidor (sem ninguém avisando por 3 min, o DJ sai do canal)
    let key = '';
    for (const [ch, s] of dj.st) if (!djCur(s) && s.stay > srvNow()) key += `${ch},`;
    if (key !== dj.waitKey) { dj.waitKey = key; renderPeople(); } // a espera do DJ no canal acabou (ou começou)
    if (!inVoice || !chatOpen()) return;
    const s = dj.st.get(myVch);
    if (!s || (!djCur(s) && !(s.stay > srvNow()))) return;
    if (dj.beatCh === myVch && Date.now() - dj.beatAt < 20000) return;
    dj.beatCh = myVch; dj.beatAt = Date.now();
    chat.ws.send(JSON.stringify({ t: 'mus', ch: myVch, op: 'here' }));
  }
  function djQueueCard(page, ch) { // !queue: a fila em páginas de 10 (como o !q dos bots), com ◀ ▶
    const box = Object.assign(document.createElement('div'), { className: 'djc djc-q' });
    const draw = (want) => {
      const s = dj.st.get(ch), cur = djCur(s), up = s ? s.q.slice(Math.max(0, s.i + 1)) : [];
      const per = 10, pages = Math.max(1, Math.ceil(up.length / per)), pg = Math.min(Math.max(1, Math.round(want) || 1), pages);
      const left = (cur && cur.d ? Math.max(0, cur.d - djPos(s)) : 0) + up.reduce((a, x) => a + (x.d || 0), 0);
      const main = Object.assign(document.createElement('div'), { className: 'djc-main' });
      main.append(p_('djc-kick', `Fila · ${chanLabel(ch)}`));
      main.append(p_('djc-now', cur ? `${s.paused ? 'Pausado' : 'Tocando'}: ${cur.t} · ${mmss(djPos(s))}${cur.d ? ` de ${mmss(cur.d)}` : ''}${cur.by ? ` · ${cur.by}` : ''}` : 'Nada tocando agora.'));
      const ol = Object.assign(document.createElement('ol'), { className: 'djc-ol', start: (pg - 1) * per + 1 });
      for (const [n, x] of up.slice((pg - 1) * per, pg * per).entries()) {
        const li = document.createElement('li');
        li.append(Object.assign(document.createElement('b'), { textContent: String((pg - 1) * per + n + 1) }),
          Object.assign(document.createElement('span'), { textContent: x.t, title: x.t }),
          Object.assign(document.createElement('i'), { textContent: [x.d ? mmss(x.d) : '', x.by].filter(Boolean).join(' · ') }));
        ol.append(li);
      }
      if (!up.length) ol.append(Object.assign(document.createElement('li'), { className: 'djc-empty', textContent: 'A fila está vazia. Peça com !p <nome ou link>.' }));
      main.append(ol, p_('djc-foot', `${up.length} na fila · ${mmss(left)} até acabar · repetir: ${{ off: 'não', all: 'a fila', one: 'esta música' }[s ? s.loop : 'off']}${s && s.auto ? ' · autoplay' : ''}`));
      if (pages > 1) {
        const nav = Object.assign(document.createElement('div'), { className: 'djc-nav' });
        const prev = djBtn('prev', 'Página anterior', () => draw(pg - 1), 'djc-any');
        const next = djBtn('next', 'Próxima página', () => draw(pg + 1), 'djc-any');
        prev.disabled = pg <= 1; next.disabled = pg >= pages;
        nav.append(prev, Object.assign(document.createElement('span'), { className: 'djc-pg', textContent: `página ${pg} de ${pages}` }), next);
        main.append(nav);
      }
      box.dataset.page = String(pg);
      box.replaceChildren(main);
    };
    draw(page);
    return box;
  }
  function djLyrics(q, ch) { // !lyrics [nome]: a letra vem do servidor (LRCLIB, grátis); sem nome = a que está tocando
    if (!chatOpen()) { toast('O chat está reconectando. Tente de novo em instantes.'); return; }
    dj.ly = (dj.ly || 0) + 1;
    chat.ws.send(JSON.stringify({ t: 'lyr', q: clean(q, 200), ch: ch || myVch || viewVch, n: dj.ly }));
  }
  function djLyricsEl(d) {
    const box = Object.assign(document.createElement('div'), { className: 'djc djc-ly' });
    const main = Object.assign(document.createElement('div'), { className: 'djc-main' });
    main.append(p_('djc-kick', 'Letra'), p_('djc-title', String(d.title || '').slice(0, 120)), p_('djc-sub', String(d.a || '').slice(0, 80)),
      Object.assign(document.createElement('pre'), { className: 'djc-lyr', textContent: String(d.text || '') }), p_('djc-src', `Fonte: ${String(d.src || 'LRCLIB').slice(0, 20)} (letras grátis)`));
    box.append(main);
    return box;
  }
  function djHelpEl() {
    const box = Object.assign(document.createElement('div'), { className: 'djc djc-help' });
    const main = Object.assign(document.createElement('div'), { className: 'djc-main' });
    const dl = Object.assign(document.createElement('dl'), { className: 'djc-cmds' });
    for (const [n, al, use, what] of DJ_CMDS) {
      const dt = document.createElement('dt');
      dt.append(Object.assign(document.createElement('b'), { textContent: `!${n}` }), use ? ` ${use}` : '');
      const dd = document.createElement('dd');
      dd.append(what, al.length ? Object.assign(document.createElement('i'), { textContent: ` · ${al.slice(0, 4).map((x) => `!${x}`).join(' ')}` }) : '');
      dl.append(dt, dd);
    }
    main.append(p_('djc-kick', 'Comandos do Bagre DJ'), p_('djc-sub', 'Com ! ou / (ex.: !p numb, /skip). Os botões do cartão "Tocando agora" fazem o mesmo.'), dl);
    box.append(main);
    return box;
  }
  function djCommand(text) { // devolve true se o texto era um comando do DJ (não vai como mensagem); '!oi' sem comando vira mensagem
    const m = /^[!/]([^\s!/]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
    if (!m) return false;
    const cmd = DJ_ALIAS.get(m[1].toLowerCase());
    if (!cmd) return false;
    dj.cmdAt = Date.now(); // S-0059: o retorno deste comando aparece no painel de música
    const arg = (m[2] || '').trim();
    if (cmd === 'help') { djEphemeral('', djHelpEl()); return true; }
    if (cmd === 'lyrics') { djLyrics(arg); return true; }
    if (!inVoice) { djEphemeral('Entre num canal de voz primeiro: eu toco no canal em que você está.'); return true; }
    const s = dj.st.get(myVch);
    const cur = djCur(s);
    const tc = textCh;
    const up = s ? s.q.slice(Math.max(0, s.i + 1)) : [];
    const base = s ? Math.max(0, s.i + 1) : 0;
    const need = () => { if (!cur) djEphemeral('Nada tocando agora. Peça com !p <nome ou link>.'); return !cur; };
    const num = (v) => { const n = Number(v); return Number.isInteger(n) && n >= 1 && n <= up.length ? n : 0; };
    const range = `de 1 a ${up.length || 1}`;
    switch (cmd) {
      case 'play': case 'playnow': case 'playtop':
        if (!arg) { if (cur && s.paused) musSend('resume', { tc }); else djEphemeral(`Use !${cmd === 'play' ? 'p' : cmd} <nome da música ou link do YouTube ou Spotify>.`); break; }
        djPlay(arg, cmd === 'playnow', tc, cmd === 'playtop');
        break;
      case 'search':
        if (!arg) { djEphemeral('Use !search <nome da música>.'); break; }
        dj.pref = 'open'; renderDj(); djSearch(arg);
        djEphemeral(`Resultados de “${arg.slice(0, 60)}” no painel do Bagre DJ: toque para tocar ou pôr na fila.`);
        break;
      case 'skip': if (!need()) musSend('skip', { tc }); break;
      case 'skipto': { const n = num(arg); if (!n) djEphemeral(`Use !skipto <nº da fila, ${range}>.`); else musSend('jump', { k: up[n - 1].k, tc }); break; }
      case 'back': musSend('prev', { tc }); break;
      case 'replay': if (!need()) musSend('seek', { pos: 0, tc }); break;
      case 'pause': if (!need()) musSend(s.paused ? 'resume' : 'pause', { tc }); break;
      case 'resume': if (!need()) { if (s.paused) musSend('resume', { tc }); else djEphemeral('Já está tocando.'); } break;
      case 'nowplaying': if (!need()) djEphemeral('', djCardEl({ k: 'np', ch: myVch, key: cur.k, id: cur.id, t: cur.t, a: cur.a, d: cur.d, by: cur.by })); break;
      case 'queue': djEphemeral('', djQueueCard(Number(arg) || 1, myVch)); break;
      case 'move': {
        const ns = (arg.match(/\d+/g) || []).map(Number);
        const from = num(ns[0]), to = ns.length > 1 ? Math.min(Math.max(1, ns[1]), up.length) : 1;
        if (!from) djEphemeral(`Use !move <de> [para], ${range}. Ex.: !move 5 1`);
        else if (from === to) djEphemeral('Essa música já está nessa posição.');
        else musSend('mv', { k: up[from - 1].k, to: base + to - 1, tc });
        break;
      }
      case 'remove': {
        const r = /^(\d+)\s*-\s*(\d+)$/.exec(arg);
        if (r) {
          const a = num(r[1]), b = num(r[2]);
          if (!a || !b || b < a) djEphemeral(`Use !remove <nº>-<nº>, ${range}.`); else musSend('rm', { ks: up.slice(a - 1, b).map((x) => x.k), tc });
        } else if (/^(last|ultima|última)$/i.test(arg) && up.length) musSend('rm', { k: up[up.length - 1].k, tc });
        else { const n = num(arg); if (!n) djEphemeral(`Use !remove <nº da fila, ${range}> (ou 2-5).`); else musSend('rm', { k: up[n - 1].k, tc }); }
        break;
      }
      case 'clear': musSend('clear', { tc }); break;
      case 'removedupes': musSend('dedupe', { tc }); break;
      case 'shuffle': if (up.length < 2) djEphemeral('Precisa de 2 músicas na fila para embaralhar.'); else musSend('shuffle', { tc }); break;
      case 'loop': {
        const a = arg.toLowerCase();
        const mode = /^(fila|all|queue|tudo|q)$/.test(a) ? 'all' : /^(uma|one|musica|música|track|song|esta|1|on)$/.test(a) ? 'one' : /^(off|nao|não|desligar|desliga|0|none)$/.test(a) ? 'off' : s && s.loop === 'one' ? 'off' : 'one';
        musSend('loop', { mode, tc });
        break;
      }
      case 'loopqueue': musSend('loop', { mode: s && s.loop === 'all' ? 'off' : 'all', tc }); break;
      case 'seek': case 'forward': case 'rewind': {
        if (need()) break;
        const sign = cmd === 'forward' ? '+' : cmd === 'rewind' ? '-' : /^[+-]/.test(arg) ? arg[0] : '';
        const n = arg ? djTime(arg.replace(/^[+-]/, '')) : cmd === 'seek' ? null : 10;
        if (n === null) { djEphemeral('Use !seek <tempo>: 1:30, 90, 2m45s, +10 ou -10.'); break; }
        const at = djPos(s), pos = sign === '+' ? at + n : sign === '-' ? at - n : n;
        if (cur.d && pos >= cur.d) { djEphemeral(`Essa música tem ${mmss(cur.d)}. Para pular, use !skip.`); break; }
        musSend('seek', { pos: Math.max(0, pos), tc });
        break;
      }
      case 'volume': {
        if (!arg) { djEphemeral(`Seu volume do Bagre DJ: ${dj.mute ? 'mudo' : `${dj.vol}%`}. Use !volume <0 a 100> (muda só para você).`); break; }
        const v = Number(arg.replace('%', ''));
        if (!Number.isFinite(v) || v < 0 || v > 100) { djEphemeral('Use !volume <0 a 100>.'); break; }
        dj.vol = Math.round(v); store('djvol', String(dj.vol));
        if (dj.vol > 0 && dj.mute) { dj.mute = false; store('djmute', '0'); }
        djVolume(); renderDj();
        djEphemeral(`Seu volume do Bagre DJ: ${dj.vol}% (só para você: cada um tem o seu, como no Discord).`);
        break;
      }
      case 'join': musSend('join', { tc }); break;
      case 'leave': musSend('leave', { tc }); break;
      case 'autoplay': {
        const a = arg.toLowerCase();
        musSend('auto', { on: /^(on|ligar|liga|sim|1)$/.test(a) ? true : /^(off|desligar|desliga|nao|não|0)$/.test(a) ? false : !(s && s.auto), tc });
        break;
      }
      default: return false;
    }
    return true;
  }
  // sugestões ao digitar ! ou / no chat (como a lista de comandos do Discord): toque completa o comando
  const djSug = Object.assign(document.createElement('ul'), { id: 'djSug', className: 'dj-sug', hidden: true });
  djSug.setAttribute('aria-label', 'Comandos do Bagre DJ');
  $('chatForm').append(djSug);
  function djSugRender() {
    const m = /^([!/])(\S*)$/.exec($('chatInput').value);
    const w = m ? m[2].toLowerCase() : '';
    const list = m ? DJ_CMDS.filter(([n, al]) => [n, ...al].some((x) => x.startsWith(w))).slice(0, 8) : [];
    djSug.hidden = !list.length;
    if (!list.length) return;
    djSug.replaceChildren(...list.map(([n, al, use, what]) => {
      const li = document.createElement('li');
      const b = Object.assign(document.createElement('button'), { type: 'button' });
      b.append(Object.assign(document.createElement('b'), { textContent: `${m[1]}${n}` }), Object.assign(document.createElement('i'), { textContent: use }),
        Object.assign(document.createElement('span'), { textContent: `${what}${al.length ? ` · ${al.slice(0, 3).map((x) => m[1] + x).join(' ')}` : ''}` }));
      b.addEventListener('pointerdown', (ev) => ev.preventDefault()); // o campo não perde o foco
      b.addEventListener('click', () => { $('chatInput').value = `${m[1]}${n}${use ? ' ' : ''}`; djSug.hidden = true; $('chatInput').focus(); });
      li.append(b);
      return li;
    }));
  }
  $('chatInput').addEventListener('input', djSugRender);
  $('chatInput').addEventListener('blur', () => setTimeout(() => { djSug.hidden = true; }, 150));
  $('chatInput').addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && !djSug.hidden) { djSug.hidden = true; ev.stopPropagation(); } if (ev.key === 'Enter') djSug.hidden = true; });
  // eventos do painel
  $('djBtn').addEventListener('click', () => {
    dj.pref = $('dj').hidden ? 'open' : 'closed';
    renderDj();
    if (!$('dj').hidden && !djCur(dj.st.get(viewVch))) $('djQ').focus();
  });
  $('djClose').addEventListener('click', () => { dj.pref = 'closed'; renderDj(); });
  $('djForm').addEventListener('submit', (ev) => { // Enter = toca já (como o /play); "Lista" mostra os resultados para escolher
    ev.preventDefault();
    const q = clean($('djQ').value, 300);
    if (!q) return;
    if (!djHere()) { toast('Entre neste canal de voz para pedir música.'); return; }
    if (ev.submitter && ev.submitter.id === 'djList') { djSearch(q); return; }
    djPlay(q, false);
    $('djQ').value = '';
    toast(`Procurando: ${q.slice(0, 60)}`);
  });
  $('djResX').addEventListener('click', closeDjRes);
  $('djPlay').addEventListener('click', () => { const s = dj.st.get(myVch); if (djCur(s)) musSend(s.paused ? 'resume' : 'pause'); });
  $('djNext').addEventListener('click', () => musSend('skip'));
  $('djPrev').addEventListener('click', () => musSend('prev'));
  $('djStop').addEventListener('click', () => musSend('stop'));
  $('djShuffle').addEventListener('click', () => musSend('shuffle'));
  $('djLoop').addEventListener('click', () => { const s = dj.st.get(myVch); musSend('loop', { mode: { off: 'all', all: 'one', one: 'off' }[s ? s.loop : 'off'] }); });
  $('djSeek').addEventListener('change', () => { musSend('seek', { pos: Number($('djSeek').value) }); $('djSeek').blur(); });
  $('djVol').addEventListener('input', () => { dj.vol = Number($('djVol').value); store('djvol', String(dj.vol)); if (dj.vol > 0 && dj.mute) { dj.mute = false; store('djmute', '0'); } djVolume(); renderDj(); });
  $('djMute').addEventListener('click', () => { dj.mute = !dj.mute; store('djmute', dj.mute ? '1' : '0'); djVolume(); renderDj(); });
  $('djTap').addEventListener('click', () => { dj.loaded = ''; dj.blocked = false; djSync(); djCmd({ op: 'play' }); });

  // ---------- manutenção periódica ----------
  setInterval(() => {
    if (!room || leaving) return;
    const now = Date.now();
    for (const e of [...peers.values()]) {
      if (!e.ready) { if (now - e.born > 15000) dropPeer(e.id, true); continue; }
      if (now - e.seen > 20000) { dropPeer(e.id); continue; } // aba fechada sem avisar
      send(e, { t: 'ping' });
      // diz que transmite mas a imagem não chegou (ou caiu): pede de novo
      if (withMe(e) && e.sharing && !e.stopped && !e.call && now - e.wanted > 8000) { e.wanted = now; send(e, { t: 'want' }); }
      // voz que não fechou (ou caiu): quem oferece tenta de novo
      if (withMe(e) && myId > e.id && (!e.vpc || e.vpc.connectionState !== 'connected') && now - e.vAt > 15000) voiceStart(e);
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
    const busy = local || (inVoice && peers.size);
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
    sendMe();
  }
  function myFace() { // meu avatar; com a janela de boas-vindas aberta vale o nome que está sendo digitado
    const name = $('nameDlg').open ? clean($('homeName').value) || '?' : myName;
    for (const el of document.querySelectorAll('.js-avatar')) paintAvatar(el, name, myAv);
  }
  // Galeria de avatares: a primeira opção é a inicial do nome (padrão)
  function renderGallery() {
    const grid = $('avatarGrid');
    grid.textContent = '';
    for (const av of ['', ...AVATARS]) {
      const label = av ? $('av-' + av).dataset.n || av.replace('-', ' ') : 'inicial do nome';
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'avatar';
      b.setAttribute('aria-pressed', String(av === myAv));
      b.setAttribute('aria-label', av ? `Avatar ${label}` : 'Inicial do nome');
      b.title = label;
      paintAvatar(b, $('nameDlg').open ? clean($('homeName').value) || '?' : myName, av);
      b.addEventListener('click', () => {
        myAv = av;
        store('avatar', av);
        sendMe();
        $('avatarDlg').close();
        if (local) local.tile.setName();
        broadcast(hello());
        renderPeople();
        sfx('ok');
      });
      grid.append(b);
    }
  }
  // ---- Enviar imagem (S-1397): escolhe, enquadra (círculo + zoom) e salva. GIF vai inteiro (animado); o resto vira 256×256.
  const crop = { img: null, file: null, gif: false, z: 1, x: 0, y: 0 };
  const CV = 220; // lado da área de recorte na tela
  const cropBase = () => Math.max(CV / crop.img.width, CV / crop.img.height);
  function cropDraw() {
    const g = $('cropCv').getContext('2d'), im = crop.img;
    g.clearRect(0, 0, CV, CV);
    if (!im) return;
    const k = cropBase() * crop.z, w = im.width * k, h = im.height * k;
    crop.x = Math.min(0, Math.max(CV - w, crop.x)); // a imagem sempre cobre o quadrado
    crop.y = Math.min(0, Math.max(CV - h, crop.y));
    g.drawImage(im, crop.x, crop.y, w, h);
  }
  function cropOpen(file) {
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)) { toast('Use PNG, JPG, WEBP ou GIF.'); return; }
    if (file.size > 5 * 1024 * 1024) { toast('A imagem passa de 5 MB.'); return; }
    const url = URL.createObjectURL(file);
    const im = new Image();
    im.onload = () => {
      Object.assign(crop, { img: im, file, gif: file.type === 'image/gif', z: 1 });
      $('cropZoom').value = '1';
      $('cropZoom').disabled = crop.gif;
      $('cropHint').textContent = crop.gif ? 'GIF animado: vai inteiro, centralizado no círculo.' : 'Arraste para enquadrar e use o zoom.';
      $('cropCv').hidden = crop.gif;
      $('cropGif').hidden = !crop.gif;
      if (crop.gif) $('cropGif').src = url;
      crop.x = (CV - im.width * cropBase()) / 2; crop.y = (CV - im.height * cropBase()) / 2;
      cropDraw();
      $('cropBox').hidden = false;
    };
    im.onerror = () => toast('Não consegui abrir essa imagem.');
    im.src = url;
  }
  $('avUp').addEventListener('click', () => $('avFile').click());
  $('avFile').addEventListener('change', () => { const f = $('avFile').files[0]; $('avFile').value = ''; if (f) cropOpen(f); });
  $('cropZoom').addEventListener('input', () => { // zoom em torno do centro
    const b = cropBase(), k0 = b * crop.z, k1 = b * Number($('cropZoom').value);
    crop.x = CV / 2 - ((CV / 2 - crop.x) / k0) * k1; crop.y = CV / 2 - ((CV / 2 - crop.y) / k0) * k1;
    crop.z = Number($('cropZoom').value); cropDraw();
  });
  let drag = null;
  $('cropCv').addEventListener('pointerdown', (ev) => { drag = { x: ev.clientX - crop.x, y: ev.clientY - crop.y }; $('cropCv').setPointerCapture(ev.pointerId); });
  $('cropCv').addEventListener('pointermove', (ev) => { if (drag) { crop.x = ev.clientX - drag.x; crop.y = ev.clientY - drag.y; cropDraw(); } });
  $('cropCv').addEventListener('pointerup', () => { drag = null; });
  $('cropNo').addEventListener('click', () => { $('cropBox').hidden = true; crop.img = null; });
  $('cropOk').addEventListener('click', async () => {
    $('cropOk').disabled = true;
    try {
      let blob = crop.file;
      if (!crop.gif) {
        const out = document.createElement('canvas');
        out.width = out.height = 256;
        out.getContext('2d').drawImage($('cropCv'), 0, 0, 256, 256);
        blob = await new Promise((r) => out.toBlob(r, 'image/png'));
      }
      const r = await upload({ file: blob }, document.createElement('i'), '/up?av=1');
      if (!r) return;
      myAv = `u-${r.id}`;
      store('avatar', myAv);
      sendMe();
      $('cropBox').hidden = true;
      $('avatarDlg').close();
      if (local) local.tile.setName();
      broadcast(hello());
      myFace();
      renderPeople();
      sfx('ok');
    } finally { $('cropOk').disabled = false; }
  });
  for (const b of document.querySelectorAll('.js-avatar')) {
    b.addEventListener('click', () => { renderGallery(); $('cropBox').hidden = true; $('avatarDlg').showModal(); });
  }
  $('homeName').addEventListener('input', myFace);
  $('nameForm').addEventListener('submit', (ev) => { // primeira vez: nome e avatar
    ev.preventDefault();
    const v = clean($('homeName').value);
    if (!v) { $('homeName').focus(); return; }
    setName(v);
    $('nameDlg').close();
    joinMesh();
    sendMe();
    broadcast(hello());
    renderPeople();
    renderChat(false); // minhas mensagens antigas (pelo nome) ganham o destaque
    sfx('start');
  });
  $('nameDlg').addEventListener('cancel', (ev) => ev.preventDefault()); // Esc não pula o nome
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
  const POPS = { settings: 'settingsBtn', voicePop: 'voiceBtn', statusPop: 'statusBtn' }; // painel -> botão que abre
  $('channels').addEventListener('click', (ev) => {
    const add = ev.target.closest('.chan-add');
    if (add) { openChanDlg(null, add.dataset.kind); return; }
    const gear = ev.target.closest('.chan-gear');
    if (gear) { openChanDlg(gear.dataset.ch); return; }
    const b = ev.target.closest('.chan[data-ch]');
    const c = b && chanOf(b.dataset.ch);
    if (!c) return;
    if (c.kind === 'text') { openText(c.id); $('chatInput').focus(); } else joinVoice(c.id);
  });
  $('channels').addEventListener('contextmenu', (ev) => {
    const b = ev.target.closest('.chan[data-ch]');
    if (!b) return;
    ev.preventDefault();
    openChanDlg(b.dataset.ch);
  });
  $('chanKinds').addEventListener('change', chanIcon);
  $('chanName').addEventListener('input', () => { // canal de texto: minúsculo e com hífen no lugar do espaço, como no Discord
    const f = $('chanName');
    if (chanKind() !== 'text') return;
    const v = f.value.toLowerCase().replace(/\s/g, '-');
    if (v !== f.value) { const at = f.selectionStart; f.value = v; f.setSelectionRange(at, at); }
  });
  $('chanForm').addEventListener('submit', (ev) => {
    ev.preventDefault();
    if (!clean($('chanName').value, 32)) { $('chanName').focus(); return; }
    if (chanSend(chanEdit ? 'ren' : 'add')) $('chanDlg').close();
  });
  $('chanDel').addEventListener('click', () => {
    if (!delArmed) { delArmed = true; $('chanDel').textContent = 'Confirmar: apagar com as mensagens'; return; }
    if (chanSend('del')) $('chanDlg').close();
  });
  $('joinVoiceBtn').addEventListener('click', () => joinVoice());
  $('vconnGo').addEventListener('click', () => { viewVch = myVch || viewVch; setView('voice'); renderPeople(); });
  for (const id of ['leaveBtn', 'vconnLeave']) $(id).addEventListener('click', leaveVoice);
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
  const micClick = () => { if (voice.track || !inVoice) setMuted(!voice.muted); else openMic(true); };
  $('micBtn').addEventListener('click', micClick);
  $('sideMic').addEventListener('click', micClick);
  $('sideDeaf').addEventListener('click', () => setDeaf(!voice.deaf));
  $('micFixBtn').addEventListener('click', () => openMic(true));
  $('deafBtn').addEventListener('click', () => setDeaf(!voice.deaf));
  $('micSelect').addEventListener('change', () => { voice.mic = $('micSelect').value; store('vmic', voice.mic); openMic(true); });
  $('outSelect').addEventListener('change', () => {
    voice.out = $('outSelect').value; store('vout', voice.out);
    for (const e of peers.values()) { sink(e.audio); if (e.tile) sink(e.tile.video); }
    if (boostAc && boostAc.setSinkId) boostAc.setSinkId(voice.out).catch(() => {});
    sink(testAudio);
  });
  $('micTestBtn').addEventListener('click', () => micTest(!voice.testing));
  for (const b of $('statusPop').querySelectorAll('.st-opt')) {
    b.addEventListener('click', () => {
      stPick = b.dataset.st;
      store('status', stPick);
      togglePop('statusPop', false);
      renderStatus(); sendMe(); renderPeople(); refreshDots();
      $('statusBtn').focus();
    });
  }
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
  let pickingKey = false; // 'ptt' | 'mute' enquanto escolhe a tecla
  $('pttKeyBtn').addEventListener('click', () => { pickingKey = 'ptt'; renderVoice(); });
  function pickKey(code) {
    if (code !== 'Escape') {
      if (pickingKey === 'mute') { voice.muteKey = code === 'Backspace' ? '' : code; store('vmutekey', voice.muteKey); }
      else { voice.key = code; store('vkey', code); }
    }
    pickingKey = false;
    renderVoice();
  }
  const typing = (el) => !!(el && el.closest && el.closest('input:not([type="range"]):not([type="checkbox"]), textarea, select, [contenteditable]'));
  document.addEventListener('keydown', (ev) => {
    if (pickingKey) { // escolhendo a tecla do push-to-talk ou de mutar (Esc cancela)
      ev.preventDefault(); ev.stopPropagation();
      pickKey(ev.code);
    } else if (DESK) { // no app quem cuida da tecla é o gancho global (evento 'ptt'), com ou sem foco
    } else if (inVoice && voice.mode === 'ptt' && ev.code === voice.key && !typing(ev.target)) {
      ev.preventDefault(); // Espaço como tecla não aciona o botão em foco
      voice.keyDown = true;
    }
  }, true);
  if (!DESK) {
    document.addEventListener('keyup', (ev) => { if (ev.code === voice.key) voice.keyDown = false; }, true);
    window.addEventListener('blur', () => { voice.keyDown = false; }); // o navegador só entrega teclas com a guia em foco
  }
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
  $('qRes').addEventListener('click', (ev) => { const b = ev.target.closest('[data-v]'); if (b) { qRes = b.dataset.v; applyQuality(); } });
  $('qFps').addEventListener('click', (ev) => { const b = ev.target.closest('[data-v]'); if (b) { qFps = Number(b.dataset.v); applyQuality(); } });
  $('hint').addEventListener('change', applyQuality);
  $('panelBtn').addEventListener('click', () => {
    togglePanel($('panel').hidden || $('panel').dataset.lado !== 'dir', 'dir');
    if (!$('panel').hidden) $('panelClose').focus();
  });
  $('chanBtn').addEventListener('click', () => {
    togglePanel($('panel').hidden || $('panel').dataset.lado === 'dir', 'esq');
    if (!$('panel').hidden) $('panelClose').focus();
  });
  $('panelScrim').addEventListener('click', () => togglePanel(false));
  (() => { // S-0069 E1: arrastar o dedo como no Discord. Fechado: para a direita abre os canais, para a esquerda abre o online. Aberto: arrastar de volta fecha.
    const panel = $('panel'), scrim = $('panelScrim');
    let g = null;
    const rolaDeLado = (n) => { for (; n && n !== document.body; n = n.parentElement) { const ox = getComputedStyle(n).overflowX; if ((ox === 'auto' || ox === 'scroll') && n.scrollWidth > n.clientWidth + 2) return true; } return false; };
    const livre = (t) => !t.closest('input, textarea, select, video, .tile, dialog, .pop, .msg-media, [data-noswipe]') && !rolaDeLado(t);
    document.addEventListener('touchstart', (ev) => {
      g = null;
      if (!narrow() || ev.touches.length !== 1 || document.fullscreenElement || document.querySelector('dialog[open]') || $('room').dataset.focus !== undefined || $('room').hidden) return;
      const aberto = !panel.hidden;
      if (aberto ? !ev.target.closest('#panel, #panelScrim') || ev.target.closest('input, textarea') : !livre(ev.target)) return;
      const t = ev.touches[0];
      g = { x: t.clientX, y: t.clientY, aberto, lado: aberto ? panel.dataset.lado : '', on: false, d: 0, w: 0, t: Date.now() };
    }, { passive: true });
    // posição da gaveta pelo quanto o dedo andou desde o toque (o Android manda poucos movimentos num arrasto rápido)
    const mover = (x) => {
      const w = g.w, e = g.lado === 'esq', d = x - g.x;
      g.d = Math.max(0, Math.min(w, (e !== g.aberto) ? d : -d)); // quanto andou no sentido do gesto (abrir ou fechar)
      const aberta = g.aberto ? w - g.d : g.d; // quanto da gaveta aparece
      panel.style.transform = `translateX(${e ? aberta - w : w - aberta}px)`;
      scrim.style.opacity = String(aberta / w);
    };
    document.addEventListener('touchmove', (ev) => {
      if (!g) return;
      const t = ev.touches[0], dx = t.clientX - g.x, dy = t.clientY - g.y;
      if (!g.on) {
        if (Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx)) { g = null; return; } // é rolagem
        if (Math.abs(dx) < 16 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
        if (g.aberto && (g.lado === 'dir') !== (dx > 0)) { g = null; return; } // aberto: só o arrasto que fecha
        if (!g.aberto) { g.lado = dx > 0 ? 'esq' : 'dir'; togglePanel(true, g.lado); }
        g.on = true; g.w = panel.getBoundingClientRect().width || 1;
        panel.classList.add('arrastando');
      }
      if (ev.cancelable) ev.preventDefault();
      mover(t.clientX);
    }, { passive: false });
    const solta = (ev) => {
      if (!g || !g.on) { g = null; return; }
      const fimT = ev && ev.changedTouches && ev.changedTouches[0];
      if (fimT) mover(fimT.clientX);
      const { w, d, lado, aberto } = g, e = lado === 'esq';
      const vai = d > w * 0.35 || (Date.now() - g.t < 300 && d > 40); // passou de 1/3 ou foi um puxão rápido
      const abre = aberto ? !vai : vai;
      g = null;
      panel.classList.remove('arrastando');
      panel.style.transition = 'transform .16s ease-out';
      panel.style.transform = abre ? 'translateX(0)' : `translateX(${e ? -w : w}px)`;
      scrim.style.opacity = abre ? '' : '0';
      setTimeout(() => { panel.style.transition = ''; if (abre) { panel.style.transform = ''; scrim.style.opacity = ''; } else togglePanel(false); }, 170);
    };
    document.addEventListener('touchend', solta, { passive: true });
    document.addEventListener('touchcancel', solta, { passive: true });
  })();
  $('panelClose').addEventListener('click', () => { togglePanel(false); $('panelBtn').focus(); });
  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape' || document.fullscreenElement || document.querySelector('dialog[open]')) return;
    if (!$('settings').hidden) { toggleSettings(false); $('settingsBtn').focus(); }
    else if (!$('voicePop').hidden) { togglePop('voicePop', false); $('voiceBtn').focus(); }
    else if (!$('statusPop').hidden) { togglePop('statusPop', false); $('statusBtn').focus(); }
    else if (!$('msgMenu').hidden || !$('reactPop').hidden || !$('userMenu').hidden) closeMenus();
    else if (replyTo !== null) cancelReply();
    else if (focusOn()) { setFocus(''); $('focusBtn').focus(); }
    else if (!$('panel').hidden && narrow()) { togglePanel(false); $('panelBtn').focus(); }
  });
  if (MOB) { // Android: botão voltar fecha o que estiver aberto (igual ao Esc); notificação da voz sai da voz / para a tela
    MOB.hooks.leave = () => leaveVoice();
    MOB.hooks.stopShare = () => stopShare();
    MOB.hooks.back = () => {
      if (document.fullscreenElement) { document.exitFullscreen().catch(() => {}); return true; }
      if (!$('settings').hidden) { toggleSettings(false); return true; }
      if (!$('voicePop').hidden) { togglePop('voicePop', false); return true; }
      if (!$('statusPop').hidden) { togglePop('statusPop', false); return true; }
      if (!$('msgMenu').hidden || !$('reactPop').hidden || !$('userMenu').hidden) { closeMenus(); return true; }
      if (replyTo !== null) { cancelReply(); return true; }
      if (focusOn()) { setFocus(''); return true; }
      if (!$('panel').hidden && narrow()) { togglePanel(false); return true; }
      return false;
    };
  }
  $('focusBtn').addEventListener('click', toggleFocus);
  $('focusTop').addEventListener('click', toggleFocus);
  $('chatTop').addEventListener('click', toggleChat);
  $('focusScreen').addEventListener('click', () => setFocus('screen'));
  $('focusPeople').addEventListener('click', () => setFocus('people'));
  $('focusExit').addEventListener('click', () => { setFocus(''); $('focusBtn').focus(); });
  document.addEventListener('keydown', (ev) => { // F liga/desliga o modo foco (fora de campo de texto, no canal de voz)
    if (ev.code !== 'KeyF' || ev.repeat || ev.ctrlKey || ev.altKey || ev.metaKey || ev.shiftKey || pickingKey || typing(ev.target)) return;
    if (!inVoice || $('room').dataset.view !== 'voice' || document.querySelector('dialog[open]')) return;
    if ((voice.mode === 'ptt' && voice.key === 'KeyF') || voice.muteKey === 'KeyF') return; // F já é a tecla de falar/mutar
    ev.preventDefault();
    const over = document.fullscreenElement || $('stage').querySelector('.tile:hover'); // mouse em cima de uma tela: F = tela cheia dela
    if (over && over.classList.contains('tile')) toggleFull(over); else toggleFocus();
  });
  document.addEventListener('keydown', (ev) => { // C retrai/mostra só o chat da direita (no canal de voz, tela larga)
    if (ev.code !== 'KeyC' || ev.repeat || ev.ctrlKey || ev.altKey || ev.metaKey || ev.shiftKey || pickingKey || typing(ev.target)) return;
    if ($('room').dataset.view !== 'voice' || focusOn() || !wideChat() || document.querySelector('dialog[open]')) return;
    if ((voice.mode === 'ptt' && voice.key === 'KeyC') || voice.muteKey === 'KeyC') return; // C já é a tecla de falar/mutar
    ev.preventDefault();
    toggleChat();
  });
  window.matchMedia('(min-width: 1200px)').addEventListener('change', () => { if (chatSeen()) readAll(); });
  window.matchMedia('(max-width: 960px)').addEventListener('change', () => togglePanel(!narrow())); // janela cresceu: a lateral volta fixa
  document.addEventListener('visibilitychange', () => { if (chatSeen()) readAll(); });
  $('nameInput').addEventListener('change', () => {
    setName($('nameInput').value);
    if (local) local.tile.setName();
    broadcast(hello());
    renderPeople();
  });
  $('chatForm').addEventListener('submit', (ev) => { ev.preventDefault(); chatSend(); });
  $('fileBtn').addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', () => { addFiles([...$('fileInput').files]); $('fileInput').value = ''; });
  $('chatInput').addEventListener('paste', (ev) => {
    const files = [...(ev.clipboardData ? ev.clipboardData.files : [])];
    if (files.length) { ev.preventDefault(); addFiles(files); }
  });
  let drags = 0; // arrastar arquivo para cima do chat
  const hasFiles = (ev) => !!ev.dataTransfer && [...ev.dataTransfer.types].includes('Files');
  $('chat').addEventListener('dragenter', (ev) => { if (!hasFiles(ev)) return; ev.preventDefault(); drags++; $('chat').classList.add('dragging'); });
  $('chat').addEventListener('dragover', (ev) => { if (hasFiles(ev)) ev.preventDefault(); });
  $('chat').addEventListener('dragleave', () => { if (--drags <= 0) { drags = 0; $('chat').classList.remove('dragging'); } });
  $('chat').addEventListener('drop', (ev) => {
    if (!hasFiles(ev)) return;
    ev.preventDefault();
    drags = 0; $('chat').classList.remove('dragging');
    addFiles([...ev.dataTransfer.files]);
  });
  $('moreBtn').addEventListener('click', () => { if (chatOpen() && chat.list.length) chat.ws.send(JSON.stringify({ t: 'more', before: chat.list[0].id, ch: textCh })); });
  $('chatScroll').addEventListener('scroll', () => { if (chatSeen() && atBottom()) readAll(); });
  // ações na mensagem: barra no hover (mouse), menu no botão direito e no toque longo (celular)
  const hoverable = window.matchMedia('(hover: hover)');
  $('chatLog').addEventListener('mouseover', (ev) => {
    const li = hoverable.matches && ev.target.closest('.msg[data-id]');
    if (li && Number(li.dataset.id) !== toolsFor) showTools(li);
  });
  $('chatLog').addEventListener('focusin', (ev) => { const li = ev.target.closest('.msg[data-id]'); if (li && Number(li.dataset.id) !== toolsFor) showTools(li); });
  $('chatScroll').addEventListener('mouseleave', () => { if ($('reactPop').hidden) parkTools(); });
  $('msgTools').addEventListener('click', (ev) => { const b = ev.target.closest('[data-act]'); if (b && toolsFor !== null) act(b.dataset.act, toolsFor, ev, b); });
  $('msgMenu').addEventListener('click', (ev) => { const b = ev.target.closest('[data-act]'); if (b) act(b.dataset.act, Number($('msgMenu').dataset.id), ev, b); });
  $('chatLog').addEventListener('contextmenu', (ev) => {
    const li = ev.target.closest('.msg[data-id]');
    if (!li || ev.target.closest('a, img, video, input') || li.classList.contains('editing')) return; // link e mídia: menu do navegador
    ev.preventDefault();
    openMenu(Number(li.dataset.id), ev.clientX, ev.clientY);
  });
  let press = null; // toque longo
  $('chatLog').addEventListener('pointerdown', (ev) => {
    const li = ev.pointerType === 'touch' && ev.target.closest('.msg[data-id]');
    if (!li || li.classList.contains('editing')) return;
    press = { x: ev.clientX, y: ev.clientY, timer: setTimeout(() => { press.fired = true; openMenu(Number(li.dataset.id), press.x, press.y); }, 450) };
  });
  const unpress = () => { if (press) clearTimeout(press.timer); };
  $('chatLog').addEventListener('pointermove', (ev) => { if (press && Math.hypot(ev.clientX - press.x, ev.clientY - press.y) > 10) { unpress(); press = null; } });
  for (const t of ['pointerup', 'pointercancel']) $('chatLog').addEventListener(t, unpress);
  $('chatLog').addEventListener('click', (ev) => { if (press && press.fired) { ev.preventDefault(); ev.stopPropagation(); } press = null; }, true); // o toque longo não abre a imagem
  $('chatScroll').addEventListener('scroll', () => { if (!$('msgMenu').hidden && !narrow()) closeMenus(); }, { passive: true });
  document.addEventListener('pointerdown', (ev) => {
    if (!ev.target.closest('#msgMenu, #reactPop, #msgTools, #userMenu')) closeMenus();
  });
  $('replyX').addEventListener('click', () => { cancelReply(); $('chatInput').focus(); });
  // volume por pessoa: botão direito, toque longo, clique (ou Enter) em quem está num canal de voz da lateral
  $('umV').addEventListener('input', () => { if (menuFor) setPref(menuFor, { v: Number($('umV').value), m: false }); });
  $('umS').addEventListener('input', () => { if (menuFor) { menuFor.muted = false; setPref(menuFor, { s: Number($('umS').value), m: false }); } });
  $('umMute').addEventListener('change', () => { if (menuFor) setPref(menuFor, { m: $('umMute').checked }); });
  $('umReset').addEventListener('click', () => { if (menuFor) setPref(menuFor, { v: 1, s: 1, m: false }); });
  document.addEventListener('contextmenu', (ev) => {
    if (ev.target.closest('#chatLog, input, a')) return;
    const e = personAt(ev.target);
    if (!e) return;
    ev.preventDefault();
    openUserMenu(e, ev.clientX, ev.clientY);
  });
  const fromMembers = (ev) => { const li = ev.target.closest('.people:not(.people-voice) li[data-id]'); if (li && !ev.target.closest('button, input, a')) openProfile(uidOfEl(li)); };
  $('panel').addEventListener('click', fromMembers);
  $('panel').addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && ev.target.matches('.people:not(.people-voice) li[data-id]')) { ev.preventDefault(); fromMembers(ev); } });
  $('chatLog').addEventListener('click', (ev) => {
    const t = ev.target.closest('.msg .avatar, .msg .msg-name');
    const m = t && msgById(Number(t.closest('.msg').dataset.id));
    if (m) openProfile(m.uid);
  });
  const fromList = (ev) => {
    if (ev.target.closest('button, input, a')) return;
    const li = ev.target.closest('.people-voice li[data-id]');
    if (li) openProfile(uidOfEl(li));
  };
  $('panel').addEventListener('click', (ev) => { if (!upress || !upress.fired) fromList(ev); });
  $('panel').addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && ev.target.matches('.people-voice li[data-id]')) { ev.preventDefault(); fromList(ev); } });
  let upress = null; // toque longo numa pessoa
  document.addEventListener('pointerdown', (ev) => {
    const e = ev.pointerType === 'touch' && personAt(ev.target);
    if (!e) return;
    upress = { x: ev.clientX, y: ev.clientY, timer: setTimeout(() => { upress.fired = true; openUserMenu(e, upress.x, upress.y); }, 450) };
  }, true);
  document.addEventListener('pointermove', (ev) => { if (upress && !upress.fired && Math.hypot(ev.clientX - upress.x, ev.clientY - upress.y) > 10) { clearTimeout(upress.timer); upress = null; } }, true);
  for (const t of ['pointerup', 'pointercancel']) document.addEventListener(t, () => { if (upress) clearTimeout(upress.timer); }, true);
  document.addEventListener('click', (ev) => { if (upress && upress.fired) { ev.preventDefault(); ev.stopPropagation(); } upress = null; }, true);
  $('delDlg').addEventListener('close', () => {
    if ($('delDlg').returnValue === 'yes' && delId !== null) delMsg(delId);
    delId = null;
    $('delPrev').textContent = '';
  });
  $('chatInput').addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowUp' && !$('chatInput').value && !ev.shiftKey && !ev.altKey && !ev.ctrlKey) { // seta para cima: editar a última minha
      const m = [...chat.list].reverse().find(canEdit);
      if (m) { ev.preventDefault(); startEdit(m.id); }
    }
  });
  $('chatInput').addEventListener('input', () => { // aviso de "digitando" no máximo a cada 3 s
    const now = Date.now();
    if (!$('chatInput').value.trim() || now - typedAt < 3000 || !chatOpen() || !store('name')) return;
    typedAt = now;
    chat.ws.send(JSON.stringify({ t: 'typing', ch: textCh }));
  });

  window.addEventListener('online', () => { refreshStatus(); if (peer && peer.disconnected && !peer.destroyed) peer.reconnect(); if (!chat.ws) chatConnect(); });
  window.addEventListener('offline', refreshStatus);
  // ao fechar a aba: avisa a sala e libera os IDs na hora (senão o diretório fica preso por ~1 min)
  window.addEventListener('pagehide', () => {
    if (!room) return;
    leaving = true;
    broadcast({ t: 'bye' });
    if (dirPeer) dirPeer.destroy();
    if (peer) peer.destroy();
  });
  window.addEventListener('pageshow', (ev) => { if (ev.persisted && leaving) location.reload(); });

  // ---------- servidor fechado (S-0065): convite, tela de entrar, Membros do dono ----------
  const SITE = 'https://alissonlittig.github.io/bagrenation/';
  function onOk(d) {
    sess.ok = true; sess.mt = d.mt; sess.owner = d.owner === true; sess.locked = '';
    try { localStorage.removeItem('bagrenation:inv'); } catch { /* sem armazenamento */ }
    $('lock').hidden = true;
    $('admBtn').hidden = !sess.owner;
    if (d.demo === true && !document.querySelector('.demo-bar')) document.body.append(Object.assign(document.createElement('div'), { className: 'demo-bar', textContent: 'Demonstração · tudo aqui é de exemplo' }));
    if (textCh !== 'chat' && chatOpen()) { chat.loading = true; chat.ws.send(JSON.stringify({ t: 'hist', ch: textCh })); }
    myFace(); renderPeople();
    if (store('name')) joinMesh();
  }
  function lockShow(why) {
    sess.ok = false; sess.mt = ''; sess.locked = why;
    if (why !== 'need' || inVoice) { if (inVoice) leaveVoice(); djKill(); }
    if ($('nameDlg').open) $('nameDlg').close();
    for (const dl of document.querySelectorAll('dialog[open]')) dl.close();
    chat.list = []; members.clear(); renderChat(true); renderPeople();
    $('admBtn').hidden = true;
    const ban = why === 'ban';
    $('lockTitle').textContent = ban ? 'Você saiu deste servidor' : 'BAGRENATION é um servidor fechado';
    $('lockText').textContent = ban ? 'O dono do servidor tirou o seu acesso.'
      : why === 'bad' ? 'Esse convite não vale mais. Peça um link novo para quem te convidou e cole aqui.'
        : 'Só entra quem recebeu o link de convite. Recebeu? Abra o link ou cole ele aqui.';
    $('lockInput').hidden = ban; $('lockGo').hidden = ban;
    $('lock').hidden = false;
  }
  $('lockForm').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const v = invFrom($('lockInput').value);
    if (!v) { toast('Cole o link inteiro do convite (ou o código dele).'); $('lockInput').focus(); return; }
    store('inv', v);
    sess.locked = '';
    $('lock').hidden = true;
    $('lockInput').value = '';
    if (!store('name')) { $('homeName').value = ''; $('nameDlg').showModal(); myFace(); }
    if (!chatOpen()) { chat.backoff = 0; chatConnect(); } else sendMe();
  });
  const admWhen = (ts) => (ts ? new Date(ts).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');
  function twoStep(btn, label, confirmLabel, go) { // 1º toque arma, 2º confirma (sem janela do sistema)
    btn.addEventListener('click', () => {
      if (btn.dataset.armed === '1') { btn.dataset.armed = ''; btn.textContent = label; go(); return; }
      btn.dataset.armed = '1'; btn.textContent = confirmLabel;
      setTimeout(() => { if (btn.dataset.armed === '1') { btn.dataset.armed = ''; btn.textContent = label; } }, 4000);
    });
  }
  function admSend(o) { if (chatOpen()) chat.ws.send(JSON.stringify({ t: 'adm', ...o })); else toast('O chat está reconectando. Tente de novo em instantes.'); }
  function admRender(list) {
    const ul = $('admList');
    ul.textContent = '';
    for (const m of list) {
      const li = document.createElement('li');
      li.className = `adm-row${m.ban ? ' is-ban' : ''}`;
      const head = document.createElement('div');
      const st = m.ban ? 'Bloqueado' : !m.ok ? 'Tentou entrar sem convite' : { on: 'Online', idle: 'Ausente' }[m.st] || 'Offline';
      head.append(Object.assign(document.createElement('b'), { textContent: String(m.name || '?').slice(0, 24) }), ' ',
        Object.assign(document.createElement('span'), { className: 'adm-tag', textContent: `${m.uid === myUid ? 'você · ' : m.owner ? 'dono · ' : ''}${st}` }));
      const info = Object.assign(document.createElement('div'), { className: 'muted',
        textContent: `Entrou ${admWhen(m.since)} · visto ${admWhen(m.seen)} · ${String(m.dev || 'aparelho ?').slice(0, 60)}${m.place ? ` · ${String(m.place).slice(0, 60)}` : ''}` });
      li.append(head, info);
      if (!m.owner && /^[a-f0-9]{16}$/.test(m.uid || '')) {
        const b = Object.assign(document.createElement('button'), { type: 'button', className: m.ban ? 'btn btn-quiet' : 'btn btn-danger' });
        const label = m.ban ? 'Desbloquear' : 'Expulsar';
        b.textContent = label;
        twoStep(b, label, 'Confirmar', () => admSend({ op: m.ban ? 'unban' : 'kick', uid: m.uid }));
        li.append(b);
      }
      ul.append(li);
    }
  }
  function admInv(tok) {
    $('admInvLink').value = `${SITE}#convite=${tok}`;
    $('admInvBox').hidden = false;
    toast('Convite novo pronto. O link antigo parou de valer.');
  }
  $('admBtn').addEventListener('click', () => { admSend({ op: 'list' }); $('admInvBox').hidden = true; $('admDlg').showModal(); });
  twoStep($('admInvNew'), 'Gerar novo convite', 'Confirmar: o link antigo para de valer', () => admSend({ op: 'invite' }));
  $('admInvCopy').addEventListener('click', () => {
    navigator.clipboard.writeText($('admInvLink').value).then(() => toast('Link do convite copiado.')).catch(() => { $('admInvLink').select(); toast('Selecionei o link: copie com Ctrl+C.'); });
  });

  // ---------- app para PC (Tauri) ----------
  // Tecla global (push-to-talk e mutar valem com o jogo em foco), bandeja, abrir com o Windows,
  // animações paradas com a janela escondida e links externos no navegador padrão.
  if (DESK) {
    const { invoke } = DESK.core;
    const { listen } = DESK.event;
    document.documentElement.classList.add('is-app');
    for (const el of document.querySelectorAll('.js-app')) el.hidden = false;
    $('pttLabel').textContent = 'Tecla (vale em qualquer janela, até no jogo)';
    $('muteKeyBtn').addEventListener('click', () => { pickingKey = 'mute'; renderVoice(); });
    document.addEventListener('mousedown', (ev) => { // botão do meio e laterais do mouse também servem de tecla
      if (pickingKey && [1, 3, 4].includes(ev.button)) { ev.preventDefault(); pickKey(`Mouse${ev.button + 2}`); }
    }, true);
    listen('ptt', ({ payload }) => {
      if (!inVoice || voice.mode !== 'ptt' || pickingKey) return;
      if (payload && document.hasFocus() && typing(document.activeElement)) return; // digitando no chat
      voice.keyDown = payload === true;
      gate();
    });
    listen('hotkey-mute', () => {
      if (!inVoice || pickingKey) return;
      if (voice.track) setMuted(!voice.muted); else openMic(true);
      sfx(voice.muted ? 'out' : 'in');
    });
    listen('tray', ({ payload }) => {
      if (!inVoice) return;
      if (payload === 'deaf') setDeaf(!voice.deaf);
      else if (voice.track) setMuted(!voice.muted); else openMic(true);
    });
    const shown = (on) => { document.documentElement.classList.toggle('app-hidden', on !== true); if (chatSeen()) readAll(); };
    listen('visible', ({ payload }) => shown(payload));
    invoke('is_visible').then(shown).catch(() => {}); // aberto com o Windows já nasce escondido na bandeja
    listen('quit', () => { leaveAll(); invoke('quit_now'); });
    invoke('autostart').then((on) => { $('autoStart').checked = on; }).catch(() => {});
    $('autoStart').addEventListener('change', () => {
      invoke('autostart', { on: $('autoStart').checked })
        .then((on) => { $('autoStart').checked = on; toast(on ? 'O BAGRENATION abre com o Windows, direto na bandeja.' : 'O BAGRENATION não abre mais com o Windows.'); })
        .catch((err) => { $('autoStart').checked = !$('autoStart').checked; toast(`Não deu para mudar: ${err}`); });
    });
    document.addEventListener('click', (ev) => { // link abre no navegador padrão do Windows (S-0059: a permissão agora aceita http/https)
      const a = ev.target.closest('a[href^="http"]');
      if (!a) return;
      ev.preventDefault();
      DESK.opener.openUrl(a.href).catch((err) => toast(`Não consegui abrir o link: ${String(err).slice(0, 120)}`, 6000));
    });
  }

  // ---------- início ----------
  // Abrir = já estar no servidor (sem tela de criar/entrar em sala). Primeira vez: pergunta o nome.
  renderQuality();
  if (store('hint') === 'detail') $('hint').value = 'detail';
  if (location.hash) history.replaceState(null, '', location.pathname + location.search); // links antigos de sala (#ID) caem aqui
  renderDiscord();
  renderStatus();
  enterServer();
  renderVoice();
  if (!store('name')) {
    $('homeName').value = '';
    $('nameDlg').showModal();
    myFace();
    if (window.matchMedia('(hover: hover)').matches) $('homeName').focus(); // no celular não abre o teclado sozinho
  }
})();
