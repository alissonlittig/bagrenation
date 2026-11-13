# Análise do site original (Streamcord / "BAGRESTREAM")

- Site: https://felipedays.github.io/streamcord/
- Repositório: https://github.com/felipedays/streamcord (commit analisado: `6b7e5a8`, "fix 3.1", 13/11/2026)
- Conteúdo: um único `index.html` de 1.655 linhas (HTML + CSS + JS juntos) e um README de uma linha.
- **Licença: nenhuma.** O repositório não tem arquivo de licença e a API do GitHub devolve `license: null`. Sem licença, o código não pode ser copiado. Por isso o Telão foi **escrito do zero**; do original só foi aproveitada a ideia de funcionamento.

Os números de linha abaixo são do `index.html` daquele commit. "Rodado" = reproduzido num navegador automatizado em 13/11/2026; "lido" = constatado na leitura do código.

## Como o original funciona

| Peça | O que usa |
|---|---|
| Transporte | WebRTC ponto a ponto, pela biblioteca PeerJS 1.5.2 (carregada do unpkg) |
| Sinalização | Servidor público gratuito do PeerJS (`0.peerjs.com`) |
| Sala | Quem abre o site vira "dono" de uma sala com ID `bagre-room-XXXXX` (5 caracteres) |
| Entrada | O amigo digita o código; conecta no dono, recebe a lista dos demais e conecta em todos (malha) |
| Mídia | `getDisplayMedia` fixo em 1080p/30; quem transmite abre uma chamada para cada pessoa |
| NAT | Só STUN do Google, sem TURN |
| Interface | Tailwind pelo CDN de desenvolvimento, Font Awesome, Google Fonts |

Não há servidor próprio, build nem testes.

## Bugs e limitações encontrados

### Sala e conexão

1. **Recarregar a página cria outra sala e mata a anterior.** A sala é gerada em toda carga (`initRoomSession()` sem argumento, L1643) e o código não fica na URL. Rodado: sala `ETWE4` virou `B8E8S` depois de um F5. Se o dono atualiza a página, ninguém mais consegue entrar.
2. **Não existe link de convite.** Não há leitura de `location.hash` nem de parâmetros; o amigo precisa abrir o site, passar pelo modal de nome, abrir outro modal e digitar o código. O botão "Copiar" copia só o código (L1591-1607), com `document.execCommand('copy')`, que é API obsoleta.
3. **Entrar na sala de um amigo não tira você da sua.** `joinFriendRoom` (L670-695) só troca o texto exibido e conecta no outro dono; o ID real continua `bagre-room-<sua sala>`. Rodado: depois de "entrar" na sala `ZZZZ9`, a tela mostrava `ZZZZ9` mas `state.myPeerId` seguia `bagre-room-ETWE4`. Consequência: quem tiver o código antigo ainda entra em você e é fundido na sala nova, sem que ninguém perceba. O ramo de `initRoomSession` para "membro" (L626-628, prefixo `bagre-peer-`) é código morto: a função nunca é chamada com argumento (L663 e L1643).
4. **Código inexistente troca a sala exibida mesmo assim.** Rodado: digitar `ZZZZ9` (sala que não existe) muda o "ID da sala" para `ZZZZ9`; se a pessoa copiar e mandar esse código, ele não leva a lugar nenhum. Além disso `setupDataConnection` cria a entrada do "amigo" antes de a conexão abrir (L725) e nada a remove quando a conexão falha. Rodado: 9 s depois da tentativa, `peersMap` ainda continha `bagre-room-ZZZZ9`, um participante fantasma que depois recebe tentativas de chamada (L842-847).
5. **Se o dono sai, a sala fica órfã.** Quem já está dentro continua se vendo, mas o código passa a responder "Sala não encontrada" (L664-666), porque ele aponta para o ID do dono. Lido.
6. **Nenhuma reconexão.** Não há tratamento de `disconnected`/`close` do PeerJS nem chamada a `reconnect()` (busca no arquivo: zero ocorrências). Se o WebSocket de sinalização cai (wi-fi oscilou, notebook suspendeu), a pessoa deixa de receber novos participantes e novas transmissões sem nenhum aviso. Erros de rede só vão para `console.warn` (L660-667).
7. **Nenhum indicador de conexão.** Não há como saber se está conectado, conectando ou caído.
8. **Conexões duplicadas na malha.** Ao receber a lista de participantes, os dois lados podem conectar um no outro ao mesmo tempo (L756-762). A segunda conexão sobrescreve `entry.dataConn` (L726); quando a primeira fecha, o `close` dela chama `cleanupPeer` (L772-774) e derruba o participante inteiro, apesar de a outra conexão estar viva. Lido.
9. **Fechar a aba não avisa ninguém.** Não há `pagehide`/`beforeunload`. A tela de quem saiu fica congelada nos outros até o WebRTC desistir sozinho (dezenas de segundos).
10. **Sem TURN e sem mensagem quando o NAT bloqueia.** Com STUN apenas (L633-638), duas pessoas atrás de CGNAT/NAT simétrico não conectam, e o site não diz nada: a tela simplesmente não aparece.

