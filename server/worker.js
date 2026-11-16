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
// (id 'voz') é o canal das versões antigas. Quem criou um canal (ou quem tem a ADMIN_KEY) renomeia e apaga.
// Mensagens de outros canais só vão para clientes novos (que mandam { t:'v' }): o app antigo as mostraria no #chat.

const ORIGINS = [/^https:\/\/alissonlittig\.github\.io$/, /^https?:\/\/tauri\.localhost$/, /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/];
const MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'video/mp4', 'video/webm', 'video/quicktime']);
const MAX_FILE = 25 * 1024 * 1024;
const CHUNK = 1024 * 1024;              // SQLite do Durable Object aceita até 2 MB por valor
const MAX_TOTAL = 3 * 1024 ** 3;        // plano grátis = 5 GB; acima de 3 GB os arquivos mais antigos saem
const HISTORY = 150;
const STALE = 150000;                   // conexão identificada sem sinal (ping a cada 25 s) há 150 s = caiu sem avisar
const EMOJIS = new Set(['👍', '❤️', '😂', '😮', '😢', '😡', '🔥', '🎉', '👀', '💀', '🐟', '🙏', '👏', '🤡', '💯', '✅']);
const ST = ['on', 'idle', 'off'];       // off = invisível (para os outros, igual a offline)
const FIXED = { chat: 'text', voz: 'voice' }; // canais de sempre: renomeia (moderação), não apaga
const MAX_CHANS = 30;
const chanName = (v, kind) => { const n = clean(v, 32); return kind === 'text' ? n.toLowerCase().replace(/\s+/g, '-') : n; };
const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, max);
const avOf = (v) => (/^[a-z0-9-]{0,24}$/.test(v || '') ? v || '' : '');
const row = (r) => ({ ...r, media: r.media ? JSON.parse(r.media) : null, reply: r.reply ? JSON.parse(r.reply) : null, reacts: r.reacts ? JSON.parse(r.reacts) : null });

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
    const m = url.pathname.match(/^\/s\/([a-z0-9-]{1,40})\/(ws|up|del|m\/[a-z0-9]{20})$/);
    if (!m) return new Response('BAGRENATION chat', { status: url.pathname === '/' ? 200 : 404 });
    const write = m[2] === 'ws' || m[2] === 'up';
    if (write && !okOrigin) return json({ error: 'origem não autorizada' }, 403);
    const stub = env.SERVER.get(env.SERVER.idFromName(m[1]));
    const h = new Headers(req.headers); // set (não append): o cliente não consegue injetar a rota nem a origem
    h.set('X-Route', m[2]);
    h.set('X-Ok-Origin', okOrigin);
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
      INSERT OR IGNORE INTO chans (id, kind, name, uid, pos, ts) VALUES ('chat', 'text', 'chat', NULL, 0, 0), ('voz', 'voice', 'Canal de voz', NULL, 0, 0);`);
    // migração S-1357: só acrescenta colunas (nada é apagado); mensagens antigas ficam com uid vazio
    const cols = new Set(this.sql.exec('PRAGMA table_info(msgs)').toArray().map((c) => c.name));
    for (const [c, type] of [['uid', 'TEXT'], ['edited', 'INTEGER'], ['reply', 'TEXT'], ['reacts', 'TEXT']]) {
      if (!cols.has(c)) this.sql.exec(`ALTER TABLE msgs ADD COLUMN ${c} ${type}`);
    }
    if (!cols.has('ch')) { // migração S-1363: só acrescenta; tudo o que já existe é do #chat
      this.sql.exec('ALTER TABLE msgs ADD COLUMN ch TEXT');
      this.sql.exec("UPDATE msgs SET ch = 'chat' WHERE ch IS NULL");
    }
    this.sql.exec('CREATE INDEX IF NOT EXISTS msgs_ch ON msgs (ch, id)');
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong')); // responde sem acordar o objeto
    this.upAt = new Map(); // ip -> últimos envios (limite simples, some quando o objeto hiberna)
    this.shown = new Map(); // uid -> último estado avisado (some ao hibernar: no pior caso repete um aviso igual)
  }

  async fetch(req) {
    const route = req.headers.get('X-Route');
    const origin = req.headers.get('X-Ok-Origin');
    if (route === 'ws') {
      if (req.headers.get('Upgrade') !== 'websocket') return new Response('esperava WebSocket', { status: 426 });
      const [client, server] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ at: 0, since: Date.now() });
      server.send(JSON.stringify({ t: 'hist', list: this.history() }));
      server.send(JSON.stringify({ t: 'members', list: this.members() }));
      server.send(JSON.stringify({ t: 'chans', list: this.chans() }));
      return new Response(null, { status: 101, webSocket: client });
    }
    if (route === 'up') return this.upload(req, origin);
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
      if (ws === skip || (onlyNew && !(ws.deserializeAttachment() || {}).c2)) continue;
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
  chan(ws, att, d, now) { // { t:'chan', op:'add'|'ren'|'del', kind, id, name, adm? }
    const no = (text) => ws.send(JSON.stringify({ t: 'err', text }));
    if (!att.uid) return no('Espere o chat conectar e tente de novo.');
    if (now - (att.ct || 0) < 800) return no('Calma: um canal por vez.');
    att.ct = now;
    ws.serializeAttachment(att);
    const admin = !!this.env.ADMIN_KEY && typeof d.adm === 'string' && d.adm === this.env.ADMIN_KEY;
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
    if (c.uid !== att.uid && !admin) return no(d.adm ? 'Chave de moderação errada.' : 'Só quem criou o canal (ou a moderação) pode mudar ele.');
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
    return this.sql.exec('SELECT uid, name, av, seen FROM members ORDER BY seen DESC LIMIT 300').toArray()
      .map((m) => ({ ...m, st: live.get(m.uid) || 'off' }));
  }
  presence(uid, skip) { // avisa todo mundo se o estado público (ou nome/avatar) dessa pessoa mudou
    const m = this.sql.exec('SELECT uid, name, av, seen FROM members WHERE uid = ?', uid).toArray()[0];
    if (!m) return;
    const st = this.live(skip).get(uid) || 'off';
    const key = `${st}|${m.name}|${m.av}`;
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
    if (left) await this.ctx.storage.setAlarm(now + 60000);
  }

  async webSocketMessage(ws, raw) {
    let d;
    try { d = JSON.parse(raw); } catch { return; }
    if (!d || typeof d !== 'object') return;
    if (d.t === 'more' && Number.isInteger(d.before)) {
      const ch = this.textChan(d.ch);
      if (ch) ws.send(JSON.stringify({ t: 'old', ch, list: this.history(d.before, ch) }));
      return;
    }
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
    if (d.t === 'edit' || d.t === 'del') return this.change(ws, att, d, now);
    if (d.t !== 'msg') return;
    const ch = this.textChan(d.ch);
    if (!ch) return; // canal apagado
    if (now - (att.at || 0) < 250) return; // no máximo 4 por segundo por conexão
    att.at = now;
    ws.serializeAttachment(att);
    const name = clean(d.name, 24) || 'Visitante';
    const av = avOf(d.av);
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

  async hello(ws, att, d) { // { t:'me', key, name, av, st }: quem é esta conexão e como quer aparecer
    if (typeof d.key !== 'string' || !/^[a-f0-9]{32,64}$/.test(d.key)) return;
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`bagrenation:${d.key}`)));
    const uid = [...hash.slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
    if (att.uid && att.uid !== uid) return; // a conexão não troca de dono
    const first = !att.uid;
    att.uid = uid;
    att.st = ST.includes(d.st) ? d.st : 'on';
    ws.serializeAttachment(att);
    this.sql.exec('INSERT INTO members (uid, name, av, seen) VALUES (?, ?, ?, ?) ON CONFLICT(uid) DO UPDATE SET name = excluded.name, av = excluded.av, seen = excluded.seen',
      uid, clean(d.name, 24) || 'Visitante', avOf(d.av), Date.now());
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

  async upload(req, origin) {
    const ip = req.headers.get('CF-Connecting-IP') || '?';
    const now = Date.now();
    const recent = (this.upAt.get(ip) || []).filter((t) => now - t < 60000);
    if (recent.length >= 20) return json({ error: 'muitos envios, espere um minuto' }, 429, origin);
    const mime = (req.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
    if (!MIME.has(mime)) return json({ error: 'tipo de arquivo não aceito (imagem, GIF ou vídeo mp4/webm)' }, 415, origin);
    if (Number(req.headers.get('Content-Length') || 0) > MAX_FILE) return json({ error: 'arquivo maior que 25 MB' }, 413, origin);
    const buf = new Uint8Array(await req.arrayBuffer());
    if (!buf.length) return json({ error: 'arquivo vazio' }, 400, origin);
    if (buf.length > MAX_FILE) return json({ error: 'arquivo maior que 25 MB' }, 413, origin);
    recent.push(now);
    this.upAt.set(ip, recent);
    const id = [...crypto.getRandomValues(new Uint8Array(20))].map((b) => 'abcdefghijklmnopqrstuvwxyz234567'[b & 31]).join('');
    this.ctx.storage.transactionSync(() => {
      for (let n = 0, off = 0; off < buf.length; n++, off += CHUNK) this.sql.exec('INSERT INTO chunks (id, n, data) VALUES (?, ?, ?)', id, n, buf.subarray(off, off + CHUNK));
      this.sql.exec('INSERT INTO media (id, mime, size, ts) VALUES (?, ?, ?, ?)', id, mime, buf.length, now);
    });
    this.prune();
    return json({ id, mime, size: buf.length }, 200, origin);
  }

  prune() { // passou do teto: apaga os arquivos mais antigos (a mensagem fica, com "arquivo expirou")
    let total = this.sql.exec('SELECT COALESCE(SUM(size), 0) AS s FROM media').one().s;
    while (total > MAX_TOTAL) {
      const old = this.sql.exec('SELECT id, size FROM media ORDER BY ts LIMIT 1').toArray()[0];
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
