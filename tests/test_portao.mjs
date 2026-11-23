// S-0065: portão do servidor (convite, expulsar, convite novo, arquivos e voz só com sessão), num servidor de teste fechado.
// uso: node tests/test_portao.mjs [base]   (base padrão = o Worker publicado)
import crypto from 'node:crypto';

const BASE = process.argv[2] || 'https://bagrenation-chat.alissondelittig.workers.dev';
const SRV = `teste-fech-${crypto.randomBytes(3).toString('hex')}`;
const ORIGIN = 'https://alissonlittig.github.io';
const W = `${BASE.replace(/^http/, 'ws')}/s/${SRV}`;
const H = `${BASE}/s/${SRV}`;
let n = 0;
const ok = (t) => console.log(`ok ${String(++n).padStart(2)}: ${t}`);
const fail = (t) => { console.log(`FALHOU: ${t}`); console.log('RESULTADO', JSON.stringify({ rc: 1, passos: n, srv: SRV, erro: t })); process.exit(1); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function client(name, inv) { // conecta, manda 'me' e junta tudo o que chega
  const key = crypto.randomBytes(16).toString('hex');
  const c = { name, key, got: [], closed: null };
  c.ws = new WebSocket(`${W}/ws`, { headers: { Origin: ORIGIN, 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/140.0' } });
  c.ws.onmessage = (e) => { if (e.data !== 'pong') c.got.push(JSON.parse(e.data)); };
  c.ws.onclose = (e) => { c.closed = e.code; };
  c.ready = new Promise((r) => { c.ws.onopen = () => { c.ws.send(JSON.stringify({ t: 'v' })); c.ws.send(JSON.stringify({ t: 'me', key, name, av: '', st: 'on', ...(inv ? { inv } : {}) })); r(); }; });
  c.has = (t) => c.got.find((d) => d.t === t);
  c.until = async (t, ms = 8000) => { for (let i = 0; i < ms / 100; i++) { const d = c.has(t); if (d) return d; await wait(100); } return null; };
  c.send = (o) => c.ws.send(JSON.stringify(o));
  return c;
}

const A = client('Dono');
await A.ready;
const aok = await A.until('ok');
if (!aok || !aok.owner || !/^[a-f0-9]{40}$/.test(aok.mt)) fail(`o 1º do servidor de teste fechado devia virar dono com sessão: ${JSON.stringify(A.got.map((d) => d.t))}`);
if (!A.has('hist') || !A.has('members') || !A.has('chans')) fail('o dono não recebeu histórico/membros/canais');
const uidA = A.has('you').uid;
ok(`dono entra: sessão de 40 hex, histórico, membros e canais (${SRV})`);
A.send({ t: 'msg', ch: 'chat', name: 'Dono', av: '', text: 'segredo do servidor' });
await wait(600);

const B = client('Intruso');
await B.ready;
const bl = await B.until('locked');
await wait(800);
if (!bl || bl.why !== 'need') fail(`sem convite devia receber locked/need: ${JSON.stringify(B.got)}`);
const leaked = B.got.filter((d) => ['hist', 'members', 'chans', 'mus', 'vct', 'msg', 'pres', 'ok', 'you'].includes(d.t)).map((d) => d.t);
if (leaked.length) fail(`sem convite recebeu dados: ${leaked}`);
if (JSON.stringify(B.got).includes('segredo')) fail('sem convite viu a mensagem');
ok(`sem convite: só 'hi' e 'locked' (recebeu ${JSON.stringify(B.got.map((d) => d.t))}), conexão fechada ${B.closed}`);

A.send({ t: 'adm', op: 'invite' });
const inv1 = (await A.until('adminv')).tok;
if (!/^[A-Za-z0-9_-]{43}$/.test(inv1 || '')) fail(`convite inválido: ${inv1}`);
ok(`dono gera convite (${inv1.length} caracteres)`);

const B2 = client('Amigo', inv1);
await B2.ready;
const b2ok = await B2.until('ok');
const b2h = await B2.until('hist');
if (!b2ok || b2ok.owner || !b2h || !JSON.stringify(b2h).includes('segredo')) fail(`com convite devia entrar e ver o histórico: ${JSON.stringify(B2.got.map((d) => d.t))}`);
const uidB = B2.has('you').uid;
ok('com convite: entra, vê o histórico, não é dono');

// arquivos e envio: só com sessão
const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
const up0 = await fetch(`${H}/up`, { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'image/png' }, body: png });
if (up0.status !== 403) fail(`enviar sem sessão devia dar 403: ${up0.status}`);
const up = await fetch(`${H}/up?u=${uidA}&t=${aok.mt}`, { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'image/png' }, body: png });
const mid = (await up.json()).id;
if (up.status !== 200 || !mid) fail(`enviar com sessão: ${up.status}`);
const g0 = await fetch(`${H}/m/${mid}`);
const gA = await fetch(`${H}/m/${mid}?u=${uidA}&t=${aok.mt}`);
const gB = await fetch(`${H}/m/${mid}?u=${uidB}&t=${b2ok.mt}`);
const gX = await fetch(`${H}/m/${mid}?u=${uidB}&t=${aok.mt}`);
if (g0.status !== 403 || gA.status !== 200 || gB.status !== 200 || gX.status !== 403) fail(`arquivo: sem sessão ${g0.status}, dono ${gA.status}, amigo ${gB.status}, sessão trocada ${gX.status}`);
ok(`arquivo: sem sessão 403, com sessão 200 (dono e amigo), sessão de outro 403; envio sem sessão 403`);

// voz/tela: a sinalização também pede sessão
const rtc = (q) => new Promise((r) => { const w = new WebSocket(`${W}/rtc${q}`, { headers: { Origin: ORIGIN } }); w.onopen = () => { w.close(); r('abriu'); }; w.onerror = () => r('recusou'); });
const r0 = await rtc(''), r1 = await rtc(`?u=${uidB}&t=${b2ok.mt}`);
if (r0 !== 'recusou' || r1 !== 'abriu') fail(`sinalização: sem sessão ${r0}, com sessão ${r1}`);
ok('voz/tela: sinalização sem sessão recusada, com sessão abre');

// expulsar: cai na hora, não volta nem com o convite
A.got.length = 0; // a lista que vale é a de depois do expulsar
A.send({ t: 'adm', op: 'kick', uid: uidB });
const kk = await B2.until('kicked');
await wait(800);
if (!kk || B2.closed === null) fail(`expulso devia receber 'kicked' e cair: ${JSON.stringify(B2.got.slice(-3))} closed=${B2.closed}`);
const al = await A.until('admlist');
const rowB = al.list.find((x) => x.uid === uidB);
if (!rowB || !rowB.ban) fail(`lista do dono não mostra o expulso: ${JSON.stringify(al.list)}`);
if (!rowB.dev || rowB.dev === 'desconhecido') fail(`lista sem aparelho: ${JSON.stringify(rowB)}`);
const gB2 = await fetch(`${H}/m/${mid}?u=${uidB}&t=${b2ok.mt}`);
if (gB2.status !== 403) fail(`expulso ainda abre arquivo: ${gB2.status}`);
const B3 = client('Amigo', inv1); B3.key = B2.key;
B3.ws.close();
const again = { got: [] };
const ws3 = new WebSocket(`${W}/ws`, { headers: { Origin: ORIGIN } });
ws3.onmessage = (e) => again.got.push(JSON.parse(e.data));
await new Promise((r) => { ws3.onopen = r; });
ws3.send(JSON.stringify({ t: 'me', key: B2.key, name: 'Amigo', av: '', st: 'on', inv: inv1 }));
await wait(1500);
const lb = again.got.find((d) => d.t === 'locked');
if (!lb || lb.why !== 'ban' || again.got.some((d) => d.t === 'hist')) fail(`expulso voltou: ${JSON.stringify(again.got.map((d) => d.t))}`);
ok(`expulsar: o expulso recebe 'kicked' e cai na hora (código ${B2.closed}), some dos arquivos (403) e não volta nem com o convite (locked/ban); a lista do dono mostra "${rowB.name}" bloqueado, aparelho "${rowB.dev}"`);

// convite novo: o antigo para de valer
A.send({ t: 'adm', op: 'invite' });
await wait(300);
const inv2 = A.got.filter((d) => d.t === 'adminv').pop().tok;
if (inv2 === inv1) fail('convite novo igual ao antigo');
const C = client('Outro', inv1);
await C.ready;
const cl = await C.until('locked');
const D = client('Felipe', inv2);
await D.ready;
const dk = await D.until('ok');
if (!cl || cl.why !== 'bad' || !dk) fail(`convite antigo devia falhar e o novo entrar: antigo=${JSON.stringify(cl)} novo=${!!dk}`);
ok('gerar novo convite: o antigo não entra mais (locked/bad), o novo entra');

const mem = (await D.until('members')).list.map((m) => m.name);
if (mem.includes('Intruso') || mem.includes('Amigo') || mem.includes('Outro')) fail(`lista pública mostra quem não está liberado: ${mem}`);
ok(`lista pública de membros só com quem está liberado: ${JSON.stringify(mem)}`);

for (const c of [A, B, B2, C, D]) try { c.ws.close(); } catch { /* já fechou */ }
try { ws3.close(); } catch { /* já fechou */ }
console.log('RESULTADO', JSON.stringify({ rc: 0, passos: n, srv: SRV }));
process.exit(0);
