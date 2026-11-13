# Telão

Compartilhamento de tela por link, direto no navegador. Sem conta, sem instalar nada e sem chamada de voz: só a tela (ou a janela, a guia, o jogo) com o áudio junto.

**Abrir:** https://alissonlittig.github.io/telao/

## Como usar

1. Clique em **Criar sala** e mande o link para quem vai assistir.
2. Clique em **Compartilhar tela** e escolha a guia, a janela ou o monitor. Para enviar som, marque "Compartilhar áudio" no seletor do navegador.
3. Quem abre o link entra direto e já vê a transmissão.

Mais de uma pessoa pode transmitir ao mesmo tempo na mesma sala.

## O que tem

- Tela inteira, janela, guia ou jogo, com áudio estéreo.
- Qualidade de 720p/30 até 1440p/60 e prioridade entre fluidez (jogos) e nitidez (texto), trocáveis durante a transmissão.
- Trocar a tela transmitida sem encerrar.
- Volume e mudo separados para cada transmissão; quem transmite pode silenciar o próprio áudio para todos.
- Tela cheia, janela flutuante (picture-in-picture) e modo destaque.
- Números reais de cada transmissão: resolução, quadros por segundo, taxa e latência; quem transmite vê quantos estão assistindo e se o limite é a rede ou o processador.
- Indicador de conexão e reconexão automática.
- A sala continua existindo quando quem criou sai, e o mesmo link segue valendo.
- Chat leve, sem histórico.
- Funciona no celular para assistir.

## Como funciona

O vídeo e o áudio vão de navegador para navegador por WebRTC, criptografados, sem passar por servidor. O único serviço externo é o servidor público de sinalização do [PeerJS](https://peerjs.com/), usado só para os navegadores se encontrarem.

Cada sala tem um código de 10 caracteres sorteado com gerador criptográfico. Um dos participantes mantém o "diretório" da sala (a lista de quem está dentro); se ele sai, outro assume automaticamente. Os participantes se ligam em malha, e quem transmite envia uma cópia para cada espectador.

O site é estático: `index.html`, `style.css`, `app.js`, a biblioteca PeerJS e a fonte, todos servidos do próprio repositório. Não há build.

## Limites

- **Redes muito restritas.** O projeto usa apenas STUN. Se as duas pontas estiverem atrás de CGNAT ou NAT simétrico, a conexão direta pode não fechar. A solução é configurar um servidor TURN na constante `ICE` do `app.js`.
- **Upload.** Quem transmite envia uma cópia por espectador. Em 1080p/60 cada cópia pode chegar a 10 Mb/s; para grupos grandes, reduza a qualidade.
- **Áudio.** Chrome e Edge enviam o áudio de uma guia em qualquer sistema e o áudio do sistema inteiro só no Windows. Firefox e Safari não capturam áudio de tela.
- **Celular** não transmite tela (os navegadores móveis não oferecem essa função), só assiste.
- **Quem tem o link entra.** Não há senha; todo participante aparece na lista da sala.

## Rodar e testar

```bash
python -m http.server 8000        # abra http://localhost:8000
```

O teste de ponta a ponta abre vários navegadores reais, cria uma sala, transmite uma tela simulada e confere 15 etapas (entrada por link, vídeo e áudio chegando, volume, chat, duas transmissões, queda de rede, saída de quem criou a sala, celular):

```bash
pip install playwright && playwright install chromium
python tests/test_e2e.py                                   # servidor local
python tests/test_e2e.py https://alissonlittig.github.io/telao/   # site publicado
```

## Origem

O Telão nasceu de uma análise do projeto [Streamcord](https://github.com/felipedays/streamcord), que tem a mesma proposta. Aquele repositório não tem licença, então nenhum código foi reaproveitado: tudo aqui foi escrito do zero. A análise completa, com os problemas encontrados e as provas, está em [ANALISE.md](ANALISE.md).

## Licenças

Código sob licença MIT (arquivo `LICENSE`). Inclui [PeerJS 1.5.5](https://github.com/peers/peerjs) (MIT, `vendor/PEERJS-LICENSE.txt`) e a fonte [Manrope](https://github.com/sharanda/manrope) (SIL OFL 1.1, `fonts/MANROPE-LICENSE.txt`).
