// S-1566/S-1580: busca do Bagre DJ (Data API ou busca pública sem chave; Spotify) com respostas simuladas, sem chave de verdade e sem rede.
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

// S-1580: sem chave = busca pública do YouTube (resposta simulada) e links do Spotify (página do embed simulada)
const vr = (videoId, title, len, owner) => ({ videoRenderer: { videoId, title: { runs: [{ text: title }] }, lengthText: len ? { simpleText: len } : undefined, ownerText: { runs: [{ text: owner }] } } });
const nextData = (entity) => `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { state: { data: { entity } } } } })}</script></html>`;
const asked = [];
const ok = (j) => ({ ok: true, status: 200, json: async () => j, text: async () => JSON.stringify(j) });
globalThis.fetch = async (u, opt) => {
  u = new URL(u);
  if (u.pathname === '/youtubei/v1/search') {
    const q = JSON.parse(opt.body).query;
    asked.push(q);
    return ok({ contents: { a: [vr('ccccccccccc', 'Ao vivo', '', 'Y'), vr('aaaaaaaaaaa', `${q} (clipe)`, '3:07', 'Canal'), vr('ddddddddddd', 'Outra', '1:02:03', 'Z')] } });
  }
  if (u.pathname === '/youtubei/v1/browse' && JSON.parse(opt.body).browseId === 'VLPLlockupteste01') {
    const lk = (id, t, len) => ({ lockupViewModel: { contentType: 'LOCKUP_CONTENT_TYPE_VIDEO', contentId: id, contentImage: { thumbnailViewModel: { overlays: [{ b: { badges: [{ thumbnailBadgeViewModel: { text: len } }] } }] } }, metadata: { lockupMetadataViewModel: { title: { content: t }, metadata: { contentMetadataViewModel: { metadataRows: [{ metadataParts: [{ text: { content: 'Canal' } }] }] } } } } } });
    return ok({ metadata: { playlistMetadataRenderer: { title: 'Lista' } }, contents: [lk('aaaaaaaaaaa', 'Um', '6:31'), lk('bbbbbbbbbbb', 'Ao vivo', 'AO VIVO'), lk('ddddddddddd', 'Dois', '1:00:00')] });
  }
  if (u.hostname === 'open.spotify.com' && u.pathname === '/embed/track/4cOdK2wGLETKBW3PvgPWqT') return new Response(nextData({ name: 'Never Gonna Give You Up', artists: [{ name: 'Rick Astley' }] }));
  if (u.hostname === 'open.spotify.com' && u.pathname === '/embed/playlist/37i9dQZF1DXcBWIGoYBM5M') return new Response(nextData({ name: 'Top', trackList: [{ title: 'A', subtitle: 'X, Y' }, { title: 'B', subtitle: 'Z', isPlayable: false }, { title: 'C', subtitle: 'W' }] }));
  if (u.hostname === 'open.spotify.com') return new Response('', { status: 404 });
  throw new Error(`rede inesperada ${u}`);
};
const nokey = Object.assign(Object.create(Server.prototype), { env: {}, ytc: new Map() });
const pub = await nokey.resolve('linkin park');
assert.deepEqual(pub.list, [{ id: 'aaaaaaaaaaa', t: 'linkin park (clipe)', a: 'Canal', d: 187 }], 'nome -> 1º vídeo com duração (live fica de fora)');
assert.equal((await nokey.search('outra')).at(-1).d, 3723);
assert.equal((await nokey.resolve('https://www.youtube.com/playlist?list=PL6B3937A5D230E335')).needIds, 'PL6B3937A5D230E335');
const lpl = await nokey.resolve('https://www.youtube.com/playlist?list=PLlockupteste01');
assert.deepEqual(lpl.list, [{ id: 'aaaaaaaaaaa', t: 'Um', a: 'Canal', d: 391 }, { id: 'ddddddddddd', t: 'Dois', a: 'Canal', d: 3600 }]); assert.equal(lpl.label, '“Lista”');
await nokey.ytSearch(ws, { uid: 'x' }, { t: 'yt', q: 'linkin park', n: 8 }, Date.now());
assert.equal(sent.at(-1).list.length, 2);
assert.deepEqual(Server.parseSp('https://open.spotify.com/intl-pt/track/4cOdK2wGLETKBW3PvgPWqT?si=abc'), { kind: 'track', id: '4cOdK2wGLETKBW3PvgPWqT' });
assert.equal(Server.parseSp('https://evil.com/open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT'), null);
const spT = await nokey.resolve('https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT');
assert.equal(spT.list.length, 1); assert.equal(asked.at(-1), 'never gonna give you up rick astley');
const spP = await nokey.resolve('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M');
assert.equal(spP.list.length, 2, 'faixa que não toca no Spotify fica de fora'); assert.equal(spP.label, '“Top”');
assert.ok(asked.includes('a x') && asked.includes('c w'));
assert.match((await nokey.resolve('https://open.spotify.com/album/0000000000000000000000')).err, /não existe/);
assert.match((await nokey.resolve('https://spotify.link/abc')).err, /open\.spotify\.com/);

// S-1580: versão bloqueada fora do YouTube -> outra versão da mesma música (até 5 tentativas, sem repetir id)
{
  const st = { q: [{ k: 'k1', id: 'aaaaaaaaaaa', t: 'linkin park', d: 100 }], i: 0 };
  const me2 = Object.assign(Object.create(Server.prototype), { env: {}, ytc: new Map(), mget: () => st });
  const f0 = globalThis.fetch;
  globalThis.fetch = async (u, o) => (new URL(u).pathname === '/oembed' ? new Response('{}', { status: String(u).includes('zzzzzzzzzzz') ? 404 : 200 }) : f0(u, o));
  const alt = await me2.altOf('voz', 'k1');
  assert.equal(alt.v.id, 'ddddddddddd', 'pula o id que já falhou'); assert.deepEqual(alt.tried, ['aaaaaaaaaaa', 'ddddddddddd']);
  assert.equal(await me2.altOf('voz', 'outra'), null, 'aviso de outra música não troca nada');
  st.q[0].x = ['a', 'b', 'c', 'd', 'e', 'f'];
  assert.equal(await me2.altOf('voz', 'k1'), null, 'depois de 5 trocas, pula');
  st.q[0] = { k: 'k2', id: 'zzzzzzzzzzz', t: 'não existe', d: 0 };
  assert.equal(await me2.altOf('voz', 'k2'), null, 'vídeo que não existe: pula sem procurar');
  globalThis.fetch = f0;
}

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
console.log('DJ BUSCA OK: links, duração, busca (sem bloqueado e sem live), cache, playlist em 2 páginas, sem chave (busca pública), Spotify (faixa, playlist, 404), cota, fila (repetir/avançar)');
