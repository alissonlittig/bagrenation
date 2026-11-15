// BAGRENATION · chat de texto permanente (Cloudflare Worker + Durable Object com SQLite, plano grátis).
// Um Durable Object por servidor (o fixo é "bagrenation"; os testes usam outro nome e não sujam o histórico).
//   GET  /s/<srv>/ws          WebSocket: histórico ao conectar + mensagens novas em tempo real
//   POST /s/<srv>/up          envia um arquivo (imagem, GIF ou vídeo) e devolve { id, mime, size }
//   GET  /s/<srv>/m/<id>      devolve o arquivo (com Range, para o vídeo poder avançar)
//   POST /s/<srv>/del?id=N    apaga uma mensagem (moderação: Authorization: Bearer <ADMIN_KEY>)
// Escrever exige Origin do site ou do app: não é segredo (dá para forjar fora do navegador), só impede
// que outra página use o chat. Moderação de verdade = ADMIN_KEY, guardada como secret do Worker.

const ORIGINS = [/^https:\/\/alissonlittig\.github\.io$/, /^https?:\/\/tauri\.localhost$/, /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/];
const MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'video/mp4', 'video/webm', 'video/quicktime']);
const MAX_FILE = 25 * 1024 * 1024;
const CHUNK = 1024 * 1024;              // SQLite do Durable Object aceita até 2 MB por valor
const MAX_TOTAL = 3 * 1024 ** 3;        // plano grátis = 5 GB; acima de 3 GB os arquivos mais antigos saem
const HISTORY = 150;
const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, max);

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
      CREATE TABLE IF NOT EXISTS chunks (id TEXT NOT NULL, n INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (id, n));`);
    this.upAt = new Map(); // ip -> últimos envios (limite simples, some quando o objeto hiberna)
  }

  async fetch(req) {
    const route = req.headers.get('X-Route');
    const origin = req.headers.get('X-Ok-Origin');
    if (route === 'ws') {
      if (req.headers.get('Upgrade') !== 'websocket') return new Response('esperava WebSocket', { status: 426 });
      const [client, server] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ at: 0 });
      server.send(JSON.stringify({ t: 'hist', list: this.history() }));
      return new Response(null, { status: 101, webSocket: client });
    }
    if (route === 'up') return this.upload(req, origin);
    if (route === 'del') return this.del(req);
    return this.media(req, route.slice(2));
  }

  history(before) {
    const rows = before
      ? this.sql.exec('SELECT * FROM msgs WHERE id < ? ORDER BY id DESC LIMIT ?', before, HISTORY).toArray()
      : this.sql.exec('SELECT * FROM msgs ORDER BY id DESC LIMIT ?', HISTORY).toArray();
    return rows.reverse().map((r) => ({ ...r, media: r.media ? JSON.parse(r.media) : null }));
  }

  broadcast(obj) {
    const s = JSON.stringify(obj);
    for (const ws of this.ctx.getWebSockets()) { try { ws.send(s); } catch { /* fechando */ } }
  }

  async webSocketMessage(ws, raw) {
    let d;
    try { d = JSON.parse(raw); } catch { return; }
    if (!d || typeof d !== 'object') return;
    if (d.t === 'more' && Number.isInteger(d.before)) { ws.send(JSON.stringify({ t: 'old', list: this.history(d.before) })); return; }
    if (d.t !== 'msg') return;
    const att = ws.deserializeAttachment() || { at: 0 };
    const now = Date.now();
    if (now - att.at < 250) return; // no máximo 4 por segundo por conexão
    ws.serializeAttachment({ at: now });
    const name = clean(d.name, 24) || 'Visitante';
    const av = /^[a-z0-9-]{0,24}$/.test(d.av || '') ? d.av || '' : '';
    const text = clean(d.text, 2000);
    let media = null;
    if (d.media && typeof d.media === 'object' && /^[a-z0-9]{20}$/.test(d.media.id)) {
      const row = this.sql.exec('SELECT mime, size FROM media WHERE id = ?', d.media.id).toArray()[0];
      if (row) {
        const dim = (v) => (Number.isInteger(v) && v > 0 && v <= 20000 ? v : 0);
        media = { id: d.media.id, mime: row.mime, size: row.size, w: dim(d.media.w), h: dim(d.media.h), name: clean(d.media.name, 80) };
      }
    }
    if (!text && !media) return;
    const id = this.sql.exec('INSERT INTO msgs (ts, name, av, text, media) VALUES (?, ?, ?, ?, ?) RETURNING id',
      now, name, av, text, media ? JSON.stringify(media) : null).one().id;
    this.broadcast({ t: 'msg', m: { id, ts: now, name, av, text, media }, nonce: typeof d.nonce === 'string' ? d.nonce.slice(0, 40) : undefined });
  }

  webSocketClose(ws, code) { try { ws.close(code === 1005 ? 1000 : code); } catch { /* já fechou */ } }
  webSocketError() {}

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
    const row = this.sql.exec('SELECT mime, size FROM media WHERE id = ?', id).toArray()[0];
    if (!row) return new Response('arquivo expirou', { status: 404 });
    let start = 0, end = row.size - 1, status = 200;
    const r = (req.headers.get('Range') || '').match(/^bytes=(\d*)-(\d*)$/);
    if (r && (r[1] || r[2])) {
      if (r[1]) { start = Number(r[1]); if (r[2]) end = Math.min(Number(r[2]), end); } else start = Math.max(0, row.size - Number(r[2]));
      if (start > end) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${row.size}` } });
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
      'Content-Type': row.mime, 'Content-Length': String(out.length), 'Accept-Ranges': 'bytes',
      ...(status === 206 ? { 'Content-Range': `bytes ${start}-${end}/${row.size}` } : {}),
      'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'", 'Cross-Origin-Resource-Policy': 'cross-origin', 'Access-Control-Allow-Origin': '*',
    } });
  }

  async del(req) {
    const key = this.env.ADMIN_KEY;
    if (!key || req.method !== 'POST' || req.headers.get('Authorization') !== `Bearer ${key}`) return json({ error: 'sem permissão' }, 403);
    const id = Number(new URL(req.url).searchParams.get('id'));
    const row = this.sql.exec('SELECT media FROM msgs WHERE id = ?', id).toArray()[0];
    if (!row) return json({ error: 'não existe' }, 404);
    const media = row.media ? JSON.parse(row.media) : null;
    if (media) { this.sql.exec('DELETE FROM chunks WHERE id = ?', media.id); this.sql.exec('DELETE FROM media WHERE id = ?', media.id); }
    this.sql.exec('DELETE FROM msgs WHERE id = ?', id);
    this.broadcast({ t: 'del', id });
    return json({ ok: true }, 200);
  }
}
