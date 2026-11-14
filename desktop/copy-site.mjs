// Copia o site (a mesma pasta publicada no GitHub Pages) para dist/, que vira o conteúdo do app.
// O app não tem cópia própria do código: tudo vem de ../index.html, ../app.js, ../style.css etc.
import { cpSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
const root = new URL('../', import.meta.url);
const dist = new URL('./dist/', import.meta.url);
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist);
for (const f of ['index.html', 'app.js', 'style.css', 'favicon.svg', 'og.png', 'fonts', 'vendor']) {
  cpSync(new URL(f, root), new URL(f, dist), { recursive: true });
}
// No app a página fala com o Tauri por fetch em ipc.localhost: libera só isso na CSP da cópia (o site fica igual).
const html = new URL('index.html', dist);
const page = readFileSync(html, 'utf8');
const csp = page.replace("connect-src 'self'", "connect-src 'self' ipc: https://ipc.localhost");
if (csp === page) throw new Error('copy-site: connect-src não encontrado na CSP do index.html');
writeFileSync(html, csp);