### Vídeo e áudio

11. **Qualidade fixa em 1080p a 30 fps** (L1306-1309, L1531-1532). Não dá para transmitir jogo a 60 fps nem baixar a qualidade em internet fraca. `contentHint` é sempre `motion` (L1349), o que borra texto quando a banda aperta.
12. **Os números de qualidade são falsos.** O selo de cada tela escreve `@ 30FPS` fixo no texto (L1550, L1559) e, antes de medir, mostra `1920x1080 @ 30FPS` de enfeite (L1121, L1565). O aviso "Transmitindo em 1080p 30fps (áudio hi-fi)" aparece mesmo quando a captura caiu no plano B sem restrições ou quando não há áudio (L1382).
13. **Limite de banda aplicado "no chute".** `boostWebRTCBitrate` espera 700 ms fixos e chama `setParameters` (L1521-1539). Se a negociação demorar mais que isso, a chamada falha e o erro é engolido (`.catch(() => {})`): a transmissão fica com o limite padrão do navegador, sem aviso.
14. **`RTCPeerConnection.prototype.setLocalDescription` é substituído globalmente** para reescrever o SDP (L1507-1519), com `cbr=1` e 510 kb/s. Alterar o protótipo afeta qualquer conexão da página e depende de detalhe de formato do SDP.
15. **Modo "Anti-eco Meet" enganoso.** O botão aplica `echoCancellation` na faixa de áudio da *tela* (L1438-1450), onde isso não cancela eco de chamada nenhuma. O botão ainda aparece destacado (branco) justamente quando o modo está desligado.
16. **Restrições inválidas na captura.** `googEchoCancellation`, `googAutoGainControl`, `googNoiseSuppression`, `googHighpassFilter` (L1315-1318) são chaves antigas que os navegadores ignoram.
17. **Estados de mudo inconsistentes.** Volume e mudo são misturados: arrastar o volume geral até zero liga `isMasterMuted` (L1255), e o botão de mudo depois desmuta com volume zero. Rodado: `changeMasterVolume(0)` seguido de `toggleMasterMute()` deixa `isMasterMuted=false`, volume 0 e ícone de som ligado, sem som nenhum. `toggleMasterMute` não move o controle deslizante (L1272-1283). O botão "ativar o som" (`forceUnmuteAllRemoteVideos`, L1196-1211) desfaz o mudo que a pessoa tinha escolhido por tela e ignora o mudo geral.
18. **Corrida ao recomeçar a transmissão.** Cada nova chamada fecha a anterior (L827-829); do outro lado, o `close` da chamada antiga remove a tela (L818-820) sem conferir se já chegou uma chamada nova. Dependendo da ordem dos eventos, a tela nova some. Lido.
19. **Sem aviso de "sem áudio".** Se a pessoa não marca "compartilhar áudio" no seletor, a transmissão sai muda e os botões de áudio continuam dizendo "ON".

