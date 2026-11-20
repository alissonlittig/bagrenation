# Bot de música no BAGRENATION: dá para ter? (pesquisa S-1564, 20/11/2026)

Pergunta: dá para ter um "bot de música" como no Discord, em que alguém põe uma música e todo mundo do canal ouve?
**Resposta curta: dá, mas não do jeito dos bots antigos do Discord.** O caminho permitido e grátis é um **player do YouTube sincronizado no canal** (todo mundo toca o mesmo vídeo oficial do YouTube ao mesmo tempo, com fila, pular e volume). O caminho "bot que baixa o áudio do YouTube" viola os termos e foi justamente o que derrubou os bots do Discord.

Nada disso foi implementado (o pedido era só pesquisar).

## Comparação

| Caminho | Funciona no site? | Funciona no app (Tauri)? | Custo | Risco legal / termos | Esforço |
|---|---|---|---|---|---|
| **(a) Player do YouTube sincronizado** (IFrame Player API) | Sim | Sim, com 1 cuidado (abaixo) | Grátis (o player embutido não usa cota da API; busca por nome usaria a Data API, grátis com cota de 10 mil unidades/dia) | Baixo, se o player ficar visível (mín. 200×200 px), sem esconder anúncio, sem tirar o áudio do vídeo | Médio: ~1 a 2 dias |
| **(b) SoundCloud Widget** | Sim | Sim | Grátis | Baixo para tocar pelo widget oficial (com crédito ao artista); proibido copiar/gravar o áudio | Médio: ~1 dia (dá para reusar a mesma sincronização de (a)) |
| **(c) Spotify** (Embed / Jam) | Só prévia ou cada um logado na própria conta | Igual | Grátis para tocar prévia; música inteira exige cada pessoa com Spotify (Premium para controle total) | **Alto para "todo mundo ouve o mesmo"**: a política proíbe serviço que toca de uma fonte para vários ouvintes e produto que replica o Spotify; o Jam não tem API | Alto e frágil |
| **(d) Bot que extrai o áudio do YouTube** (yt-dlp) e transmite no canal | Sim (o áudio iria como uma "tela" só de som) | Sim | Grátis em dinheiro, mas precisa de um PC/servidor ligado rodando o bot | **Viola os termos do YouTube** (proibido separar/baixar o áudio). Foi o que derrubou Groovy e Rythm em 2021 | Médio, e quebra sempre que o YouTube muda |

## Detalhe de cada caminho

### (a) Player do YouTube sincronizado no canal (recomendado)
- Como funciona: alguém cola um link do YouTube no canal de voz. O BAGRENATION manda para todos do canal (pela malha que já existe) "tocar o vídeo X a partir do segundo T". Cada pessoa toca o **player oficial do YouTube** na própria máquina; ninguém baixa nem retransmite áudio. É o mesmo modelo do Watch2Gether e de vários projetos abertos de "watch party" (ex.: TogetherTube e watchNChill usam `seekTo()` e um acerto de tempo a cada poucos segundos, com diferença menor que ~1,5 s).
- Fila, pular, pausar e volume: a IFrame Player API tem `loadVideoById`, `playVideo`, `pauseVideo`, `seekTo`, `setVolume`, `mute` e eventos de fim de vídeo (para tocar o próximo da fila). Volume fica por pessoa (cada um no seu player). Precisa de `enablejsapi=1` no embed.
- Regras do YouTube que a gente cumpre fácil: player visível de no mínimo 200×200 px, o cabeçalho Referer precisa ir junto (não pode ser cortado por Referrer-Policy), não separar o áudio, não esconder anúncios.
- Cuidado no app: o YouTube passou a recusar embed sem Referer (erro 153), o que acontece com páginas de esquema próprio de apps (Electron, extensões, WebView do Android). No app do BAGRENATION a página roda em `https://tauri.localhost`; se o embed der erro 153 ali, a saída é carregar o player a partir de uma página pequena hospedada no próprio site (`alissonlittig.github.io/bagrenation/player.html`) dentro de um iframe. Testar isso é o primeiro passo da implementação.
- Limites: vídeo com incorporação desligada pelo dono não toca embutido (aparece "vídeo indisponível"; o app pula para o próximo). Anúncios do YouTube podem aparecer para cada pessoa e desalinhar alguns segundos (o acerto periódico corrige). No celular, o navegador exige um toque para começar com som.
- Visual: um cartão "Tocando agora" no canal de voz (capa, título, quem pôs, barra de tempo, fila), com o player visível do jeito que a regra pede.

### (b) SoundCloud Widget
- O widget oficial tem `play`, `pause`, `seekTo(ms)`, `setVolume(0–100)` e eventos (`PLAY_PROGRESS`, `FINISH`), então a mesma sincronização do (a) serve.
- Termos: ao usar o widget/API você aceita os termos da API e do SoundCloud; é proibido usar para copiar, gravar ou capturar o áudio e para driblar proteção do dono da faixa; o crédito ao artista vem pronto no widget. Não pode virar um "serviço de streaming concorrente".
- Ponto fraco: muita música comercial não está no SoundCloud (ou só como prévia "Go+"). Bom como segunda fonte, não como principal.

