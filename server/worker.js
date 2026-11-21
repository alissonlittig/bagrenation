// BAGRENATION · chat de texto permanente (Cloudflare Worker + Durable Object com SQLite, plano grátis).
// Um Durable Object por servidor (o fixo é "bagrenation"; os testes usam outro nome e não sujam o histórico).
//   GET  /s/<srv>/ws          WebSocket: histórico + membros ao conectar, depois tudo em tempo real
//   POST /s/<srv>/up          envia um arquivo (imagem, GIF ou vídeo) e devolve { id, mime, size }
//   GET  /s/<srv>/m/<id>      devolve o arquivo (com Range, para o vídeo poder avançar)
//   POST /s/<srv>/del?id=N    apaga uma mensagem (moderação: Authorization: Bearer <ADMIN_KEY>)
// Escrever exige Origin do site ou do app: não é segredo (dá para forjar fora do navegador), só impede
// que outra página use o chat. Moderação de verdade = ADMIN_KEY, guardada como secret do Worker.
// Identidade (S-1357): cada aparelho guarda uma chave aleatória; o id público (uid) é o hash dela. Só quem tem a
// chave edita e apaga as próprias mensagens. Presença (online/ausente/offline), "digitando", respostas e reações
// vão pelo mesmo WebSocket. Mensagens antigas (sem uid) continuam como estavam.
// Canais (S-1363): vários canais de texto e de voz. #chat (id 'chat') guarda o histórico de antes e "Canal de voz"
// (id 'voz') é o canal das versões antigas. Qualquer membro cria, renomeia e apaga canais (S-1378); os fixos só renomeiam.
// Mensagens de outros canais só vão para clientes novos (que mandam { t:'v' }): o app antigo as mostraria no #chat.
// Sinalização WebRTC (S-1382): GET /s/<srv>/rtc é um segundo WebSocket só para os navegadores se encontrarem
// (oferta, resposta e candidatos ICE passam por aqui; voz e tela continuam de navegador para navegador).
// Substitui o servidor público 0.peerjs.com. TURN do Cloudflare Realtime só entra se os secrets TURN_KEY_ID e
// TURN_KEY_API_TOKEN existirem; sem eles só vai STUN.
// Bagre DJ (S-1566): música do YouTube sincronizada em cada canal de voz. O estado (fila, vídeo, início, pausa) fica aqui
// e vai para todos; cada pessoa toca o player oficial do YouTube no próprio aparelho (nada de baixar ou retransmitir áudio).
// Busca por nome: YouTube Data API v3 se houver o secret YT_KEY; sem ela, a busca pública do YouTube (sem chave) (S-1580).
// Links do Spotify (faixa, álbum, playlist): só título e artista da página pública do embed; a música sai da busca do YouTube.
// S-0032: playlist/álbum do Spotify até 100 faixas (o embed mostra até 100): as 6 primeiras tocam logo e o resto entra na fila
// aos poucos, 20 por vez, pelo alarme do objeto (cada chamada do plano grátis tem só 50 subpedidos). Aceita spotify.link,
// spotify:playlist:, /intl-xx/, /embed/ e /user/<x>/playlist/.
// S-0032 E1: versão original. Nome digitado vira título + artista oficiais (iTunes Search API, grátis e sem chave); a busca
// do YouTube é 'artista - título' e cada resultado ganha nota: canal '- Topic' (áudio oficial do YouTube Music), VEVO ou do
// artista, 'official audio/video', duração a até 15 s da oficial; fortnite, remix, cover, nightcore, sped up, slowed,
// karaoke, 8d, reverb, live, instrumental (e lyrics de canal qualquer) só passam se o pedido tiver a palavra.

const ORIGINS = [/^https:\/\/alissonlittig\.github\.io$/, /^https?:\/\/tauri\.localhost$/, /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/];
const MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'video/mp4', 'video/webm', 'video/quicktime']);
const MAX_FILE = 25 * 1024 * 1024;
const MAX_AV = 5 * 1024 * 1024;         // avatar enviado (S-1397): só imagem, não conta no teto de 3 GB e nunca expira
const AV_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const CHUNK = 1024 * 1024;              // SQLite do Durable Object aceita até 2 MB por valor
const MAX_TOTAL = 3 * 1024 ** 3;        // plano grátis = 5 GB; acima de 3 GB os arquivos mais antigos saem
const HISTORY = 150;
const STALE = 150000;                   // conexão identificada sem sinal (ping a cada 25 s) há 150 s = caiu sem avisar
const EMOJIS = new Set(['👍', '❤️', '😂', '😮', '😢', '😡', '🔥', '🎉', '👀', '💀', '🐟', '🙏', '👏', '🤡', '💯', '✅']);
const ST = ['on', 'idle', 'off'];       // off = invisível (para os outros, igual a offline)
const FIXED = { chat: 'text', voz: 'voice' }; // canais de sempre: renomeia, não apaga
const MAX_CHANS = 30;
const RTC_ID = /^[a-z0-9-]{3,80}$/;
const MAX_SIG = 32000;                  // oferta/resposta (SDP) cabem folgados; acima disso não é sinalização
const STUN = { urls: 'stun:stun.cloudflare.com:3478' };
const YT_ID = /^[A-Za-z0-9_-]{11}$/;
const MAX_Q = 200;                      // itens na fila de um canal (tocadas + próximas)
const KEEP_PLAYED = 30;                 // tocadas que ficam para o "voltar"
const LOOPS = ['off', 'all', 'one'];
const SP_MAX = 100;                     // faixas de uma playlist/álbum do Spotify (o embed público mostra até 100)
const SP_FIRST = 6;                     // achadas antes de responder (tocam logo); o resto entra aos poucos
const SP_STEP = 20;                     // buscas por volta do alarme (plano grátis: 50 subpedidos por chamada; cada busca pode tentar 2 vezes)
const SP_ERR = 'Não consegui ler esse link do Spotify agora. Tente de novo.';
const BAD = ['fortnite', 'remix', 'rmx', 'cover', 'covers', 'nightcore', 'sped up', 'speed up', 'speed', 'slowed', 'reverb', 'karaoke', 'karaoke version', '8d', '8d audio',
  'live', 'ao vivo', 'en vivo', 'live at', 'instrumental', 'piano', 'lofi', 'lo fi', 'mashup', 'reaction', 'react', 'bass boosted', 'tiktok', 'acoustic', 'acustico',
  'cifra', 'aula', 'tutorial', 'como tocar', 'guitar', 'drum', 'bateria', 'parody', 'parodia', 'edit', 'extended', 'loop', '1 hour', '10 hours', 'mix', 'megamix', 'medley'];
const WANT = ['fortnite', 'remix', 'cover', 'nightcore', 'sped up', 'slowed', 'reverb', 'karaoke', '8d', 'live', 'ao vivo', 'en vivo', 'instrumental', 'acoustic', 'acustico', 'piano'];
const LYRIC = ['lyrics', 'lyric', 'letra', 'legendado', 'legenda', 'traducao', 'tradução', 'with lyrics', 'com letra'];
const DJ = { name: 'Bagre DJ', av: 'dj', uid: 'dj' };
// S-0033: como os bots de música do Discord. Comandos com ! ou / e apelidos (o app traduz); 'Tocando agora' no chat com capa,
// barra e botões (1 por canal de voz: o anterior sai quando a próxima começa); fila acabou = o DJ fica DJ_STAY no canal;
// ninguém no canal há DJ_LEAVE = sai e limpa a fila (só conta quem avisa presença: app/site novos); autoplay ligável (mesmo
// artista pelo iTunes); letra só de fonte grátis (LRCLIB, sem chave).
const DJ_LEAVE = 180000;
const DJ_STAY = 180000;
const LRC_UA = 'BagreDJ/1.9 (bot de musica de um chat entre amigos)';
const chanName = (v, kind) => { const n = clean(v, 32); return kind === 'text' ? n.toLowerCase().replace(/\s+/g, '-') : n; };
const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, max);
const bioClean = (s) => clean(String(s ?? '').replace(/\r/g, '').replace(/\n{3,}/g, '\n\n'), 190); // bio pública (S-1412): até 190 caracteres, quebra de linha ok
const avOf = (v) => (/^[a-z0-9-]{0,24}$/.test(v || '') && v !== 'dj' ? v || '' : ''); // inclui u-<id de 20> (avatar enviado); 'dj' é só do bot
const row = (r) => ({ ...r, media: r.media ? JSON.parse(r.media) : null, reply: r.reply ? JSON.parse(r.reply) : null, reacts: r.reacts ? JSON.parse(r.reacts) : null, card: r.card ? JSON.parse(r.card) : null });
const dur = (ms) => (ms >= 60000 ? `${Math.round(ms / 60000)} min` : `${Math.round(ms / 1000)} s`);

function cors(origin) {
  return origin ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', Vary: 'Origin' } : {};
}
const json = (data, status, origin) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...cors(origin) } });

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const origin = req.headers.get('Origin') || '';
    const okOrigin = ORIGINS.some((re) => re.test(origin)) ? origin : '';
    if (req.method === 'OPTIONS') return new Response(null, { status: okOrigin ? 204 : 403, headers: cors(okOrigin) });
    const m = url.pathname.match(/^\/s\/([a-z0-9-]{1,40})\/(ws|rtc|up|del|m\/[a-z0-9]{20})$/);
    if (!m) return new Response('BAGRENATION chat', { status: url.pathname === '/' ? 200 : 404 });
    const write = m[2] === 'ws' || m[2] === 'rtc' || m[2] === 'up';
    if (write && !okOrigin) return json({ error: 'origem não autorizada' }, 403);
    const stub = env.SERVER.get(env.SERVER.idFromName(m[1]));
    const h = new Headers(req.headers); // set (não append): o cliente não consegue injetar a rota nem a origem
    h.set('X-Route', m[2]);
    h.set('X-Ok-Origin', okOrigin);
    h.set('X-Srv', m[1]);
    return stub.fetch(new Request(req, { headers: h }));
  },
};

