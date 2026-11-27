# BAGRENATION - Como rodar, testar, publicar

## Rodar o site em desenvolvimento
O site é estático: sirva a raiz do repositório por qualquer servidor local (ex.: `python -m http.server 8080`) e abra `http://localhost:8080/?servidor=teste` (o parâmetro `servidor` abre uma sala separada para não entrar na de verdade). O servidor de chat é o Worker publicado; para um Worker próprio de teste: `cd server && npx wrangler dev`.

## Servidor (Cloudflare)
```
cd server
npx wrangler deploy        # publica o Worker bagrenation-chat (Durable Object "Server", migração v1)
npx wrangler secret put ADMIN_KEY      # idem YT_KEY, TURN_KEY_ID, TURN_KEY_API_TOKEN (opcionais)
```
A conta do Cloudflare é a do Alisson (login pelo Bitwarden/Edge dele; nunca digitar senha em job).

## Testes
Em `tests/` (precisam de Playwright e do navegador; `PW_CHANNEL=msedge` usa o Edge):
```
python tests/test_e2e.py            # voz/chat/tela com vários clientes
python tests/test_musica.py         # Bagre DJ com 3 clientes
python tests/test_app.py desktop/src-tauri/target/release/bagrenation.exe    # app de PC + site na mesma sala
python tests/test_android.py        # app Android (emulador/aparelho)
node tests/test_portao.mjs          # convite e banimento
```
Há ainda testes de canais, membros, perfil, avatar, foco, tela cheia, sincronização, Spotify e eco (`tests/test_*.py|mjs`).

## Gerar e publicar versão nova (Windows + Android juntos)
1. Subir a versão nos 4 lugares: `desktop/package.json`, `desktop/src-tauri/Cargo.toml`, `desktop/src-tauri/tauri.conf.json` e a propriedade `bagreVersionName` no `mobile/android/app/build.gradle` (o `release.py` recusa se desktop e Android diferirem).
2. Commit e push do código.
3. Rodar:
```
python tools/release.py <versao> <commit> <notas.md> --build
```
`--build` compila o desktop (`tools/build_desktop.sh`: Rust + SDK do Windows via xwin em `C:\xwin` + clang-cl em `C:\llvm`, sem Visual Studio) e o Android (`mobile`: `node montar.mjs`, `npx cap sync android`, `gradlew assembleRelease`, JDK/SDK em `C:\SISTEMA_ANTIGO\kit\android`).
O script confere se o APK tem o endereço de atualização do GitHub (e não o de teste), cria a release `v<versao>` (reaproveita se já existir) e sobe: `BAGRENATION_<v>_x64-setup.exe` + `.sig`, `latest.json`, `BAGRENATION_<v>.apk`, `BAGRENATION.apk` e `SHA256SUMS.txt`. O link fixo `.../releases/latest/download/BAGRENATION.apk` baixa sempre o último. O token vem do Git Credential Manager (não é impresso).

O site (GitHub Pages) publica sozinho o que está na `main`.

## Atualização automática
- **Windows:** `tauri-plugin-updater` lê `https://github.com/alissonlittig/bagrenation/releases/latest/download/latest.json`; a atualização é assinada (chave pública em `tauri.conf.json`) e o app pergunta antes de atualizar.
- **Android:** `Atualizador.java` consulta `api.github.com/repos/alissonlittig/bagrenation/releases/latest`, baixa o APK, confere o SHA-256 e instala pelo instalador de pacotes (desde a 1.9.2). Se o Android exigir, mostra "Atualização pronta - Instalar".

## Onde ficam as chaves (só caminhos)
- Assinatura do updater do Windows: `C:\SISTEMA\chaves\bagrenation-updater.key` (privada) e `.key.pub`. Lida pelo `build_desktop.sh` em `TAURI_SIGNING_PRIVATE_KEY`.
- Assinatura do APK: `C:\SISTEMA\chaves\bagrenation\android\` (`bagrenation.jks`, `apk.properties`). Perder impede atualizar por cima.
- Chave admin do Worker e convite: `C:\SISTEMA\chaves\bagrenation\chat_admin_key.txt` e `convite.txt`.
