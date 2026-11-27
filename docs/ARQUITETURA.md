# BAGRENATION - Arquitetura

Uma interface só (site) empacotada em 3 formas: **site** (GitHub Pages), **app de Windows** (Tauri 2) e **app Android** (Capacitor). Um servidor de chat/estado único na Cloudflare. Voz e tela vão direto entre os participantes (WebRTC).

## Stack
- Front-end: HTML + CSS + JavaScript puro, sem framework nem bundler (`index.html`, `app.js` ~4,2 mil linhas, `style.css`, `signal.js`, `pcm-worklet.js`, `player.html`/`player.js`).
- Servidor: **Cloudflare Worker + Durable Object com SQLite** (`server/worker.js`, `wrangler.toml`; plano grátis, sem banco externo).
- Mídia ao vivo: **WebRTC** em malha (voz Opus 48 kHz estéreo; tela e som da tela em conexões separadas). STUN da Cloudflare; TURN do Cloudflare Realtime opcional (credencial curta gerada no Worker).
- App de PC: **Tauri 2** + WebView2 (Rust, `desktop/src-tauri`).
- App Android: **Capacitor 8** (`mobile/`), Java nativo.

## Pastas

| Caminho | Papel |
|---|---|
| `index.html`, `app.js`, `style.css`, `signal.js`, `pcm-worklet.js` | O site inteiro; a mesma cópia vai para os apps no build (não existe segunda cópia do código) |
| `player.html`, `player.js` | Player oficial do YouTube controlado por `postMessage` (Bagre DJ no site) |
| `server/worker.js` | Worker + classe `Server` (Durable Object): chat, mídia, membros, canais, música, portão de convite |
| `desktop/` | App Windows. `copy-site.mjs` copia o site para `dist/` (ajusta a CSP); `src-tauri/src/main.rs` (tecla global, bandeja, atualização), `sysaudio.rs` (som do PC sem o próprio app), `djaudio.rs` (áudio do Bagre DJ com yt-dlp) |
| `mobile/` | App Android. `montar.mjs` copia o site para `www/` e injeta `mobile.js`; `android/.../*.java`: `BagrePlugin`, `CallService`, `TelaServer` (tela do Android por WebSocket local), `Atualizador`, `AtualizaJob`, `AtualizaRecebe`, `MainActivity` |
| `tests/` | Testes de ponta a ponta (Playwright/Python e Node): voz, chat, canais, membros, DJ, Spotify, portão, app real |
| `tools/` | `release.py` (publica Windows + Android), `build_desktop.sh`, `pixel.py` (avatares) |
| `ANALISE.md`, `PESQUISA_BOT_MUSICA.md` | Estudos de apoio |

## Fluxo de dados
1. **Entrada:** `?servidor=` escolhe o servidor (padrão `bagrenation`; os testes usam outro). O convite chega no link `#convite=<token>` ou colado na tela; o Worker guarda só o **hash** do convite (`kv 'inv'`), libera o aparelho por uid (tabela `gate`) e permite banir (derruba as conexões). O dono (`kv 'owners'`) vê membros e gera convites.
2. **Chat/estado:** o navegador abre um WebSocket em `/s/<servidor>/ws`. O Durable Object mantém tudo em SQLite: `msgs`, `media` + `chunks` (imagem/GIF/vídeo até 25 MB, em pedaços), `members`, `chans`, `music`, `spq` (fila do DJ), `musseen`, `kv`, `vcall`, `gate`. Rotas: `ws`, `rtc`, `up`, `del`, `adm`, `m/<id>`.
3. **Sinalização WebRTC:** rota `/rtc` do mesmo Worker (`signal.js`), no lugar de serviço público.
4. **Voz e tela:** ponto a ponto, criptografados, sem passar pelo servidor. Ping/atraso medidos com `getStats`.
5. **Bagre DJ:** o estado (fila, posição, pausa) fica no Durable Object e todos tocam no mesmo ponto; cada aparelho toca a música localmente (site: player do YouTube por baixo da capa; app de PC: só áudio via `yt-dlp` baixado da release oficial no 1º uso, SHA-256 conferido). Busca de música sem chave (ou YouTube Data API se o Worker tiver o secret `YT_KEY`); letra pelo LRCLIB; playlists do Spotify viram faixas do YouTube.
6. **App de PC:** `main.rs` registra comandos (`set_keys`, `tray_state`, `notify`, `autostart`, `fullscreen`, `idle_secs`, `sys_audio_start/stop`, `dj_audio`), gancho global de teclado/mouse que só observa a tecla, bandeja, abrir com o Windows.
7. **App Android:** captura de tela via serviço em primeiro plano; a imagem chega à página por WebSocket local `127.0.0.1` com senha de uso único.

## Serviços externos (sem segredo)
- Cloudflare Workers / Durable Objects (`bagrenation-chat`, `workers.dev`), Cloudflare STUN e Realtime TURN (opcional).
- GitHub Pages (site) e GitHub Releases `alissonlittig/bagrenation` (instaladores, `latest.json`, APK, `SHA256SUMS.txt`).
- YouTube (player/busca), iTunes (título e artista oficiais), LRCLIB (letras), `yt-dlp` (release oficial no GitHub).

## Segredos do Worker (nomes, sem valores)
`ADMIN_KEY` (rota `/adm`), `YT_KEY` (opcional), `TURN_KEY_ID` e `TURN_KEY_API_TOKEN` (opcionais).
