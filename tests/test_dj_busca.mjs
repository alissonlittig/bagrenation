// S-1566: busca do Bagre DJ (YouTube Data API v3) com respostas simuladas, sem chave de verdade e sem rede.
// Confere: links (vídeo, youtu.be, shorts, playlist, mix), duração ISO 8601, busca por nome (vídeo que não toca
// embutido e live sem duração ficam de fora), cache, playlist com 2 páginas, sem chave = mensagem clara, cota estourada.
// Uso: node tests/test_dj_busca.mjs
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = mkdtempSync(join(tmpdir(), 'bagre-dj-'));
const file = join(dir, 'worker.mjs');
writeFileSync(file, readFileSync(new URL('../server/worker.js', import.meta.url), 'utf8'));
const { Server } = await import(pathToFileURL(file).href);

const P = Server.parseYt;
assert.deepEqual(P('https://www.youtube.com/watch?v=aqz-KE-bpKQ'), { v: 'aqz-KE-bpKQ', list: '' });
assert.deepEqual(P('youtu.be/jNQXAC9IVRw?t=3'), { v: 'jNQXAC9IVRw', list: '' });
assert.deepEqual(P('https://m.youtube.com/shorts/abcdefghijk'), { v: 'abcdefghijk', list: '' });
assert.deepEqual(P('https://music.youtube.com/playlist?list=PL6B3937A5D230E335'), { v: '', list: 'PL6B3937A5D230E335' });
assert.deepEqual(P('https://www.youtube.com/watch?v=aqz-KE-bpKQ&list=RDaqz-KE-bpKQ'), { v: 'aqz-KE-bpKQ', list: '' }); // mix automático
assert.equal(P('linkin park numb'), null);
assert.equal(P('https://evil.com/?v=aqz-KE-bpKQ&youtube.com'), null);
assert.equal(Server.isoDur('PT3M33S'), 213);
assert.equal(Server.isoDur('PT1H2M'), 3720);
assert.equal(Server.isoDur('P0D'), 0);

let calls = [];
const VIDEOS = {
  aaaaaaaaaaa: { snippet: { title: 'Numb', channelTitle: 'Linkin Park', liveBroadcastContent: 'none' }, contentDetails: { duration: 'PT3M7S' }, status: { embeddable: true } },
  bbbbbbbbbbb: { snippet: { title: 'Bloqueado', channelTitle: 'X', liveBroadcastContent: 'none' }, contentDetails: { duration: 'PT4M' }, status: { embeddable: false } },
  ccccccccccc: { snippet: { title: 'Ao vivo', channelTitle: 'Y', liveBroadcastContent: 'live' }, contentDetails: { duration: 'P0D' }, status: { embeddable: true } },
  ddddddddddd: { snippet: { title: 'In the End', channelTitle: 'Linkin Park', liveBroadcastContent: 'none' }, contentDetails: { duration: 'PT3M36S' }, status: { embeddable: true } },
};
let quota = false;
globalThis.fetch = async (u) => {
  u = new URL(u);
  calls.push(u.pathname.split('/').pop());
  const ok = (j) => ({ ok: true, status: 200, json: async () => j, text: async () => JSON.stringify(j) });
  if (quota) return { ok: false, status: 403, json: async () => ({}), text: async () => 'quotaExceeded' };
  assert.equal(u.searchParams.get('key'), 'chave-falsa');
  if (u.pathname.endsWith('/search')) return ok({ items: ['aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc', 'ddddddddddd'].map((videoId) => ({ id: { videoId } })) });
  if (u.pathname.endsWith('/videos')) return ok({ items: u.searchParams.get('id').split(',').filter((id) => VIDEOS[id]).map((id) => ({ id, ...VIDEOS[id] })) });
  if (u.pathname.endsWith('/playlistItems')) {
    const second = u.searchParams.get('pageToken') === 'p2';
    return ok({ items: (second ? ['ddddddddddd'] : ['aaaaaaaaaaa', 'bbbbbbbbbbb']).map((videoId) => ({ contentDetails: { videoId } })), nextPageToken: second ? undefined : 'p2' });
  }
  if (u.pathname.endsWith('/playlists')) return ok({ items: [{ snippet: { title: 'Rock' } }] });
  throw new Error(`url inesperada ${u}`);
};