### (c) Spotify
- Política do Spotify para desenvolvedores: proíbe produto que tenha "webcasting não interativo" (uma fonte tocando para vários ouvintes ao mesmo tempo, que é exatamente o "bot de música"), proíbe sincronizar gravação com mídia visual, proíbe replicar uma experiência central do Spotify sem permissão por escrito e diz que streaming de música pela plataforma é só para assinantes.
- O **Jam** (ouvir junto) existe só dentro do app do Spotify; não tem API para outros programas.
- O que dá para fazer sem violar: botão "abrir no Spotify" ou o embed oficial tocando para cada pessoa na conta dela. Não dá "todo mundo ouve a mesma música pelo BAGRENATION". Não recomendado.

### (d) Bot que extrai o áudio do YouTube (yt-dlp) — não fazer
- As políticas da API do YouTube proíbem oferecer meio de **baixar ou separar a faixa de áudio** de um vídeo e dão como exemplo justamente separar/isolar o áudio (citam serviço de converter para mp3). Isso também passa por cima dos anúncios, que é o que o YouTube cobra.
- Por que os bots do Discord caíram: em 2021 o Google mandou carta de "pare imediatamente" (cease and desist) ao **Groovy** (fechou em 30/08/2021) e ao **Rythm** (fechou em 15/09/2021). O motivo dado: violar os termos do YouTube, modificando o serviço e usando comercialmente (os bots pegavam o áudio do YouTube sem permissão e ainda vendiam assinatura premium). Na mesma época o YouTube derrubou vários sites de download (houve até o caso do youtube-dl no GitHub em 2020).
- Mesmo sendo só entre amigos e sem cobrar, continua contra os termos, e o yt-dlp quebra toda vez que o YouTube muda (o bot pararia do nada). Não recomendado.

## Recomendação
**Fazer o (a): player do YouTube sincronizado no canal de voz**, grátis, sem servidor novo (usa a malha/Worker que já existe), funciona no site e no app (com o teste do erro 153 primeiro), dentro dos termos. Depois, se quiserem, somar o SoundCloud (b) usando a mesma sincronização. Spotify e bot com yt-dlp ficam de fora.

Esforço estimado do (a): 1 a 2 dias de trabalho (cartão "Tocando agora", fila, pular/pausar para todos, volume por pessoa, acerto de tempo, quem entra no meio cai no ponto certo, teste com 2 clientes e no app).

## Fontes
- YouTube, guia das políticas para desenvolvedores (proibido baixar/separar áudio): https://developers.google.com/youtube/terms/developer-policies-guide
- YouTube, políticas para desenvolvedores: https://developers.google.com/youtube/terms/developer-policies
- YouTube, funcionalidade mínima obrigatória (Referer, autoplay): https://developers.google.com/youtube/terms/required-minimum-functionality
- YouTube, parâmetros do player (mínimo 200×200, `enablejsapi`): https://developers.google.com/youtube/player_parameters
- YouTube, referência da IFrame Player API: https://developers.google.com/youtube/iframe_api_reference
- Erro 153 sem Referer (Simon Willison): https://til.simonwillison.net/youtube/fixing-153-embed
- Erro 153 em página de extensão do Chromium: https://groups.google.com/a/chromium.org/g/chromium-extensions/c/OUJad0q-d_g
- Groovy derrubado (9to5Google): https://9to5google.com/2021/09/13/youtube-nukes-popular-groovy-bot-discord-music-service-for-breaking-platforms-tos/
- Rythm fecha após carta do YouTube (NME): https://www.nme.com/news/discord-music-bot-rythm-follows-groovy-into-the-void-after-cease-and-desist-3045407
- YouTube fechando os bots (Tubefilter): https://tubefilter.com/2021/09/13/youtube-groovy-bot-rythm-discord-letters/
- Rythm (Wikipedia): https://en.wikipedia.org/wiki/Rythm_(software)
- SoundCloud Widget API: https://developers.soundcloud.com/docs/api/html5-widget
- SoundCloud termos da API: https://developers.soundcloud.com/docs/api/terms-of-use
- SoundCloud crédito/logos: https://developers.soundcloud.com/docs/api/buttons-logos
- Spotify, política para desenvolvedores: https://developer.spotify.com/policy/
- Spotify, Embeds / iFrame API: https://developer.spotify.com/documentation/embeds/references/iframe-api
- Fórum Spotify (Jam sem API): https://community.spotify.com/t5/Spotify-for-Developers/I-want-to-create-something-which-can-use-to-sync-music-streaming/m-p/6276662/highlight/true
- Projetos abertos de sincronia: https://www.github.com/sjagoori/TogetherTube · https://www.mintlify.com/nawinsharma/watchNChill/features/synchronized-playback