### Interface e acessibilidade

20. **Cabeçalho quebra no celular.** Rodado em 390×844: o bloco central ocupa de 127 px a 263 px e fica por cima do logo (até 152 px) e dos botões da direita (a partir de 152 px). Print em `prints/orig_celular_app.png` do trabalho.
21. **Controles só aparecem com o mouse em cima.** Volume, foco e tela cheia de cada transmissão ficam com `opacity-0` até o `hover` (L1126); os rótulos dos botões também (L131-154), assim como o painel de informações (L380). Em tela de toque não há `hover`: quem assiste pelo celular não consegue mexer no volume.
22. **Zero rótulos de acessibilidade.** Nenhum `aria-label` no arquivo; os botões são só ícones. Leitor de tela anuncia "botão" e nada mais. Os modais não prendem o foco nem fecham com Esc.
23. **Contraste abaixo do mínimo.** O cinza `#737373` usado em textos de 10-11 px tem contraste 4,43:1 sobre preto e 4,18:1 sobre o painel `#0a0a0a`; o mínimo AA para texto pequeno é 4,5:1.
24. **Mensagem errada no celular.** Sem `getDisplayMedia` (todo navegador de celular), o aviso é "seu navegador bloqueou a captura de tela (use HTTPS)" (L1299), mas o site já está em HTTPS; o problema é o aparelho.
25. **Modal de nome obrigatório a cada visita**, mesmo com nome salvo (L181, L1631-1641), e tudo forçado para maiúsculas.
26. **Marca inconsistente.** O endereço diz "streamcord", o título e a interface dizem "BAGRESTREAM", o README diz outra coisa.
27. **Sem chat, sem janela flutuante (PiP), sem contagem de quem está assistindo.**

### Segurança e robustez

28. **Código de sala fraco.** 5 caracteres de um alfabeto de 32 (≈ 33 milhões de combinações), sorteados com `Math.random()` (L551-558), que não é gerador seguro. Quem acerta um código recebe a transmissão **automaticamente**: basta a conexão abrir para o transmissor ligar a chamada (L738-739). Não há aprovação nem aviso de que alguém entrou.
29. **Qualquer participante pode mandar você conectar em IDs arbitrários.** A lista `peers` recebida de outro participante é aceita sem validação (L756-762): não se confere prefixo, tamanho nem quantidade. Um participante malicioso pode injetar terceiros na sala (que passam a receber a transmissão) ou mandar milhares de IDs para travar o navegador dos outros.
30. **Quatro CDNs de terceiros sem verificação de integridade.** Rodado: a página carrega código de `cdn.tailwindcss.com`, `unpkg.com`, `cdnjs.cloudflare.com` e `fonts.googleapis.com`, nenhum com `integrity=`. Se qualquer um deles for comprometido ou trocar o arquivo, o código roda dentro da página que captura a tela das pessoas.
31. **Tailwind de desenvolvimento em produção.** Rodado: o console avisa em toda carga `cdn.tailwindcss.com should not be used in production`. O script gera o CSS no navegador a cada visita (página pisca sem estilo e pesa mais).
32. **Sem Content-Security-Policy**, e 21 atributos `onclick=` embutidos impedem adotar uma. Os IDs de participante são interpolados dentro de `onclick="...('${pid}')"` (L599, L1130-1150). Hoje isso não é explorável porque o servidor do PeerJS só aceita letras, números, espaço, `-` e `_` em IDs, mas a segurança depende de uma regra de terceiro. Os nomes são escapados corretamente (`escapeHtml`, L1622); não encontrei XSS explorável.
33. **`localStorage` lido sem proteção** logo na primeira linha do script (L454). Em navegador com armazenamento bloqueado isso lança exceção e o site inteiro não inicia.
34. **Erros engolidos em toda parte.** Há 20 `catch` vazios; quando algo falha, nem o usuário nem o console ficam sabendo.