const me = Object.assign(Object.create(Server.prototype), { env: { YT_KEY: 'chave-falsa' }, ytc: new Map() });
const list = await me.search('Linkin  Park');
assert.deepEqual(list.map((x) => [x.id, x.t, x.a, x.d]), [['aaaaaaaaaaa', 'Numb', 'Linkin Park', 187], ['ddddddddddd', 'In the End', 'Linkin Park', 216]]);
const n = calls.length;
await me.search('linkin park');
assert.equal(calls.length, n, 'a mesma busca deveria vir do cache');
const one = await me.resolve('linkin park');
assert.equal(one.list.length, 1);
assert.equal(one.list[0].t, 'Numb');
const pl = await me.resolve('https://www.youtube.com/playlist?list=PL6B3937A5D230E335');
assert.deepEqual(pl.list.map((x) => x.t), ['Numb', 'In the End']);
assert.equal(pl.label, '“Rock”');
const vid = await me.resolve('https://youtu.be/bbbbbbbbbbb');
assert.match(vid.err, /não pode tocar fora do YouTube/);

const sent = [];
const ws = { send: (s) => sent.push(JSON.parse(s)), serializeAttachment() {} };
await me.ytSearch(ws, { uid: 'x' }, { t: 'yt', q: 'linkin park', n: 7 }, Date.now());
assert.equal(sent.at(-1).n, 7);
assert.equal(sent.at(-1).list.length, 2);

quota = true;
me.ytc.clear();
assert.match((await me.resolve('outra musica')).err, /limite do dia/);
quota = false;

const nokey = Object.assign(Object.create(Server.prototype), { env: {}, ytc: new Map() });
assert.match((await nokey.resolve('linkin park')).err, /desligada no servidor/);
assert.equal((await nokey.resolve('https://www.youtube.com/playlist?list=PL6B3937A5D230E335')).needIds, 'PL6B3937A5D230E335');
await nokey.ytSearch(ws, { uid: 'x' }, { t: 'yt', q: 'linkin park', n: 8 }, Date.now());
assert.match(sent.at(-1).err, /desligada no servidor/);

// fila: avançar, repetir uma, repetir a fila, guardar só 30 tocadas
const s = { q: Array.from({ length: 40 }, (_, i) => ({ k: `k${i}`, id: 'aaaaaaaaaaa', t: `m${i}`, d: 100 })), i: 0, at: 0, pos: 0, paused: false, loop: 'off' };
Server.advance(s, 1000, false);
assert.equal(s.i, 1);
s.loop = 'one'; Server.advance(s, 2000, false); assert.equal(s.i, 1); assert.equal(s.at, 2000);
Server.advance(s, 3000, true); assert.equal(s.i, 2, 'pular ignora o repetir uma');
s.loop = 'off'; s.i = 39; Server.advance(s, 4000, false); assert.equal(s.i, s.q.length, 'fim da fila = nada tocando');
assert.equal(s.q.length, 30, 'das tocadas ficam só as 30 últimas'); assert.equal(s.q[0].t, 'm10');
s.loop = 'all'; s.i = 9; Server.advance(s, 5000, false); assert.equal(s.q[s.i].t, 'm20');
s.i = s.q.length - 1; Server.advance(s, 6000, false); assert.equal(s.q[s.i].t, 'm10', 'repetir a fila volta ao começo');
const t = { q: Array.from({ length: 40 }, (_, i) => ({ k: `k${i}`, id: 'aaaaaaaaaaa', t: `m${i}`, d: 100 })), i: 35, at: 0, pos: 0, paused: false, loop: 'off' }; Server.advance(t, 7000, false); assert.equal(t.i, 30); assert.equal(t.q[t.i].t, 'm36');
console.log('DJ BUSCA OK: links, duração, busca (sem bloqueado e sem live), cache, playlist em 2 páginas, sem chave, cota, fila (repetir/avançar)');
