// Copia o site (a mesma pasta do GitHub Pages) para www/, que vira o conteúdo do APK, e liga a camada do Android (mobile.js).
// O app não tem cópia própria do código: tudo vem de ../index.html, ../app.js, ../style.css etc. (igual ao desktop/copy-site.mjs).
import { cpSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
const root = new URL('../', import.meta.url);
const www = new URL('./www/', import.meta.url);
rmSync(www, { recursive: true, force: true });
mkdirSync(www);
for (const f of ['index.html', 'app.js', 'signal.js', 'style.css', 'favicon.svg', 'og.png', 'fonts', 'pcm-worklet.js', 'icons']) {
  cpSync(new URL(f, root), new URL(f, www), { recursive: true });
}
cpSync(new URL('./mobile.js', import.meta.url), new URL('mobile.js', www));
const html = new URL('index.html', www);
let page = readFileSync(html, 'utf8');
// a tela do Android chega por um WebSocket local (127.0.0.1, com senha de uso único)
page = page.replace("connect-src 'self'", "connect-src 'self' ws://127.0.0.1:*");
// mobile.js roda antes do app.js (troca o getDisplayMedia, avisos, tela cheia, update)
page = page.replace(/<script src="app\.js/, '<script src="mobile.js"></script>\n<script src="app.js');
// manifest/service worker do PWA não servem dentro do APK
page = page.replace(/<link rel="manifest"[^>]*>\n?/, '');
if (!page.includes('ws://127.0.0.1') || !page.includes('mobile.js')) throw new Error('montar: CSP ou script não encontrado no index.html');
writeFileSync(html, page);
console.log('www/ pronto');