export class Server {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS msgs (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, name TEXT NOT NULL, av TEXT NOT NULL, text TEXT NOT NULL, media TEXT);
      CREATE TABLE IF NOT EXISTS media (id TEXT PRIMARY KEY, mime TEXT NOT NULL, size INTEGER NOT NULL, ts INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS chunks (id TEXT NOT NULL, n INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (id, n));
      CREATE TABLE IF NOT EXISTS members (uid TEXT PRIMARY KEY, name TEXT NOT NULL, av TEXT NOT NULL, seen INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS chans (id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, uid TEXT, pos INTEGER NOT NULL, ts INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS music (ch TEXT PRIMARY KEY, s TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS spq (id INTEGER PRIMARY KEY AUTOINCREMENT, ch TEXT NOT NULL, j TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS musseen (ch TEXT PRIMARY KEY, ts INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      INSERT OR IGNORE INTO chans (id, kind, name, uid, pos, ts) VALUES ('chat', 'text', 'chat', NULL, 0, 0), ('voz', 'voice', 'Canal de voz', NULL, 0, 0);`);
    // migração S-1357: só acrescenta colunas (nada é apagado); mensagens antigas ficam com uid vazio
    const cols = new Set(this.sql.exec('PRAGMA table_info(msgs)').toArray().map((c) => c.name));
    for (const [c, type] of [['uid', 'TEXT'], ['edited', 'INTEGER'], ['reply', 'TEXT'], ['reacts', 'TEXT'], ['card', 'TEXT']]) { // card: S-0033
      if (!cols.has(c)) this.sql.exec(`ALTER TABLE msgs ADD COLUMN ${c} ${type}`);
    }
    if (!cols.has('ch')) { // migração S-1363: só acrescenta; tudo o que já existe é do #chat
      this.sql.exec('ALTER TABLE msgs ADD COLUMN ch TEXT');
      this.sql.exec("UPDATE msgs SET ch = 'chat' WHERE ch IS NULL");
    }
    this.sql.exec('CREATE INDEX IF NOT EXISTS msgs_ch ON msgs (ch, id)');
    if (!this.sql.exec('PRAGMA table_info(media)').toArray().some((c) => c.name === 'av')) this.sql.exec('ALTER TABLE media ADD COLUMN av INTEGER NOT NULL DEFAULT 0'); // S-1397
    const mcols = new Set(this.sql.exec('PRAGMA table_info(members)').toArray().map((c) => c.name)); // migração S-1412: bio pública e "membro desde"
    if (!mcols.has('bio')) this.sql.exec("ALTER TABLE members ADD COLUMN bio TEXT NOT NULL DEFAULT ''");
    if (!mcols.has('since')) {
      this.sql.exec('ALTER TABLE members ADD COLUMN since INTEGER NOT NULL DEFAULT 0');
      this.sql.exec('UPDATE members SET since = COALESCE((SELECT MIN(ts) FROM msgs WHERE msgs.uid = members.uid), seen)');
    }
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong')); // responde sem acordar o objeto
    this.upAt = new Map(); // ip -> últimos envios (limite simples, some quando o objeto hiberna)
    this.shown = new Map(); // uid -> último estado avisado (some ao hibernar: no pior caso repete um aviso igual)
    this.ytc = new Map();   // busca -> { at, list } (economiza cota da Data API; some ao hibernar)
  }

  async fetch(req) {
    const route = req.headers.get('X-Route');
    const srv = req.headers.get('X-Srv') || '';
    if (srv && this.srv !== srv) { this.srv = srv; this.sql.exec("INSERT OR REPLACE INTO kv (k, v) VALUES ('srv', ?)", srv); }
    const origin = req.headers.get('X-Ok-Origin');
    if (route === 'rtc') {
      if (req.headers.get('Upgrade') !== 'websocket') return new Response('esperava WebSocket', { status: 426 });
      const [client, server] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(server, ['rtc']);
      server.serializeAttachment({ rtc: '', since: Date.now() });
      return new Response(null, { status: 101, webSocket: client });
    }
    if (route === 'ws') {
      if (req.headers.get('Upgrade') !== 'websocket') return new Response('esperava WebSocket', { status: 426 });
      const [client, server] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ at: 0, since: Date.now() });
      server.send(JSON.stringify({ t: 'hist', list: this.history() }));
      server.send(JSON.stringify({ t: 'members', list: this.members() }));
      server.send(JSON.stringify({ t: 'chans', list: this.chans() }));
      const now = Date.now();
      if (this.djLeave(now)) await this.ctx.storage.setAlarm(now + this.djT().tick); // S-0033: canal vazio há tempo = o DJ sai
      for (const r of this.sql.exec('SELECT ch, s FROM music').toArray()) server.send(JSON.stringify({ t: 'mus', ch: r.ch, s: JSON.parse(r.s), now }));
      return new Response(null, { status: 101, webSocket: client });
    }
    if (route === 'up') return this.upload(req, origin, new URL(req.url).searchParams.get('av') === '1');
    if (route === 'del') return this.del(req);
    return this.media(req, route.slice(2));
  }

  history(before, ch = 'chat') {
    const rows = before
      ? this.sql.exec('SELECT * FROM msgs WHERE ch = ? AND id < ? ORDER BY id DESC LIMIT ?', ch, before, HISTORY).toArray()
      : this.sql.exec('SELECT * FROM msgs WHERE ch = ? ORDER BY id DESC LIMIT ?', ch, HISTORY).toArray();
    return rows.reverse().map(row);
  }

  broadcast(obj, skip, onlyNew) { // onlyNew: só para quem entende canais (mensagem fora do #chat)
    const s = JSON.stringify(obj);
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() || {};
      if (ws === skip || typeof a.rtc === 'string' || (onlyNew && !a.c2)) continue;
      try { ws.send(s); } catch { /* fechando */ }
    }
  }

  // ---------- canais ----------
  chans() { // lista com a última mensagem de cada canal de texto (para "não lidas")
    const last = new Map(this.sql.exec('SELECT ch, MAX(id) AS last FROM msgs GROUP BY ch').toArray().map((r) => [r.ch, r.last]));
    return this.sql.exec('SELECT id, kind, name, uid FROM chans ORDER BY pos, ts').toArray()
      .map((c) => ({ ...c, uid: c.uid || '', last: last.get(c.id) || 0 }));
  }
  textChan(id) { // id de canal de texto válido, ou '' (sem id = versão antiga = #chat)
    if (id === undefined || id === null) return 'chat';
    const c = typeof id === 'string' && this.sql.exec('SELECT kind FROM chans WHERE id = ?', id).toArray()[0];
    return c && c.kind === 'text' ? id : '';
  }
  chan(ws, att, d, now) { // { t:'chan', op:'add'|'ren'|'del', kind, id, name }
    const no = (text) => ws.send(JSON.stringify({ t: 'err', text }));
    if (!att.uid) return no('Espere o chat conectar e tente de novo.');
    if (now - (att.ct || 0) < 800) return no('Calma: um canal por vez.');
    att.ct = now;
    ws.serializeAttachment(att);
    if (d.op === 'add') {
      const kind = d.kind === 'voice' ? 'voice' : 'text';
      const name = chanName(d.name, kind);
      if (!name) return no('Dê um nome ao canal.');
      if (this.sql.exec('SELECT COUNT(*) AS n FROM chans').one().n >= MAX_CHANS) return no(`Limite de ${MAX_CHANS} canais.`);
      const id = [...crypto.getRandomValues(new Uint8Array(8))].map((b) => 'abcdefghijklmnopqrstuvwxyz234567'[b & 31]).join('');
      const pos = this.sql.exec('SELECT COALESCE(MAX(pos), 0) + 1 AS p FROM chans WHERE kind = ?', kind).one().p;
      this.sql.exec('INSERT INTO chans (id, kind, name, uid, pos, ts) VALUES (?, ?, ?, ?, ?, ?)', id, kind, name, att.uid, pos, now);
      this.broadcast({ t: 'chans', list: this.chans() });
      ws.send(JSON.stringify({ t: 'chanok', id, kind }));
      return;
    }
    const c = typeof d.id === 'string' && this.sql.exec('SELECT * FROM chans WHERE id = ?', d.id).toArray()[0];
    if (!c) return no('Esse canal não existe mais.');
    if (d.op === 'del' && FIXED[c.id]) return no('Esse canal é fixo: dá para renomear, não para apagar.');
    if (d.op === 'ren') {
      const name = chanName(d.name, c.kind);
      if (!name) return no('Dê um nome ao canal.');
      this.sql.exec('UPDATE chans SET name = ? WHERE id = ?', name, c.id);
    } else if (d.op === 'del') {
      this.ctx.storage.transactionSync(() => { // some o canal com as mensagens e arquivos dele
        for (const r of this.sql.exec('SELECT media FROM msgs WHERE ch = ? AND media IS NOT NULL', c.id).toArray()) {
          const id = JSON.parse(r.media).id;
          this.sql.exec('DELETE FROM chunks WHERE id = ?', id);
          this.sql.exec('DELETE FROM media WHERE id = ?', id);
        }
        this.sql.exec('DELETE FROM msgs WHERE ch = ?', c.id);
        this.sql.exec('DELETE FROM chans WHERE id = ?', c.id);
        this.sql.exec('DELETE FROM music WHERE ch = ?', c.id);
      });
    } else return;
    ws.send(JSON.stringify({ t: 'chanok', id: c.id, kind: c.kind, op: d.op }));
    this.broadcast({ t: 'chans', list: this.chans() });
  }

  // ---------- presença ----------
  dead(ws, a, now) {
    const pong = this.ctx.getWebSocketAutoResponseTimestamp(ws);
    return now - Math.max(a.since || 0, a.lt || 0, pong ? pong.getTime() : 0) > STALE;
  }
  live(skip) { // uid -> melhor estado entre as conexões abertas dessa pessoa ('on' > 'idle' > 'off')
    const now = Date.now();
    const out = new Map();
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() || {};
      if (ws === skip || !a.uid || a.closed || this.dead(ws, a, now)) continue;
      const cur = out.get(a.uid);
      if (!cur || a.st === 'on' || (a.st === 'idle' && cur === 'off')) out.set(a.uid, a.st);
    }
    return out;
  }
  members() {
    const live = this.live();
    return this.sql.exec('SELECT uid, name, av, seen, bio, since FROM members ORDER BY seen DESC LIMIT 300').toArray()
      .map((m) => ({ ...m, st: live.get(m.uid) || 'off' }));
  }
  presence(uid, skip) { // avisa todo mundo se o estado público (ou nome/avatar) dessa pessoa mudou
    const m = this.sql.exec('SELECT uid, name, av, seen, bio, since FROM members WHERE uid = ?', uid).toArray()[0];
    if (!m) return;
    const st = this.live(skip).get(uid) || 'off';
    const key = `${st}|${m.name}|${m.av}|${m.bio}`;
    if (this.shown.get(uid) === key) return;
    this.shown.set(uid, key);
    this.broadcast({ t: 'pres', m: { ...m, st } });
  }
  gone(ws, a) { // conexão fechou (ou sumiu): a pessoa pode ter ido para offline
    if (a.closed) return;
    try { ws.serializeAttachment({ ...a, closed: true }); } catch { /* já fechou */ }
    try { ws.close(1000, 'fim'); } catch { /* já fechou */ }
    if (!a.uid) return;
    this.sql.exec('UPDATE members SET seen = ? WHERE uid = ?', Date.now(), a.uid);
    this.presence(a.uid, ws);
  }
  async alarm() { // a cada minuto, enquanto houver gente: derruba conexão que sumiu sem avisar (PC dormiu, rede caiu)
    const now = Date.now();
    let left = false;
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() || {};
      if (!a.uid || a.closed) continue;
      if (this.dead(ws, a, now)) this.gone(ws, a); else left = true;
    }
    let more = false;
    try { more = await this.spStep(); } catch (err) { console.warn('Spotify fila', String(err)); more = this.spPending(); }
    const djBusy = this.djLeave(Date.now()); // S-0033
    if (more) await this.ctx.storage.setAlarm(Date.now() + 200);
    else if (left || djBusy) await this.ctx.storage.setAlarm(Date.now() + (djBusy ? this.djT().tick : 60000));
  }

  // ---------- sinalização WebRTC ----------
  async ice() { // STUN sempre; TURN (credencial curta gerada na hora) só se o Cloudflare Realtime estiver ligado
    const id = this.env.TURN_KEY_ID, tok = this.env.TURN_KEY_API_TOKEN;
    if (!id || !tok) return [STUN];
    if (this.turn && Date.now() < this.turn.until) return this.turn.list;
    try {
      const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${id}/credentials/generate-ice-servers`, {
        method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ ttl: 86400 }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const list = [STUN, ...(await r.json()).iceServers.filter((s) => JSON.stringify(s.urls).includes('turn:'))];
      this.turn = { list, until: Date.now() + 3600000 }; // credencial vale 24 h; renova a cada hora
      return list;
    } catch (err) {
      console.warn('TURN indisponível, só STUN:', String(err));
      return [STUN];
    }
  }
  rtcHolder(id) { return this.ctx.getWebSockets('rtc').find((w) => (w.deserializeAttachment() || {}).rtc === id); }
  async rtc(ws, a, raw) { // { t:'reg', id, tok } · { t:'sig', to, d } (repassa para o dono do id)
    if (raw.length > MAX_SIG) return;
    let d;
    try { d = JSON.parse(raw); } catch { return; }
    if (!d || typeof d !== 'object') return;
    const now = Date.now();
    if (d.t === 'reg') {
      if (a.rtc || typeof d.id !== 'string' || !RTC_ID.test(d.id) || typeof d.tok !== 'string' || d.tok.length > 40) return;
      const old = this.rtcHolder(d.id);
      if (old) {
        const o = old.deserializeAttachment() || {};
        const pong = this.ctx.getWebSocketAutoResponseTimestamp(old);
        const alive = now - Math.max(o.since || 0, o.lt || 0, pong ? pong.getTime() : 0) < 70000;
        if (o.tok !== d.tok && alive) { ws.send(JSON.stringify({ t: 'taken' })); return; }
        try { old.serializeAttachment({ ...o, rtc: '' }); old.close(4000, 'substituído'); } catch { /* já fechou */ }
      }
      ws.serializeAttachment({ ...a, rtc: d.id, tok: d.tok, lt: now });
      ws.send(JSON.stringify({ t: 'ok', ice: await this.ice() }));
      return;
    }
    if (!a.rtc) return;
    a.lt = now;
    ws.serializeAttachment(a);
    if (d.t === 'sig' && typeof d.to === 'string' && d.d && typeof d.d === 'object') {
      const to = this.rtcHolder(d.to);
      if (!to || to === ws) { if (typeof d.d.o === 'string') ws.send(JSON.stringify({ t: 'gone', to: d.to })); return; } // só oferta de quem nunca existiu vira erro
      try { to.send(JSON.stringify({ t: 'sig', from: a.rtc, d: d.d })); } catch { ws.send(JSON.stringify({ t: 'gone', to: d.to })); }
    }
  }

  async webSocketMessage(ws, raw) {
    const a0 = ws.deserializeAttachment() || {};
    if (typeof a0.rtc === 'string') return this.rtc(ws, a0, String(raw));
    let d;
    try { d = JSON.parse(raw); } catch { return; }
    if (!d || typeof d !== 'object') return;
    if (d.t === 'more' && Number.isInteger(d.before)) {
      const ch = this.textChan(d.ch);
      if (ch) ws.send(JSON.stringify({ t: 'old', ch, list: this.history(d.before, ch) }));
      return;
    }
    if (d.t === 'clk' && Number.isFinite(d.c)) { ws.send(JSON.stringify({ t: 'clk', c: d.c, s: Date.now() })); return; } // acerto de relógio (música)
    if (d.t === 'hist') { const ch = this.textChan(d.ch); if (ch) ws.send(JSON.stringify({ t: 'hist', ch, list: this.history(null, ch) })); return; }
    const att = ws.deserializeAttachment() || { at: 0 };
    const now = Date.now();
    att.lt = now;
    if (d.t === 'v') { att.c2 = true; ws.serializeAttachment(att); return; } // cliente que entende canais
    if (d.t === 'me') return this.hello(ws, att, d);
    if (d.t === 'chan') return this.chan(ws, att, d, now);
    if (d.t === 'typing') { // nada é gravado: só repassa, no máximo 1 a cada 2 s por conexão
      const ch = this.textChan(d.ch);
      if (!att.uid || !ch || now - (att.ty || 0) < 2000) return;
      att.ty = now;
      ws.serializeAttachment(att);
      this.broadcast({ t: 'typing', uid: att.uid, ch }, ws, ch !== 'chat');
      return;
    }
    if (d.t === 'react') return this.react(ws, att, d, now);
    if (d.t === 'mus' && d.op === 'here') return this.djHere(ws, att, d, now);
    if (d.t === 'mus') return this.mus(ws, att, d, now);
    if (d.t === 'lyr') return this.lyrics(ws, att, d, now);
    if (d.t === 'yt') return this.ytSearch(ws, att, d, now);
    if (d.t === 'edit' || d.t === 'del') return this.change(ws, att, d, now);
    if (d.t !== 'msg') return;
    const ch = this.textChan(d.ch);
    if (!ch) return; // canal apagado
    if (now - (att.at || 0) < 250) return; // no máximo 4 por segundo por conexão
    att.at = now;
    ws.serializeAttachment(att);
    const name = clean(d.name, 24) || 'Visitante';
    const av = this.avOk(d.av);
    const text = clean(d.text, 2000);
    let media = null;
    if (d.media && typeof d.media === 'object' && /^[a-z0-9]{20}$/.test(d.media.id)) {
      const r = this.sql.exec('SELECT mime, size FROM media WHERE id = ?', d.media.id).toArray()[0];
      if (r) {
        const dim = (v) => (Number.isInteger(v) && v > 0 && v <= 20000 ? v : 0);
        media = { id: d.media.id, mime: r.mime, size: r.size, w: dim(d.media.w), h: dim(d.media.h), name: clean(d.media.name, 80) };
      }
    }
    if (!text && !media) return;
    let reply = null; // cópia curta da mensagem respondida (a original pode não estar no histórico carregado)
    if (Number.isInteger(d.reply)) {
      const r = this.sql.exec('SELECT id, uid, name, text, media FROM msgs WHERE id = ? AND ch = ?', d.reply, ch).toArray()[0];
      if (r) reply = { id: r.id, uid: r.uid || '', name: r.name, text: r.text.slice(0, 140), media: !!r.media };
    }
    const uid = att.uid || null;
    const id = this.sql.exec('INSERT INTO msgs (ts, name, av, text, media, uid, reply, ch) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id',
      now, name, av, text, media ? JSON.stringify(media) : null, uid, reply ? JSON.stringify(reply) : null, ch).one().id;
    this.broadcast({ t: 'msg', m: { id, ts: now, name, av, text, media, uid, reply, edited: null, reacts: null, ch },
      nonce: typeof d.nonce === 'string' ? d.nonce.slice(0, 40) : undefined }, null, ch !== 'chat');
  }

  // ---------- Bagre DJ (S-1566) ----------
  voiceChan(id) { return typeof id === 'string' && this.sql.exec("SELECT 1 FROM chans WHERE id = ? AND kind = 'voice'", id).toArray().length > 0; }
  mget(ch) {
    const r = this.sql.exec('SELECT s FROM music WHERE ch = ?', ch).toArray()[0];
    return r ? JSON.parse(r.s) : { q: [], i: -1, at: 0, pos: 0, paused: false, loop: 'off', tc: 'chat', v: 0 };
  }
  mset(ch, s, o = {}) { // o.quiet: não anuncia · o.leave: o DJ sai do canal (sem a espera de DJ_STAY)
    const old = this.mget(ch);
    const oc = old.q[old.i], cur = s.q[s.i];
    s.v = (s.v || 0) + 1;
    if (cur || o.leave) s.stay = 0;
    else if (oc && !(s.stay > Date.now())) s.stay = Date.now() + this.djT().stay; // a fila acabou: o DJ fica um pouco no canal
    this.sql.exec('INSERT INTO music (ch, s) VALUES (?, ?) ON CONFLICT(ch) DO UPDATE SET s = excluded.s', ch, JSON.stringify(s));
    this.broadcast({ t: 'mus', ch, s, now: Date.now() }, null, true);
    if (!o.quiet && cur && (!oc || oc.k !== cur.k)) this.djNow(ch, s);
  }
  djT() { // prazos do DJ (servidor de teste: curtos, para o teste não esperar 3 min)
    if (this.srv === undefined) this.srv = (this.sql.exec("SELECT v FROM kv WHERE k = 'srv'").toArray()[0] || {}).v || '';
    return this.srv.startsWith('teste-') ? { leave: 45000, stay: 20000, tick: 5000 } : { leave: DJ_LEAVE, stay: DJ_STAY, tick: 60000 };
  }
  vname(ch) { return (this.sql.exec('SELECT name FROM chans WHERE id = ?', ch).toArray()[0] || {}).name || 'canal de voz'; }
  djNow(ch, s) { // 'Tocando agora' no chat, como o embed dos bots do Discord (o app desenha capa, barra e botões; o anterior sai)
    const cur = s.q[s.i];
    const tc = this.textChan(s.tc) || 'chat';
    const key = `np:${ch}`;
    const prev = Number((this.sql.exec('SELECT v FROM kv WHERE k = ?', key).toArray()[0] || {}).v || 0);
    if (prev) { const r = this.sql.exec("SELECT media FROM msgs WHERE id = ? AND uid = 'dj'", prev).toArray()[0]; if (r) this.remove(prev, r.media); }
    const id = this.djSay(tc, `Tocando agora em 🔊 ${this.vname(ch)}: ${cur.t}${cur.by ? ` (pedido por ${cur.by})` : ''}`,
      { k: 'np', ch, key: cur.k, id: cur.id, t: cur.t, a: cur.a, d: cur.d, by: cur.by, vc: clean(this.vname(ch), 32) });
    this.sql.exec('INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)', key, String(id));
  }
  djHere(ws, att, d, now) { // { t:'mus', op:'here', ch }: tem gente ouvindo neste canal de voz (a cada ~45 s)
    if (!att.uid || now - (att.hb || 0) < 10000 || !this.voiceChan(d.ch)) return;
    att.hb = now;
    ws.serializeAttachment(att);
    this.sql.exec('INSERT OR REPLACE INTO musseen (ch, ts) VALUES (?, ?)', d.ch, now);
  }
  djLeave(now) { // canal com música e ninguém avisando presença há djT().leave: o DJ sai e limpa a fila; true = ainda há o que vigiar
    const { leave } = this.djT();
    const seen = new Map(this.sql.exec('SELECT ch, ts FROM musseen').toArray().map((r) => [r.ch, r.ts]));
    let busy = false;
    for (const r of this.sql.exec('SELECT ch, s FROM music').toArray()) {
      const s = JSON.parse(r.s);
      const cur = s.q[s.i];
      if (!cur && !(s.stay > now)) continue;
      const ts = seen.get(r.ch);
      if (!ts) continue; // só cliente antigo no canal (não avisa presença): fica como era
      if (now - ts < leave) { busy = true; continue; }
      s.q = []; s.i = -1; s.paused = false; s.at = 0; s.pos = 0;
      this.sql.exec('DELETE FROM spq WHERE ch = ?', r.ch);
      this.sql.exec('DELETE FROM musseen WHERE ch = ?', r.ch);
      this.mset(r.ch, s, { quiet: true, leave: true });
      if (cur) this.djSay(s.tc || 'chat', `Saí de 🔊 ${this.vname(r.ch)}: ninguém ouvindo há ${dur(leave)}. Limpei a fila.`);
    }
    return busy;
  }
  static posOf(s, now) { return s.paused ? s.pos : Math.max(0, (now - s.at) / 1000); }
  static start(s, i, now, pos = 0) { s.i = i; s.paused = false; s.pos = 0; s.at = now - pos * 1000; }
  static idle(s) { s.i = s.q.length; s.paused = false; s.pos = 0; s.at = 0; }
  static advance(s, now, manual) { // fim da música (ou pular): repetir uma, próxima, ou volta ao começo da fila
    if (!manual && s.loop === 'one' && s.q[s.i]) return Server.start(s, s.i, now);
    let n = s.i + 1;
    if (n >= s.q.length && s.loop === 'all' && s.q.length) n = 0;
    if (n >= s.q.length) Server.idle(s); else Server.start(s, n, now);
    const drop = s.i - KEEP_PLAYED; // tocadas antigas saem (fica o suficiente para voltar)
    if (drop > 0) { s.q.splice(0, drop); s.i -= drop; }
  }
  item(x, by) { // item da fila vindo do cliente ou da API: só id válido; a capa sai do id (não confia em URL de fora)
    if (!x || !YT_ID.test(x.id)) return null;
    const d = Number.isFinite(x.d) && x.d > 0 && x.d < 86400 ? Math.round(x.d) : 0;
    const k = [...crypto.getRandomValues(new Uint8Array(8))].map((b) => 'abcdefghijklmnopqrstuvwxyz234567'[b & 31]).join('');
    return { k, id: x.id, t: clean(x.t, 140) || 'Vídeo do YouTube', a: clean(x.a, 60), d, by: clean(by, 24) };
  }
  djSay(ch, text, card) { // mensagem do Bagre DJ no canal de texto (fica no histórico, como a de um bot do Discord); card = embed (S-0033)
    const c = this.textChan(ch) || 'chat';
    const now = Date.now();
    const t = clean(text, 2000);
    const cj = card ? JSON.stringify(card) : null; // o app antigo só mostra o texto
    const id = this.sql.exec('INSERT INTO msgs (ts, name, av, text, media, uid, reply, ch, card) VALUES (?, ?, ?, ?, NULL, ?, NULL, ?, ?) RETURNING id', now, DJ.name, DJ.av, t, DJ.uid, c, cj).one().id;
    this.broadcast({ t: 'msg', m: { id, ts: now, name: DJ.name, av: DJ.av, text: t, media: null, uid: DJ.uid, reply: null, edited: null, reacts: null, ch: c, card: card || null } }, null, c !== 'chat');
    return id;
  }
  async mus(ws, att, d, now) { // { t:'mus', ch, op, tc?, ... }: qualquer membro identificado controla o DJ do canal
    const no = (text) => ws.send(JSON.stringify({ t: 'err', text }));
    if (!att.uid) return no('Espere o chat conectar e tente de novo.');
    if (!this.voiceChan(d.ch)) return no('Esse canal de voz não existe mais.');
    if (now - (att.mw || 0) > 2000) { att.mw = now; att.mn = 0; } // até 12 ordens a cada 2 s por conexão (clicar rápido em "+ Fila" passa)
    if (++att.mn > 12) { ws.serializeAttachment(att); return no('Calma: muitas ordens de música seguidas.'); }
    ws.serializeAttachment(att);
    const by = (this.sql.exec('SELECT name FROM members WHERE uid = ?', att.uid).toArray()[0] || {}).name || 'Alguém';
    const mo = {}; // opções do mset (S-0033)
    let ended = false;
    const tc = typeof d.tc === 'string' ? this.textChan(d.tc) : ''; // veio de um comando no chat: o DJ responde lá
    let items = null, label = '', sp = null;
    if (d.op === 'play') { // texto (busca) ou link (vídeo/playlist): resolve antes de mexer no estado
      const r = await this.resolve(clean(d.q, 300));
      if (r.err) { if (tc) this.djSay(tc, `${by}: ${r.err}`); else no(r.err); return; }
      items = r.list; label = r.label || '';
      if (r.sp) sp = r.sp; // playlist/álbum do Spotify: o resto entra aos poucos
    } else if (d.op === 'add') items = Array.isArray(d.items) ? d.items.slice(0, 100) : [];
    let alt = null;
    if (d.op === 'bad' && (d.code === 101 || d.code === 150)) alt = await this.altOf(d.ch, d.k); // S-1580: outra versão que toque no site (até 5)
    const s = this.mget(d.ch); // lido depois do await: nada se perde entre dois pedidos ao mesmo tempo
    const t = Date.now();
    const cur = s.q[s.i];
    const idx = (k) => s.q.findIndex((x) => x.k === k);
    if (tc) s.tc = tc;
    if (items) {
      const add = items.map((x) => this.item(x, by)).filter(Boolean).slice(0, Math.max(0, MAX_Q - s.q.length));
      if (!add.length) return no(s.q.length >= MAX_Q ? `A fila já tem ${MAX_Q} músicas.` : 'Nada para tocar.');
      const now1 = d.now === true || !cur;
      if (cur && d.now === true) { s.q.splice(s.i + 1, 0, ...add); Server.start(s, s.i + 1, t); }
      else if (!cur) { const at = s.q.length; s.q.push(...add); Server.start(s, at, t); }
      else if (d.top === true) s.q.splice(s.i + 1, 0, ...add); // !playtop: entra como a próxima
      else s.q.push(...add);
      const one = add[0];
      let note = '';
      if (sp) { // playlist/álbum do Spotify: avisa para todos no chat (como um bot do Discord) e guarda o resto
        const rest = sp.rest.length;
        note = `${by} pôs ${add.length} de ${label} na fila.${rest ? ` As outras ${rest} entram em instantes.` : ''}${sp.total > sp.want ? ` A playlist tem ${sp.total} músicas: o Bagre DJ pega as ${sp.want} primeiras.` : ''}`;
        this.djSay(tc || s.tc || 'chat', `${note}${now1 ? ` Tocando agora: ${one.t}` : ''}`);
        if (rest) {
          this.sql.exec('INSERT INTO spq (ch, j) VALUES (?, ?)', d.ch, JSON.stringify({ rest: sp.rest, after: add[add.length - 1].k, by, tc: tc || s.tc || 'chat', label, added: add.length, miss: sp.miss, want: sp.want }));
          await this.ctx.storage.setAlarm(Date.now() + 100);
        }
      } else if (tc && add.length > 1) this.djSay(tc, `${by} pôs ${add.length} músicas${label ? ` de ${label}` : ''} na fila.`);
      else if (tc && !now1) { // 1 música na fila: cartão com a posição e quando toca (como o 'Added to queue' dos bots)
        const pos = s.q.findIndex((x) => x.k === one.k) - s.i;
        let eta = cur.d ? Math.max(0, cur.d - Server.posOf(s, t)) : -1;
        for (const x of s.q.slice(s.i + 1, s.i + pos)) eta = eta < 0 || !x.d ? -1 : eta + x.d;
        this.djSay(tc, `Na fila (#${pos}): ${one.t} (pedido por ${by})`, { k: 'add', id: one.id, t: one.t, a: one.a, d: one.d, by, n: pos, eta: eta >= 0 ? Math.round(eta) : null });
      } // tocando agora: o cartão 'Tocando agora' sai do mset
      ws.send(JSON.stringify({ t: 'musok', op: 'add', n: add.length, now: now1, title: one.t, note }));
    } else if (d.op === 'skip') { if (!cur) return no('Nada tocando agora.'); Server.advance(s, t, true); ended = !s.q[s.i]; if (tc) this.djSay(tc, `${by} pulou ${cur.t}.`); }
    else if (d.op === 'prev') {
      if (cur && Server.posOf(s, t) > 5) Server.start(s, s.i, t);
      else if (s.i > 0) Server.start(s, Math.min(s.i, s.q.length) - 1, t);
      else if (cur) Server.start(s, s.i, t);
      else return;
    } else if (d.op === 'pause') { if (!cur || s.paused) return; s.pos = Server.posOf(s, t); s.paused = true; if (tc) this.djSay(tc, `${by} pausou a música.`); }
    else if (d.op === 'resume') { if (!cur || !s.paused) return; s.at = t - s.pos * 1000; s.paused = false; if (tc) this.djSay(tc, `${by} voltou a tocar ${cur.t}.`); }
    else if (d.op === 'seek') {
      if (!cur || !Number.isFinite(d.pos)) return;
      const p = Math.max(0, Math.min(d.pos, cur.d ? cur.d - 1 : 86400));
      if (s.paused) s.pos = p; else s.at = t - p * 1000;
      if (tc) this.djSay(tc, `${by} foi para ${Server.mmss(p)}${cur.d ? ` de ${Server.mmss(cur.d)}` : ''} em ${cur.t}.`);
    } else if (d.op === 'stop' || d.op === 'leave') { // !stop, !leave, !dc: para, limpa a fila e o DJ sai do canal
      if (!s.q.length && !(s.stay > t)) return no('O Bagre DJ não está tocando nada.');
      s.q = []; s.i = -1; s.paused = false; s.at = 0; s.pos = 0;
      this.sql.exec('DELETE FROM spq WHERE ch = ?', d.ch); // playlist do Spotify que ainda entrava: para também
      mo.leave = true;
      if (tc) this.djSay(tc, d.op === 'leave' ? `${by} tirou o Bagre DJ de 🔊 ${this.vname(d.ch)}. Fila limpa.` : `${by} parou a música e limpou a fila.`);
    } else if (d.op === 'clear') { // !clear: limpa só o que vem depois (a atual continua)
      const n = Math.max(0, s.q.length - s.i - 1);
      if (!cur || !n) return no('A fila já está vazia.');
      s.q.splice(s.i + 1);
      this.sql.exec('DELETE FROM spq WHERE ch = ?', d.ch);
      if (tc) this.djSay(tc, `${by} limpou a fila (${n} ${n === 1 ? 'música' : 'músicas'}). ${cur.t} continua tocando.`);
    } else if (d.op === 'dedupe') { // !removedupes: tira as repetidas do que vem depois
      const seen = new Set(cur ? [cur.id] : []);
      const before = s.q.length;
      s.q = s.q.filter((x, n) => n <= s.i || (seen.has(x.id) ? false : (seen.add(x.id), true)));
      const n = before - s.q.length;
      if (!n) return no('Nenhuma música repetida na fila.');
      if (tc) this.djSay(tc, `${by} tirou ${n} ${n === 1 ? 'repetida' : 'repetidas'} da fila.`);
    } else if (d.op === 'rm' && Array.isArray(d.ks)) { // !remove 2-5: várias de uma vez (só o que ainda vai tocar)
      const ks = new Set(d.ks.filter((k) => typeof k === 'string').slice(0, MAX_Q));
      const before = s.q.length;
      s.q = s.q.filter((x, n) => n <= s.i || !ks.has(x.k));
      const n = before - s.q.length;
      if (!n) return;
      if (tc) this.djSay(tc, `${by} tirou ${n} ${n === 1 ? 'música' : 'músicas'} da fila.`);
    } else if (d.op === 'rm') {
      const i = idx(d.k);
      if (i < 0) return;
      const [x] = s.q.splice(i, 1);
      if (i < s.i) s.i--;
      else if (i === s.i) { if (s.i < s.q.length) Server.start(s, s.i, t); else { Server.idle(s); ended = true; } }
      if (tc) this.djSay(tc, `${by} tirou da fila: ${x.t}`);
    } else if (d.op === 'mv') { // reordenar só o que ainda vai tocar
      const i = idx(d.k);
      if (i <= s.i || !Number.isInteger(d.to)) return;
      const [x] = s.q.splice(i, 1);
      s.q.splice(Math.max(s.i + 1, Math.min(d.to, s.q.length)), 0, x);
      if (tc) this.djSay(tc, `${by} moveu ${x.t} para #${s.q.findIndex((y) => y.k === x.k) - s.i} da fila.`);
    } else if (d.op === 'jump') { const i = idx(d.k); if (i < 0) return; Server.start(s, i, t); if (tc) this.djSay(tc, `${by} pulou para ${s.q[i].t}.`); }
    else if (d.op === 'join') { // !join: o DJ entra no canal de voz e espera um pedido
      if (!cur) s.stay = t + this.djT().stay;
      if (tc) this.djSay(tc, cur ? `Já estou em 🔊 ${this.vname(d.ch)} tocando ${cur.t}.` : `Entrei em 🔊 ${this.vname(d.ch)}. Peça com !p <nome ou link>.`);
    } else if (d.op === 'auto') { // !autoplay: quando a fila acaba, o DJ põe uma parecida
      s.auto = d.on === true;
      if (tc) this.djSay(tc, s.auto ? `${by} ligou o autoplay: quando a fila acabar, eu ponho uma música parecida.` : `${by} desligou o autoplay.`);
      if (s.auto && !cur && s.q.length) ended = true;
    }
    else if (d.op === 'shuffle') {
      const rest = s.q.splice(Math.max(0, s.i + 1));
      for (let i = rest.length - 1; i > 0; i--) { const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1); [rest[i], rest[j]] = [rest[j], rest[i]]; }
      s.q.push(...rest);
      if (rest.length < 2) return no('Precisa de 2 músicas na fila para embaralhar.');
      if (tc) this.djSay(tc, `${by} embaralhou a fila.`);
    } else if (d.op === 'loop') {
      if (!LOOPS.includes(d.mode)) return;
      s.loop = d.mode;
      if (tc) this.djSay(tc, `${by}: ${{ off: 'repetir desligado', all: 'repetindo a fila', one: `repetindo ${cur ? cur.t : 'a música'}` }[d.mode]}.`);
    }
    else if (d.op === 'dur') { // duração que o player descobriu (link sem a Data API)
      const i = idx(d.k);
      if (i < 0 || s.q[i].d || !Number.isFinite(d.d) || d.d <= 0 || d.d > 86400) return;
      s.q[i].d = Math.round(d.d);
    } else if (d.op === 'ended') { // fim no player de alguém: só vale para a música atual e perto do fim (vários avisam, conta um)
      if (!cur || cur.k !== d.k || s.paused) return;
      if (cur.d && Server.posOf(s, t) < cur.d - 8) return;
      Server.advance(s, t, false);
      ended = !s.q[s.i];
      if (ended && !s.auto) this.djSay(s.tc || 'chat', `A fila acabou. Fico em 🔊 ${this.vname(d.ch)} mais ${dur(this.djT().stay)}: !p <nome> para continuar.`);
    } else if (d.op === 'bad') { // não toca fora do YouTube (dono bloqueou) ou foi removido: pula e avisa no chat
      if (!cur || cur.k !== d.k || ![2, 100, 101, 150].includes(d.code)) return;
      const nx = alt && alt.k === cur.k && this.item(alt.v, cur.by);
      if (nx) { // troca pela outra versão no mesmo lugar (chave nova: avisos atrasados da versão bloqueada não valem mais)
        nx.x = alt.tried;
        s.q[s.i] = nx;
        Server.start(s, s.i, t);
        this.mset(d.ch, s);
        return;
      }
      s.q.splice(s.i, 1);
      if (s.i < s.q.length) Server.start(s, s.i, t); else { Server.idle(s); ended = true; }
      this.djSay(s.tc || 'chat', d.code === 100 || d.code === 2 ? `${cur.t} não existe mais no YouTube. Pulei para a próxima.` : `${cur.t} não pode tocar fora do YouTube (o dono bloqueou). Pulei para a próxima.`);
    } else return;
    this.mset(d.ch, s, mo);
    if (ended && s.auto && !mo.leave) await this.autoNext(d.ch, cur || s.q[s.q.length - 1]); // S-0033: autoplay
  }
  static mmss(t) { t = Math.max(0, Math.floor(t || 0)); const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = String(t % 60).padStart(2, '0'); return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`; }
  static ttl(t) { // título do YouTube sem (Official Video), [HD], lyrics...
    return String(t || '').replace(/[([{][^)\]}]*[)\]}]/g, ' ').replace(/\b(official|oficial|music|video|vídeo|videoclipe|clipe|audio|áudio|lyrics?|letra|legendado|hd|hq|4k|remaster(ed)?|visualizer)\b/gi, ' ')
      .replace(/\s+/g, ' ').replace(/\s*[-–—|]\s*$/, '').trim();
  }
  async autoNext(ch, last) { // fila acabou com o autoplay ligado: uma música do mesmo artista (iTunes); sem artista, a busca do YouTube
    if (!last) return;
    try {
      const s0 = this.mget(ch);
      const played = new Set(s0.q.map((x) => Server.norm(Server.ttl(x.t)))), ids = new Set(s0.q.map((x) => x.id));
      let a = /\s+-\s+topic$/i.test(last.a || '') ? last.a.replace(/\s+-\s+topic$/i, '') : '';
      const sp = /^(.+?)\s+[-–—|]\s+(.+)$/.exec(Server.ttl(last.t));
      if (!a && sp) a = sp[1];
      if (!a) { const m = await this.meta(Server.ttl(last.t)); if (m) a = m.a; }
      a = Server.artist1(a);
      let pick = null;
      if (a) {
        const r = await fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(a)}&entity=song&attribute=artistTerm&limit=40&country=BR`);
        const res = r.ok ? ((await r.json()).results || []) : [];
        const seen = new Set();
        const cand = res.filter((x) => {
          const k = Server.norm(Server.base(x.trackName));
          if (!x.trackName || seen.has(k) || played.has(k) || [...played].some((p) => p.includes(k)) || Server.norm(Server.artist1(x.artistName)) !== Server.norm(a)) return false;
          seen.add(k);
          return !BAD.some((w) => Server.has(Server.norm(x.trackName), w));
        }).slice(0, 12);
        const c = cand.length ? cand[crypto.getRandomValues(new Uint32Array(1))[0] % cand.length] : null;
        if (c) pick = Server.rank(await this.search(`${a} - ${Server.base(c.trackName)}`), { t: c.trackName, a, d: Math.round((c.trackTimeMillis || 0) / 1000) }, c.trackName).find((x) => !ids.has(x.id)) || null;
      }
      if (!pick) pick = (await this.search(a || Server.ttl(last.t))).find((x) => !ids.has(x.id) && !played.has(Server.norm(Server.ttl(x.t)))) || null;
      if (!pick) return;
      const s = this.mget(ch); // lido depois do await: alguém pode ter pedido outra
      if (s.q[s.i] || !s.auto || s.q.length >= MAX_Q) return;
      const it = this.item(pick, 'autoplay');
      if (!it) return;
      s.q.push(it);
      Server.start(s, s.q.length - 1, Date.now());
      this.mset(ch, s);
    } catch (err) { console.warn('autoplay', String(err)); }
  }
  async lyrics(ws, att, d, now) { // { t:'lyr', n, q?, ch? }: letra só de fonte grátis (LRCLIB, sem chave); sem letra, diz que não achou
    const reply = (o) => ws.send(JSON.stringify({ t: 'lyrres', n: d.n, ...o }));
    if (!att.uid) return;
    if (now - (att.ly || 0) < 1500) return reply({ err: 'Calma: uma letra por vez.' });
    att.ly = now;
    ws.serializeAttachment(att);
    let q = clean(d.q, 200), t = '', a = '', du = 0;
    if (!q) { // a que está tocando no meu canal
      const s = this.voiceChan(d.ch) ? this.mget(d.ch) : null;
      const cur = s && s.q[s.i];
      if (!cur) return reply({ err: 'Nada tocando agora. Use !lyrics <nome da música>.' });
      du = cur.d || 0;
      const sp = /^(.+?)\s+[-–—|]\s+(.+)$/.exec(Server.ttl(cur.t));
      if (/\s+-\s+topic$/i.test(cur.a || '')) { a = cur.a.replace(/\s+-\s+topic$/i, ''); t = Server.ttl(cur.t); }
      else if (sp) { a = sp[1]; t = sp[2]; }
      q = Server.ttl(cur.t);
    }
    try {
      if (!t) { const m = await this.meta(q); if (m) { t = m.t; a = m.a; du = du || m.d; } }
      const H = { 'user-agent': LRC_UA, 'lrclib-client': LRC_UA };
      let j = null;
      if (t && a) {
        const r = await fetch(`https://lrclib.net/api/get?track_name=${encodeURIComponent(Server.base(t))}&artist_name=${encodeURIComponent(Server.artist1(a))}${du ? `&duration=${du}` : ''}`, { headers: H });
        if (r.ok) j = await r.json();
      }
      if (!j || !(j.plainLyrics || j.instrumental)) {
        const r = await fetch(`https://lrclib.net/api/search?q=${encodeURIComponent(t && a ? `${Server.artist1(a)} ${Server.base(t)}` : q)}`, { headers: H });
        const list = r.ok ? await r.json() : [];
        const ok = Array.isArray(list) ? list.filter((x) => x && (x.plainLyrics || x.instrumental)) : [];
        j = ok.find((x) => !du || Math.abs((x.duration || 0) - du) <= 10) || ok[0] || null;
      }
      if (!j) return reply({ err: `Não achei a letra de “${(t || q).slice(0, 60)}” numa fonte grátis (LRCLIB).` });
      if (j.instrumental || !j.plainLyrics) return reply({ err: `“${clean(j.trackName, 60)}” é instrumental: não tem letra.` });
      return reply({ t: clean(j.trackName, 120), a: clean(j.artistName, 80), text: String(j.plainLyrics).slice(0, 12000), src: 'LRCLIB' });
    } catch (err) {
      console.warn('letra', String(err));
      return reply({ err: 'A fonte de letras (LRCLIB) não respondeu. Tente de novo.' });
    }
  }

