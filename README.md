# BAGRENATION

![BAGRENATION: tela de abertura com o bagre cyberpunk em pixel art](og.png)

Compartilhamento de tela com um ID de 6 caracteres, direto no navegador. Sem conta, sem instalar nada e sem chamada de voz: só a tela (ou a janela, a guia, o jogo) com o áudio junto.

**Abrir:** https://alissonlittig.github.io/bagrenation/

## Como usar

1. Aperte **Press Start**, clique em **Criar sala** e passe o ID (ex.: `K7Q-M4P`) para quem vai assistir. Ele não tem 0, O, 1, I nem L, então dá para ditar por voz. Se preferir, **copiar link** também funciona.
2. Quem vai assistir digita o ID em **Entrar com ID**. Se a sala não existir, o BAGRENATION avisa e ninguém sai da sala onde está.
3. Clique em **Compartilhar tela** e escolha a guia, a janela ou o monitor. Para enviar som, marque "Compartilhar áudio" no seletor do navegador.

Mais de uma pessoa pode transmitir ao mesmo tempo na mesma sala.

## O que tem

- Tela inteira, janela, guia ou jogo, com áudio estéreo.
- **Sem Discord**: com a opção ligada, o seletor só oferece janela e guia, que levam só o próprio som (o som da tela inteira inclui o Discord). Se o navegador não deixar esconder a tela inteira e ela for escolhida, o BAGRENATION corta o áudio e avisa. O botão de ajuda explica cada caso e como rotear o Discord para outra saída no Windows.
- Medidor do áudio que está saindo e destaque verde na tela e no avatar de quem está com som tocando.
- Qualidade de 720p/30 até 1440p/60 e prioridade entre fluidez (jogos) e nitidez (texto), trocáveis durante a transmissão.
- Trocar a tela transmitida sem encerrar.
- Volume e mudo separados para cada transmissão; quem transmite pode silenciar o próprio áudio para todos.
- Tela cheia, janela flutuante (picture-in-picture) e modo destaque.
- Números reais de cada transmissão: resolução, quadros por segundo, taxa e latência; quem transmite vê quantos estão assistindo e se o limite é a rede ou o processador.
- Indicador de conexão e reconexão automática.
- A sala continua existindo quando quem criou sai, e o mesmo link segue valendo.
- Chat leve, sem histórico.
- Funciona no celular para assistir.
- Sons 8-bit opcionais na interface (desligados por padrão).

## Visual

Interface de fliperama cyberpunk em pixel art: tela de abertura "Press Start", HUD, botões que afundam ao clicar, linhas de CRT e falha de sinal no logo. Os ícones 16×16, as molduras em degrau e o mascote (um bagre de viseira, com dois quadros de animação) são desenhados em grade de texto dentro de `tools/pixel.py`, que gera o SVG embutido no `index.html`, as molduras do `style.css` e o `favicon.svg`:

```bash
python tools/pixel.py
```

Com `prefers-reduced-motion`, as linhas de CRT, o glitch e as animações são desligados.

## Como funciona

O vídeo e o áudio vão de navegador para navegador por WebRTC, criptografados, sem passar por servidor. O único serviço externo é o servidor público de sinalização do [PeerJS](https://peerjs.com/), usado só para os navegadores se encontrarem.

Cada sala tem um ID de 6 caracteres (31 símbolos, ≈ 887 milhões de combinações) sorteado com gerador criptográfico. Links antigos com código de 10 caracteres continuam valendo. Um dos participantes mantém o "diretório" da sala (a lista de quem está dentro); se ele sai, outro assume automaticamente. Os participantes se ligam em malha, e quem transmite envia uma cópia para cada espectador.

O site é estático: `index.html`, `style.css`, `app.js`, a biblioteca PeerJS e as fontes, todos servidos do próprio repositório. Não há build.

## Limites

- **Redes muito restritas.** O projeto usa apenas STUN. Se as duas pontas estiverem atrás de CGNAT ou NAT simétrico, a conexão direta pode não fechar. A solução é configurar um servidor TURN na constante `ICE` do `app.js`.
- **Upload.** Quem transmite envia uma cópia por espectador. Em 1080p/60 cada cópia pode chegar a 10 Mb/s; para grupos grandes, reduza a qualidade.
- **Áudio.** Chrome e Edge enviam o áudio de uma guia em qualquer sistema e o áudio do sistema inteiro só no Windows. Firefox e Safari não capturam áudio de tela.
- **Celular** não transmite tela (os navegadores móveis não oferecem essa função), só assiste.
- **Quem tem o ID entra.** Não há senha; todo participante aparece na lista da sala. O ID curto é mais fácil de adivinhar que um código longo: para algo sigiloso, não use o BAGRENATION.
- **Sem Discord** não separa aplicativos dentro do som do sistema (nenhum navegador permite isso). Ele funciona escolhendo uma fonte sem o Discord: guia (Chrome/Edge) ou janela (Chrome/Edge recentes, que oferecem o áudio só da janela).
- **Sinalização de terceiros.** O servidor público do PeerJS é gratuito, sem garantia de disponibilidade, e enxerga os identificadores das salas (não o vídeo nem o áudio). Se ele cair, ninguém novo entra; as transmissões abertas continuam.

## Rodar e testar

```bash
python -m http.server 8000        # abra http://localhost:8000
```

O teste de ponta a ponta abre vários navegadores reais, cria uma sala, transmite uma tela simulada e confere 20 etapas (abertura, ID inválido e inexistente recusados, entrada digitando o ID, recarregar sem perder a sala, vídeo e áudio chegando, volume, Sem Discord, chat, duas transmissões, queda de rede, saída de quem criou a sala, celular, menos movimento):

```bash
pip install playwright && playwright install chromium
python tests/test_e2e.py                                   # servidor local
python tests/test_e2e.py https://alissonlittig.github.io/bagrenation/   # site publicado
```

## Origem

O BAGRENATION (antes chamado Telão) nasceu de uma análise do projeto [Streamcord](https://github.com/felipedays/streamcord), que tem a mesma proposta. Aquele repositório não tem licença, então nenhum código foi reaproveitado: tudo aqui foi escrito do zero. A análise completa, com os problemas encontrados e as provas, está em [ANALISE.md](ANALISE.md).

## Licenças

Código sob licença MIT (arquivo `LICENSE`). Inclui [PeerJS 1.5.5](https://github.com/peers/peerjs) (MIT, `vendor/PEERJS-LICENSE.txt`) e as fontes [Press Start 2P](https://fonts.google.com/specimen/Press+Start+2P) e [VT323](https://fonts.google.com/specimen/VT323) (SIL OFL 1.1, `fonts/*-LICENSE.txt`).