## O que o Telão faz diferente

| Tema | Original | Telão |
|---|---|---|
| Convite | Digitar código de 5 caracteres | Link direto (`#código`), entra sem digitar nada; também aceita colar código |
| Código da sala | 5 caracteres, `Math.random` | 10 caracteres, gerador criptográfico (≈ 8 × 10¹⁴ combinações) |
| Recarregar a página | Perde a sala | Volta para a mesma sala |
| Dono sai | Sala órfã | Outro participante assume a função sozinho; o link continua valendo (testado) |
| Queda de rede | Nada acontece | Indicador "Reconectando"/"Sem internet" e reconexão automática com espera progressiva (testado) |
| Aba fechada | Tela congelada nos outros | Aviso imediato + detecção por sinal de vida em até 20 s |
| Qualidade | 1080p/30 fixo | 720p/30, 1080p/30, 1080p/60, 1440p/60 e prioridade fluidez/nitidez, trocáveis ao vivo |
| Primeiros segundos | Sem taxa inicial: o Chrome começa em 480×270 e sobe em degraus (medido no Telão antes do ajuste, com a mesma configuração do original: 960×540 só aos 20 s) | Taxa inicial de 3 Mb/s na negociação: 1920×1080 já no segundo 2 (medido com captura real de monitor) |
| Números na tela | "30FPS" escrito fixo | Resolução, fps, Mb/s e latência medidos de verdade; contagem de quem assiste |
| Áudio | Reescreve SDP globalmente | Estéreo 256 kb/s só nas chamadas do app; aviso quando a captura veio sem áudio |
| Volume | Estados conflitantes, só no hover | Mudo e volume por transmissão, sempre visíveis, com estado coerente (testado) |
| Trocar de tela | Parar e começar de novo | Botão "Trocar tela" sem encerrar a transmissão |
| Extras | — | Chat, janela flutuante (PiP), tela cheia, destaque, ocultar prévia, tela sempre acesa |
| Celular | Layout quebrado, mensagem errada | Responsivo; explica que celular só assiste |
| Acessibilidade | Sem rótulos, contraste 4,2:1 | Rótulos em tudo, foco visível, contraste ≥ 5,9:1, respeita "reduzir movimento" |
| Dependências | 4 CDNs sem integridade | Zero CDN: PeerJS e fonte hospedados junto, CSP restritiva, sem `onclick` embutido |
| Dados de outros participantes | Lista de IDs aceita sem validação | Só aceita IDs da própria sala, nomes e mensagens limitados e exibidos como texto puro |
| Testes | Nenhum | 15 etapas automatizadas com 5 navegadores reais (`tests/test_e2e.py`) |

## Limites que continuam (valem para os dois)

- **Sem TURN.** Não existe servidor TURN gratuito que dispense conta/cartão (o antigo servidor aberto do Open Relay não responde mais; conferido em 13/11/2026). Em redes muito restritas dos dois lados a conexão direta não fecha. O Telão avisa quando isso acontece; a correção definitiva é configurar um TURN próprio em `ICE`, no `app.js`.
- **Malha.** Quem transmite envia uma cópia para cada espectador. A 1080p/60 (até 10 Mb/s cada), 4 espectadores pedem ~40 Mb/s de upload. Para grupos grandes, baixar a qualidade.
- **Sinalização de terceiros.** O servidor público do PeerJS é gratuito e sem garantia. Se ele cair, ninguém novo entra; as transmissões já abertas continuam.
- **Quem tem o link entra.** Não há senha nem aprovação; a proteção é o código longo. Todo mundo que entra aparece na lista e gera aviso.
- **Áudio depende do navegador e do sistema.** Chrome/Edge enviam áudio de guia em qualquer sistema e áudio do sistema inteiro só no Windows; Firefox e Safari não capturam áudio de tela.