  async altOf(ch, k) { // música atual não toca embutida (o dono bloqueou fora do YouTube): acha outra versão dela, até 5 tentativas
    const cur = ((s) => s.q[s.i])(this.mget(ch));
    const tried = cur && cur.k === k ? (Array.isArray(cur.x) ? cur.x : [cur.id]) : [];
    if (!tried.length || tried.length > 5) return null;
    try {
      const o = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${cur.id}`)}`);
      if (o.status === 400 || o.status === 404) return null; // o vídeo nem existe: pula, não adianta procurar outra versão
      const q = cur.t.replace(/[([][^)\]]*[)\]]/g, ' ');
      const meta = { t: cur.t, a: String(cur.a || '').replace(/\s+-\s+topic$/i, ''), d: cur.d || 0 }; // E1: a outra versão também é a original (sem fortnite, remix, cover...)
      const v = Server.rank(await this.search(tried.length % 2 ? cur.t : `${q} lyrics`), meta, `${cur.t} lyrics`).find((x) => !tried.includes(x.id)); // alterna: outros envios da música e a versão com letra
      return v ? { k, v, tried: [...tried, v.id] } : null;
    } catch { return null; }
  }

  // YouTube: busca (Data API, se tiver chave) e links (vídeo sem chave, pelo oEmbed; playlist só com chave)
  static parseYt(q) {
    if (!/youtu/i.test(q)) return null;
    let u;
    try { u = new URL(/^https?:\/\//i.test(q) ? q : `https://${q}`); } catch { return null; }
    const h = u.hostname.replace(/^(www|m|music)\./, '');
    if (!/^(youtube\.com|youtu\.be|youtube-nocookie\.com)$/.test(h)) return null;
    let v = u.searchParams.get('v') || '';
    if (h === 'youtu.be') v = u.pathname.slice(1, 12);
    const m = u.pathname.match(/^\/(shorts|embed|live|v)\/([A-Za-z0-9_-]{11})/);
    if (m) v = m[2];
    const list = u.searchParams.get('list') || '';
    return { v: YT_ID.test(v) ? v : '', list: /^[A-Za-z0-9_-]{10,64}$/.test(list) && !list.startsWith('RD') ? list : '' }; // RD = mix automático (não é lista de verdade)
  }
  static isoDur(s) { const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(s || ''); return m ? (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0) : 0; }
  async yt(path, params) {
    if (!this.env.YT_KEY) throw new Error('nokey');
    const u = new URL(`https://www.googleapis.com/youtube/v3/${path}`);
    for (const [k, v] of Object.entries({ ...params, key: this.env.YT_KEY })) u.searchParams.set(k, v);
    const r = await fetch(u);
    if (!r.ok) { console.warn('YouTube API', path, r.status, (await r.text()).slice(0, 300)); throw new Error(r.status === 403 ? 'cota' : `HTTP ${r.status}`); }
    return r.json();
  }
  async details(ids) { // título, canal, duração e se toca embutido (1 unidade da cota a cada 50 vídeos)
    const out = [];
    for (let i = 0; i < ids.length; i += 50) {
      const j = await this.yt('videos', { part: 'snippet,contentDetails,status', id: ids.slice(i, i + 50).join(','), maxResults: '50' });
      for (const v of j.items || []) {
        if (!v.snippet || (v.status && v.status.embeddable === false) || v.snippet.liveBroadcastContent === 'upcoming') continue;
        out.push({ id: v.id, t: v.snippet.title, a: v.snippet.channelTitle, d: Server.isoDur(v.contentDetails && v.contentDetails.duration) });
      }
    }
    const pos = new Map(ids.map((id, n) => [id, n]));
    return out.sort((a, b) => pos.get(a.id) - pos.get(b.id));
  }
  async resolve(q, first = SP_FIRST) { // -> { list, label, sp? } ou { err }
    if (!q) return { err: 'Diga o nome da música ou cole um link do YouTube.' };
    const link = Server.parseYt(q);
    const key = !!this.env.YT_KEY;
    try {
      const sp = Server.parseSp(q) || (Server.spShort(q) ? await Server.spUnshort(q) : null);
      if (sp) return await this.spotify(sp, first).catch((err) => { console.warn('Spotify', String(err)); return { err: SP_ERR }; });
      if (Server.spLike(q)) return { err: 'Cole o link de uma música, álbum ou playlist do Spotify (open.spotify.com/... ou spotify.link/...).' };
      if (link && link.list && !link.v) {
        if (!key) {
          const p = await Server.ytPublicList(link.list).catch(() => ({ list: [] }));
          if (p.list.length) return { list: p.list, label: p.title ? `“${clean(p.title, 60)}”` : 'uma playlist' };
          return { err: 'Para playlist sem a busca do YouTube, o app lista os vídeos pelo player.', needIds: link.list }; // plano B: o player lista
        }
        const ids = [];
        let page = '';
        for (let n = 0; n < 2; n++) {
          const j = await this.yt('playlistItems', { part: 'contentDetails', playlistId: link.list, maxResults: '50', ...(page ? { pageToken: page } : {}) });
          ids.push(...(j.items || []).map((x) => x.contentDetails && x.contentDetails.videoId).filter((v) => YT_ID.test(v || '')));
          page = j.nextPageToken || '';
          if (!page) break;
        }
        let title = '';
        try { const p = ((await this.yt('playlists', { part: 'snippet', id: link.list })).items || [])[0]; title = p ? p.snippet.title : ''; } catch { /* sem o nome: segue */ }
        const list = await this.details(ids);
        return list.length ? { list, label: title ? `“${clean(title, 60)}”` : 'uma playlist' } : { err: 'Essa playlist está vazia, é privada ou nada nela toca fora do YouTube.' };
      }
      if (link && link.v) {
        if (key) { const list = await this.details([link.v]); return list.length ? { list } : { err: 'Esse vídeo não existe ou não pode tocar fora do YouTube.' }; }
        const r = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${link.v}`)}`);
        if (r.status === 401 || r.status === 403) return { err: 'Esse vídeo não pode tocar fora do YouTube (o dono bloqueou).' };
        if (!r.ok) return { err: 'Esse vídeo não existe ou é privado.' };
        const j = await r.json();
        return { list: [{ id: link.v, t: j.title, a: j.author_name, d: 0 }] };
      }
      if (link) return { err: 'Não achei um vídeo nesse link do YouTube.' };
      const list = await this.song(q);
      return list.length ? { list: list.slice(0, 1) } : { err: `Nada encontrado para “${q.slice(0, 60)}”.` };
    } catch (err) {
      return { err: Server.ytErr(err) };
    }
  }
  static ytErr(err) {
    if (err.message === 'nokey') return 'A busca por nome está desligada no servidor. Cole o link do YouTube.';
    if (err.message === 'cota') return 'A busca do YouTube bateu o limite do dia. Cole o link do vídeo.';
    console.warn('YouTube', String(err));
    return 'O YouTube não respondeu. Tente de novo.';
  }
  async search(q) {
    const k = q.toLowerCase().replace(/\s+/g, ' ').trim();
    const hit = this.ytc.get(k);
    if (hit && Date.now() - hit.at < 3600000) return hit.list;
    let list;
    if (this.env.YT_KEY) {
      const j = await this.yt('search', { part: 'id', type: 'video', maxResults: '12', q: k, videoEmbeddable: 'true', regionCode: 'BR' });
      list = (await this.details((j.items || []).map((x) => x.id && x.id.videoId).filter((v) => YT_ID.test(v || '')))).filter((x) => x.d > 0);
    } else list = await Server.ytPublic(k);
    if (this.ytc.size > 200) this.ytc.clear();
    this.ytc.set(k, { at: Date.now(), list });
    return list;
  }
  static norm(x) { return String(x || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
  static base(t) { return String(t || '').replace(/[([][^)\]]*[)\]]/g, ' ').replace(/\s+-\s+.*$/, '').replace(/\s+/g, ' ').trim() || String(t || ''); } // sem (feat...), [..] e " - Remastered"
  static artist1(a) { return String(a || '').replace(/\u00a0/g, ' ').split(/\s*,\s*|\s+&\s+|\s+(?:feat\.?|ft\.?|featuring|Feat\.?|Ft\.?)\s+|\s+x\s+|\s+e\s+/)[0].trim(); } // 'Lil Nas X' fica inteiro
  static has(text, w) { return ` ${text} `.includes(` ${w} `); }
  static rank(list, meta, asked) { // a versão original na frente (nota maior); mantém todas (a Lista mostra o resto)
    const A = Server.norm(asked), an = Server.norm(Server.artist1(meta.a)), bt = Server.norm(Server.base(meta.t));
    const words = bt.split(' ').filter(Boolean);
    const score = (v, n) => {
      const T = Server.norm(v.t), C = Server.norm(v.a), Cj = C.replace(/ /g, '');
      const known = !!(an || meta.d); // sem o nome oficial: vale a ordem do YouTube (só tira as versões e ajuda o canal citado)
      let sc = (12 - Math.min(n, 12)) * (known ? 0.5 : 3); // ordem do YouTube desempata
      for (const w of BAD) if (Server.has(T, w) && !Server.has(A, w) && !Server.has(bt, w)) sc -= 100;
      for (const w of WANT) if (Server.has(A, w)) sc += Server.has(T, w) ? 30 : -30; // pediu a versão (live, remix, ao vivo...): ela na frente
      const topic = / topic$/.test(C), vevo = /vevo$/.test(Cj);
      const at = an.split(' ').filter((w) => w.length >= 3 && !['the', 'and', 'dos', 'das'].includes(w)), ct = C.replace(/ topic$/, '').split(' ').filter((w) => w.length >= 3);
      const own = !!an && (Cj === an.replace(/ /g, '') || C.startsWith(an) || Cj.startsWith(an.replace(/ /g, '')) || (at.length > 0 && ct.length > 0 && at.filter((w) => ct.includes(w)).length / Math.min(at.length, ct.length) >= 0.5)); // 'Antônio Carlos Jobim' = 'Tom Jobim'
      if (topic && (own || !an)) sc += 50; else if (vevo) sc += 35; else if (own) sc += 30; // Topic de outro artista = gravação de outro (não ganha)
      if (!(topic || vevo || own) && LYRIC.some((w) => Server.has(T, w) && !Server.has(A, w))) sc -= 40; // lyrics de canal qualquer
      if (/\b(official audio|audio oficial)\b/.test(T)) sc += 12; else if (/\b(official (music )?video|clipe oficial|video oficial|videoclipe oficial)\b/.test(T)) sc += 10; else if (/\b(official|oficial)\b/.test(T)) sc += 4;
      if (known) { if (bt && Server.has(T, bt)) sc += 15; else if (words.length) sc += (words.filter((w) => Server.has(T, w)).length / words.length) * 15 - 15; }
      if (an && !own && !Server.has(T, an) && !C.includes(an)) sc -= 10;
      if (C && C.replace(/ topic$/, '').split(' ').every((w) => Server.has(A, w))) sc += 15; // o pedido cita o canal (ex.: 'me at the zoo jawed') // nem o canal nem o título falam do artista
      if (meta.d > 0 && v.d > 0) { const df = Math.abs(v.d - meta.d); sc += df <= 15 ? 20 : df <= 30 ? 5 : df <= 90 ? -15 : -35; }
      return sc;
    };
    return list.map((v, n) => ({ v, s: score(v, n) })).sort((x, y) => y.s - x.s).map((x) => x.v);
  }
  async meta(q) { // nome digitado -> { t, a, d } oficiais (iTunes Search API, grátis, sem chave, ~20 por minuto); null se não bater
    const qn = Server.norm(q), key = `m:${qn}`;
    const hit = this.ytc.get(key);
    if (hit && Date.now() - hit.at < 86400000) return hit.list;
    let out = null;
    try {
      const r = await fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(q)}&entity=song&limit=10&country=BR`);
      const res = r.ok ? ((await r.json()).results || []).filter((x) => x.trackName && x.artistName) : [];
      const qt = qn.split(' ').filter(Boolean);
      const cand = res.map((x, n) => ({ x, n })).filter(({ x }) => qt.length && qt.every((w) => Server.has(Server.norm(`${x.trackName} ${x.artistName}`), w))); // todas as palavras do pedido
      if (cand.length) {
        const pts = new Map(); // o artista que mais aparece no topo é o dono da música (um remix dele também conta; o cover de outro não)
        for (const { x, n } of cand) { const k = Server.norm(Server.artist1(x.artistName)); pts.set(k, (pts.get(k) || 0) + 1 / (n + 1)); }
        const best = [...pts.entries()].sort((a, b) => b[1] - a[1])[0][0];
        const clean = cand.filter(({ x }) => !BAD.some((w) => Server.has(Server.norm(x.trackName), w) && !Server.has(qn, w)));
        const pick = (clean.find(({ x }) => Server.norm(Server.artist1(x.artistName)) === best) || clean[0] || cand[0]).x;
        out = { t: pick.trackName, a: Server.artist1(pick.artistName), d: Math.round((pick.trackTimeMillis || 0) / 1000) };
      }
    } catch (err) { console.warn('iTunes', String(err)); }
    if (this.ytc.size > 200) this.ytc.clear();
    this.ytc.set(key, { at: Date.now(), list: out });
    return out;
  }
  async song(q) { // nome -> resultados com a versão original na frente
    if (Server.parseYt(q)) return this.search(q);
    const m = await this.meta(q);
    if (!m) return Server.rank(await this.search(q), { t: q, a: '', d: 0 }, q);
    const list = await this.search(`${m.a} - ${Server.base(m.t)}`);
    return Server.rank(list, m, q);
  }
  static async innertube(path, body, retry = 1) { // a API pública que a própria página do YouTube usa (sem chave)
    const r = await fetch(`https://www.youtube.com/youtubei/v1/${path}?prettyPrint=false`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ context: { client: { clientName: 'WEB', clientVersion: '2.20251101.00.00', hl: 'pt', gl: 'BR' } }, ...body }),
    });
    if (!r.ok) { // S-0032: o YouTube às vezes recusa (403) uma busca que sai do Cloudflare; a 2ª tentativa sai por outro caminho
      if (retry > 0 && (r.status === 403 || r.status === 429 || r.status >= 500)) {
        await new Promise((ok) => setTimeout(ok, 300));
        if (path === 'search' && body.query) return Server.ytHtml(body.query); // busca: a 2ª tentativa vai pela página de resultados
        return Server.innertube(path, body, retry - 1);
      }
      throw new Error(`HTTP ${r.status}`);
    }
    return r.json();
  }
  static async ytHtml(q) { // página de resultados do YouTube (só vídeos): o mesmo formato (videoRenderer) dentro do ytInitialData
    const r = await fetch(`https://www.youtube.com/results?search_query=${encodeURIComponent(q)}&sp=EgIQAQ%253D%253D&hl=pt&gl=BR`, { headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36', 'accept-language': 'pt-BR' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const m = /var ytInitialData = (\{[\s\S]*?\});<\/script>/.exec(await r.text());
    if (!m) throw new Error('YouTube: página mudou');
    return JSON.parse(m[1]);
  }
  static ytItems(j, max) { // vídeos da resposta (formato antigo videoRenderer e o novo lockupViewModel); ao vivo (sem duração) fica de fora
    const out = [];
    const secs = (t) => String(t || '').split(':').reduce((a, x) => a * 60 + (Number(x) || 0), 0);
    const walk = (o) => {
      if (!o || typeof o !== 'object' || out.length >= max) return;
      const v = o.videoRenderer, l = o.lockupViewModel;
      if (v) {
        const d = secs(v.lengthText && v.lengthText.simpleText);
        if (YT_ID.test(v.videoId || '') && d > 0) out.push({ id: v.videoId, t: ((v.title && v.title.runs) || []).map((x) => x.text).join(''), a: (((v.ownerText && v.ownerText.runs) || [])[0] || {}).text || '', d });
        return;
      }
      if (l && l.contentType === 'LOCKUP_CONTENT_TYPE_VIDEO') {
        const m = (l.metadata && l.metadata.lockupMetadataViewModel) || {};
        const row = ((((m.metadata || {}).contentMetadataViewModel || {}).metadataRows || [])[0] || {}).metadataParts || [];
        const d = secs((/"text":"(\d+(?::\d+)+)"/.exec(JSON.stringify(l.contentImage || {})) || [])[1]);
        if (YT_ID.test(l.contentId || '') && d > 0) out.push({ id: l.contentId, t: (m.title && m.title.content) || '', a: ((row[0] || {}).text || {}).content || '', d });
        return;
      }
      for (const k in o) walk(o[k]);
    };
    walk(j);
    return out;
  }
  static async ytPublic(q) { return Server.ytItems(await Server.innertube('search', { query: q, params: 'EgIQAQ%3D%3D' }), 12); } // só vídeos
  static async ytPublicList(list) { // os primeiros 100 vídeos de uma playlist e o nome dela
    const j = await Server.innertube('browse', { browseId: `VL${list}` });
    return { list: Server.ytItems(j, 100), title: ((j.metadata || {}).playlistMetadataRenderer || {}).title || '' };
  }
  static parseSp(q) { // open.spotify.com/(intl-xx/)(embed/)(user/<x>/)track|album|playlist/<id> ou spotify:playlist:<id>
    const t = String(q || '').trim();
    const m = /^spotify:(?:user:[^:\s]+:)?(track|album|playlist):([A-Za-z0-9]{22})(?![A-Za-z0-9])/i.exec(t)
      || /^(?:https?:\/\/)?(?:open|play)\.spotify\.com\/(?:intl-[a-z]{2,3}(?:-[a-z0-9]{2,4})?\/)?(?:embed\/)?(?:user\/[^/?#\s]+\/)?(track|album|playlist)\/([A-Za-z0-9]{22})(?![A-Za-z0-9])/i.exec(t);
    return m ? { kind: m[1].toLowerCase(), id: m[2] } : null;
  }
  static spShort(q) { // link encurtado do app do Spotify (spotify.link/<x>, spotify.app.link/<x>)
    const m = /^(?:https?:\/\/)?((?:spotify\.link|spotify\.app\.link)\/[A-Za-z0-9_-]{4,40})(?:[/?#]\S*)?$/i.exec(String(q || '').trim());
    return m ? `https://${m[1]}` : '';
  }
  static spLike(q) { return /(^|[\s/.])spotify(:|\.com|\.link|\.app\.link)/i.test(q); }
  static async spUnshort(q) { // segue o redirecionamento (sem abrir a página do app) até achar o link open.spotify.com
    let u = Server.spShort(q);
    for (let n = 0; n < 2 && u; n++) {
      const r = await fetch(u, { redirect: 'manual' });
      const loc = r.headers.get('location') || '';
      const sp = Server.parseSp(loc);
      if (sp) return sp;
      u = /^https:\/\/(spotify\.link|spotify\.app\.link|open\.spotify\.com)\//i.test(loc) ? loc : '';
    }
    return null;
  }
  static async spTotal(sp) { // quantas músicas a playlist tem de verdade (a página pública diz; o embed só mostra 100)
    try {
      const r = await fetch(`https://open.spotify.com/${sp.kind}/${sp.id}`, { headers: { 'user-agent': 'Mozilla/5.0', 'accept-language': 'pt-BR' } });
      const m = r.ok && /<meta name="music:song_count" content="(\d+)"/.exec(await r.text());
      return m ? Number(m[1]) : 0;
    } catch { return 0; }
  }
  async spFind(part) { // cada faixa (nome + 1º artista) achada pela busca do YouTube de sempre; a que não achou fica de fora
    const found = await Promise.all(part.map((x) => {
      const a = Server.artist1(x.a);
      const q = a ? `${a} - ${Server.base(x.t)}` : Server.base(x.t); // E1: 'artista - título' e a versão original na frente
      return this.search(q).then((l) => Server.rank(l, { t: x.t, a, d: x.d || 0 }, `${x.t} ${x.a}`)[0] || null, (err) => { console.warn('Spotify busca', q.slice(0, 60), String(err)); return null; });
    }));
    return found.filter(Boolean);
  }
  async spotify(sp, first = SP_FIRST) { // -> { list, label, sp } ou { err }: lê só nome e artista (página pública do embed)
    const r = await fetch(`https://open.spotify.com/embed/${sp.kind}/${sp.id}`, { headers: { 'user-agent': 'Mozilla/5.0', 'accept-language': 'pt-BR' } });
    if (r.status === 404) return { err: 'Esse link do Spotify não existe ou é privado.' };
    if (!r.ok) throw new Error(`Spotify HTTP ${r.status}`);
    const m = /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/.exec(await r.text());
    const pp = m && ((JSON.parse(m[1]).props || {}).pageProps || {});
    if (pp && (pp.status === 404 || (!pp.state && pp.title))) return { err: 'Esse link do Spotify não existe ou é privado.' }; // apagada, privada ou id errado
    const e = pp && ((pp.state || {}).data || {}).entity;
    if (!e) throw new Error('Spotify: página mudou');
    const one = (x) => String(x || '').replace(/\u00a0/g, ' ').trim();
    const sec = (ms) => (Number.isFinite(ms) && ms > 0 ? Math.round(ms / 1000) : 0);
    const tracks = (sp.kind === 'track' ? [{ t: e.name || e.title, a: (e.artists || []).map((x) => x.name).join(', '), d: sec(e.duration && (e.duration.totalMilliseconds || e.duration)) }]
      : (e.trackList || []).map((x) => ({ t: x.title, a: x.subtitle, d: sec(x.duration) }))).map((x) => ({ t: one(x.t), a: one(x.a), d: x.d })).filter((x) => x.t); // tocável ou não no Spotify: o som vem do YouTube
    const name = clean(e.name || e.title, 60);
    if (!tracks.length) return { err: 'Essa playlist do Spotify está vazia.' };
    if (sp.kind === 'track') {
      const list = await this.spFind(tracks);
      return list.length ? { list } : { err: 'Não achei essa música do Spotify no YouTube.' };
    }
    const want = tracks.slice(0, SP_MAX);
    const totalP = tracks.length >= SP_MAX ? Server.spTotal(sp) : Promise.resolve(0); // junto com as primeiras buscas
    let list = [], n = 0, miss = 0;
    while (n < want.length && (n < first || (!list.length && n < Math.max(first, SP_FIRST * 3)))) { // as primeiras (se nenhuma achou, tenta mais umas)
      const part = want.slice(n, n + first);
      const got = await this.spFind(part);
      list = list.concat(got);
      miss += part.length - got.length;
      n += part.length;
    }
    const rest = want.slice(n);
    const total = Math.max(tracks.length, await totalP);
    if (!list.length && !rest.length) return { err: 'Não achei essas músicas do Spotify no YouTube.' };
    if (!list.length) return { err: 'Não achei as primeiras músicas dessa playlist no YouTube.' };
    return { list, label: `“${name}”`, more: rest.length, total, sp: { rest, total, want: want.length, miss } };
  }
  spPending() { return this.sql.exec('SELECT 1 FROM spq LIMIT 1').toArray().length > 0; }
  async spStep() { // 1 volta do alarme: acha mais SP_STEP faixas da playlist mais antiga e põe logo depois das dela na fila
    const r0 = this.sql.exec('SELECT id, ch, j FROM spq ORDER BY id LIMIT 1').toArray()[0];
    if (!r0) return false;
    const job = JSON.parse(r0.j);
    const part = job.rest.splice(0, SP_STEP);
    const found = await this.spFind(part);
    if (!this.sql.exec('SELECT 1 FROM spq WHERE id = ?', r0.id).toArray().length) return this.spPending(); // /stop no meio: para
    const s = this.mget(r0.ch); // lido depois do await
    const add = found.map((x) => this.item(x, job.by)).filter(Boolean).slice(0, Math.max(0, MAX_Q - s.q.length));
    job.miss += part.length - found.length;
    const full = s.q.length + add.length >= MAX_Q && (job.rest.length > 0 || add.length < found.length);
    if (add.length) {
      const p = s.q.findIndex((x) => x.k === job.after);
      const idle = !s.q[s.i];
      const at = p >= 0 && p >= s.i ? p + 1 : s.q.length; // logo depois das que já entraram (o que outros pediram depois fica depois)
      s.q.splice(at, 0, ...add);
      if (idle) Server.start(s, at, Date.now()); // a fila tinha acabado: volta a tocar
      job.after = add[add.length - 1].k;
      job.added += add.length;
      this.mset(r0.ch, s);
    }
    if (job.rest.length && !full) { this.sql.exec('UPDATE spq SET j = ? WHERE id = ?', JSON.stringify(job), r0.id); return true; }
    this.sql.exec('DELETE FROM spq WHERE id = ?', r0.id);
    this.djSay(job.tc, `Pronto: ${job.added} músicas de ${job.label} na fila.${job.miss ? ` ${job.miss} não achei no YouTube.` : ''}${full ? ` A fila chegou a ${MAX_Q}: o resto ficou de fora.` : ''}`);
    return this.spPending();
  }
  async oembedAll(ids) { // playlist sem a Data API: títulos pelo oEmbed (até 40 por vez, limite de subpedidos do plano grátis)
    const one = async (id) => {
      const r = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}`);
      if (!r.ok) return null; // 401/403 = não toca embutido; 404 = removido ou privado
      const j = await r.json();
      return { id, t: j.title, a: j.author_name, d: 0 };
    };
    return (await Promise.all(ids.slice(0, 40).map((id) => one(id).catch(() => null)))).filter(Boolean);
  }
  async ytSearch(ws, att, d, now) { // { t:'yt', q, n } ou { t:'yt', ids, n } -> { t:'ytres', n, list, err, needIds }
    if (!att.uid || (typeof d.q !== 'string' && !Array.isArray(d.ids))) return;
    const reply = (r) => ws.send(JSON.stringify({ t: 'ytres', n: d.n, list: r.list || [], label: r.label || '', err: r.err || '', needIds: r.needIds || '', more: r.more || 0, total: r.total || 0, link: r.link || '' }));
    if (Array.isArray(d.ids)) {
      const ids = [...new Set(d.ids.filter((v) => typeof v === 'string' && YT_ID.test(v)))];
      const list = await this.oembedAll(ids);
      return reply(list.length ? { list, label: `uma playlist${ids.length > 40 ? ' (os 40 primeiros)' : ''}` } : { err: 'Nada nessa playlist toca fora do YouTube.' });
    }
    if (now - (att.yt || 0) < 500) return reply({ err: 'Calma: uma busca por vez.' });
    att.yt = now;
    ws.serializeAttachment(att);
    const q = clean(d.q, 200);
    if (!q) return reply({});
    if (Server.parseYt(q) || Server.parseSp(q) || Server.spShort(q)) { const r = await this.resolve(q, SP_FIRST * 2); return reply(r.sp ? { list: r.list, label: r.label, more: r.more, total: r.total, link: q } : r); }
    try { reply({ list: await this.song(q) }); } catch (err) { reply({ err: Server.ytErr(err) }); }
  }

  avOk(v) { // avatar enviado só vale se a imagem existe de verdade (e foi enviada como avatar)
    const a = avOf(v);
    return a.startsWith('u-') && !(/^u-[a-z2-7]{20}$/.test(a) && this.sql.exec('SELECT 1 FROM media WHERE id = ? AND av = 1', a.slice(2)).toArray().length) ? '' : a;
  }

  async hello(ws, att, d) { // { t:'me', key, name, av, st }: quem é esta conexão e como quer aparecer
    if (typeof d.key !== 'string' || !/^[a-f0-9]{32,64}$/.test(d.key)) return;
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`bagrenation:${d.key}`)));
    const uid = [...hash.slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
    if (att.uid && att.uid !== uid) return; // a conexão não troca de dono
    const first = !att.uid;
    att.uid = uid;
    att.st = ST.includes(d.st) ? d.st : 'on';
    ws.serializeAttachment(att);
    this.sql.exec('INSERT INTO members (uid, name, av, seen, since) VALUES (?, ?, ?, ?, ?) ON CONFLICT(uid) DO UPDATE SET name = excluded.name, av = excluded.av, seen = excluded.seen',
      uid, clean(d.name, 24) || 'Visitante', this.avOk(d.av), Date.now(), Date.now());
    if (typeof d.bio === 'string') this.sql.exec('UPDATE members SET bio = ? WHERE uid = ?', bioClean(d.bio), uid); // só quem mandou a bio mexe nela (cliente antigo não apaga)
    if (first) ws.send(JSON.stringify({ t: 'you', uid }));
    this.presence(uid);
    if (first && !(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(Date.now() + 60000);
  }

  react(ws, att, d, now) { // liga/desliga a minha reação com um emoji da lista
    if (!att.uid || !Number.isInteger(d.id) || !EMOJIS.has(d.e) || now - (att.rt || 0) < 120) return;
    att.rt = now;
    ws.serializeAttachment(att);
    const r0 = this.sql.exec('SELECT reacts FROM msgs WHERE id = ?', d.id).toArray()[0];
    if (!r0) return;
    const r = r0.reacts ? JSON.parse(r0.reacts) : {};
    const list = r[d.e] || [];
    if (list.includes(att.uid)) r[d.e] = list.filter((u) => u !== att.uid);
    else r[d.e] = [...list, att.uid].slice(-100);
    if (!r[d.e].length) delete r[d.e];
    this.sql.exec('UPDATE msgs SET reacts = ? WHERE id = ?', Object.keys(r).length ? JSON.stringify(r) : null, d.id);
    this.broadcast({ t: 'react', id: d.id, reacts: r });
  }

  change(ws, att, d, now) { // editar ou apagar a própria mensagem (dona = mesmo uid)
    if (!att.uid || !Number.isInteger(d.id) || now - (att.et || 0) < 250) return; // relógio próprio: editar não segura a próxima mensagem
    att.et = now;
    ws.serializeAttachment(att);
    const r = this.sql.exec('SELECT uid, media FROM msgs WHERE id = ?', d.id).toArray()[0];
    if (!r || r.uid !== att.uid) return;
    if (d.t === 'del') { this.remove(d.id, r.media); return; }
    const text = clean(d.text, 2000);
    if (!text && !r.media) return;
    this.sql.exec('UPDATE msgs SET text = ?, edited = ? WHERE id = ?', text, now, d.id);
    this.broadcast({ t: 'edit', id: d.id, text, edited: now });
  }

  remove(id, mediaJson) {
    const media = mediaJson ? JSON.parse(mediaJson) : null;
    if (media) { this.sql.exec('DELETE FROM chunks WHERE id = ?', media.id); this.sql.exec('DELETE FROM media WHERE id = ?', media.id); }
    this.sql.exec('DELETE FROM msgs WHERE id = ?', id);
    this.broadcast({ t: 'del', id });
  }

  webSocketClose(ws, code) {
    const a = ws.deserializeAttachment() || {};
    try { ws.close(code === 1005 ? 1000 : code); } catch { /* já fechou */ }
    this.gone(ws, a);
  }
  webSocketError(ws) { this.gone(ws, ws.deserializeAttachment() || {}); }

  async upload(req, origin, av) {
    const ip = req.headers.get('CF-Connecting-IP') || '?';
    const now = Date.now();
    const recent = (this.upAt.get(ip) || []).filter((t) => now - t < 60000);
    if (recent.length >= 20) return json({ error: 'muitos envios, espere um minuto' }, 429, origin);
    const mime = (req.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
    const max = av ? MAX_AV : MAX_FILE;
    if (!(av ? AV_MIME : MIME).has(mime)) return json({ error: 'tipo de arquivo não aceito (imagem, GIF ou vídeo mp4/webm)' }, 415, origin);
    if (Number(req.headers.get('Content-Length') || 0) > max) return json({ error: av ? 'imagem maior que 5 MB' : 'arquivo maior que 25 MB' }, 413, origin);
    const buf = new Uint8Array(await req.arrayBuffer());
    if (!buf.length) return json({ error: 'arquivo vazio' }, 400, origin);
    if (buf.length > max) return json({ error: av ? 'imagem maior que 5 MB' : 'arquivo maior que 25 MB' }, 413, origin);
    recent.push(now);
    this.upAt.set(ip, recent);
    const id = [...crypto.getRandomValues(new Uint8Array(20))].map((b) => 'abcdefghijklmnopqrstuvwxyz234567'[b & 31]).join('');
    this.ctx.storage.transactionSync(() => {
      for (let n = 0, off = 0; off < buf.length; n++, off += CHUNK) this.sql.exec('INSERT INTO chunks (id, n, data) VALUES (?, ?, ?)', id, n, buf.subarray(off, off + CHUNK));
      this.sql.exec('INSERT INTO media (id, mime, size, ts, av) VALUES (?, ?, ?, ?, ?)', id, mime, buf.length, now, av ? 1 : 0);
    });
    this.prune();
    return json({ id, mime, size: buf.length }, 200, origin);
  }

  prune() { // passou do teto: apaga os arquivos mais antigos (a mensagem fica, com "arquivo expirou")
    let total = this.sql.exec('SELECT COALESCE(SUM(size), 0) AS s FROM media WHERE av = 0').one().s;
    while (total > MAX_TOTAL) {
      const old = this.sql.exec('SELECT id, size FROM media WHERE av = 0 ORDER BY ts LIMIT 1').toArray()[0];
      if (!old) break;
      this.sql.exec('DELETE FROM chunks WHERE id = ?', old.id);
      this.sql.exec('DELETE FROM media WHERE id = ?', old.id);
      total -= old.size;
    }
  }

  media(req, id) {
    const r0 = this.sql.exec('SELECT mime, size FROM media WHERE id = ?', id).toArray()[0];
    if (!r0) return new Response('arquivo expirou', { status: 404 });
    let start = 0, end = r0.size - 1, status = 200;
    const r = (req.headers.get('Range') || '').match(/^bytes=(\d*)-(\d*)$/);
    if (r && (r[1] || r[2])) {
      if (r[1]) { start = Number(r[1]); if (r[2]) end = Math.min(Number(r[2]), end); } else start = Math.max(0, r0.size - Number(r[2]));
      if (start > end) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${r0.size}` } });
      status = 206;
    }
    const out = new Uint8Array(end - start + 1);
    const rows = this.sql.exec('SELECT n, data FROM chunks WHERE id = ? AND n BETWEEN ? AND ? ORDER BY n', id, Math.floor(start / CHUNK), Math.floor(end / CHUNK)).toArray();
    for (const { n, data } of rows) {
      const base = n * CHUNK;
      const part = new Uint8Array(data).subarray(Math.max(0, start - base), Math.min(CHUNK, end - base + 1));
      out.set(part, Math.max(0, base - start));
    }
    return new Response(out, { status, headers: {
      'Content-Type': r0.mime, 'Content-Length': String(out.length), 'Accept-Ranges': 'bytes',
      ...(status === 206 ? { 'Content-Range': `bytes ${start}-${end}/${r0.size}` } : {}),
      'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'", 'Cross-Origin-Resource-Policy': 'cross-origin', 'Access-Control-Allow-Origin': '*',
    } });
  }

  async del(req) {
    const key = this.env.ADMIN_KEY;
    if (!key || req.method !== 'POST' || req.headers.get('Authorization') !== `Bearer ${key}`) return json({ error: 'sem permissão' }, 403);
    const id = Number(new URL(req.url).searchParams.get('id'));
    const r = this.sql.exec('SELECT media FROM msgs WHERE id = ?', id).toArray()[0];
    if (!r) return json({ error: 'não existe' }, 404);
    this.remove(id, r.media);
    return json({ ok: true }, 200);
  }
}
