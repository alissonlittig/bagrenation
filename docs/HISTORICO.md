# BAGRENATION - Histórico

Fonte: `git log` (tags `v1.0.0` a `v1.9.x` no repositório). Antes de 15/11/2026 o projeto era o **Telão** (compartilhamento de tela por link).

## Antes do nome BAGRENATION (13/11/2026)
| Job | O que mudou |
|---|---|
| S-1054 | Telão: compartilhamento de tela por link (WebRTC ponto a ponto), áudio de janela |
| S-1103 | Telão v2: interface tipo app, entrada por ID de 6 caracteres, "Sem Discord" |
| S-1115 | Novo nome **BAGRENATION** e interface de fliperama cyberpunk em pixel art |

## Versões (site + app de PC; a partir da 1.9.0 o Android sai junto)
| Versão | Data | Job | O que mudou |
|---|---|---|---|
| (site) | 13/11/2026 | S-1141, S-1172 | Menos texto de venda; chat de voz em malha WebRTC (Opus 48 kHz estéreo), avatares em pixel art |
| (site) | 13/11/2026 | S-1180, S-1183, S-1184 | Galeria de avatares em abas e rostos estilo anime |
| (site) | 13/11/2026 | S-1202, S-1209, S-1214 | Parar de assistir uma tela e continuar na voz; selo AO VIVO + Assistir |
| 1.0.1 | 14/11/2026 | S-1215 | App para PC (Tauri 2): tecla global de falar/mutar, bandeja, abrir com o Windows, atualização pelo GitHub Releases |
| 1.1.0 | 15/11/2026 | S-1318 | Servidor fixo como no Discord: canal de voz + #chat permanente com imagem, GIF e vídeo |
| 1.1.1 | 15/11/2026 | S-1351 | Modo foco no canal de voz |
| 1.1.2 | 15/11/2026 | S-1354 | Tela inteira sem a voz do BAGRENATION; botão Retrair laterais |
| 1.2.0 | 16/11/2026 | S-1357 | Membros Online/Ausente/Offline, status, "digitando", reagir/responder/copiar/editar/apagar |
| 1.3.0 | 16/11/2026 | S-1363 | Vários canais de texto e voz, volume por pessoa até 200%, qualidade 720p/1080p/fonte e 30/60 fps |
| 1.3.1 | 16/11/2026 | S-1378 | Retrair só o chat; qualquer um cria/renomeia/apaga canal |
| 1.4.0 | 16/11/2026 | S-1382 | Sinalização WebRTC pelo próprio Worker (rota `/rtc`), STUN da Cloudflare e TURN opcional; saiu o PeerJS público |
| 1.4.1 | 16/11/2026 | S-1397 | Avatar próprio (PNG/JPG/WEBP/GIF até 5 MB, recorte com zoom) |
| 1.5.0 | 16/11/2026 | S-1412 | Perfil estilo Discord (Sobre mim, nota privada, membro desde) |
| 1.6.0 | 20/11/2026 | S-1564 | Tela cheia imersiva estilo YouTube; pesquisa do bot de música |
| 1.7.0 | 20/11/2026 | S-1566 | Bagre DJ: música do YouTube sincronizada no canal de voz |
| 1.8.0 | 20/11/2026 | S-1580 | Bagre DJ como bot de Discord: nome ou link (YouTube, Spotify) toca direto; só áudio no app |
| 1.8.1 | 21/11/2026 | S-0033, S-0037 | Comandos com `!` e `/`, Tocando agora, fila paginada, letra, autoplay; testes com 3 clientes |
| 1.8.2 | 22/11/2026 | S-0059 | Bagre DJ fora do chat, link clicável no app de PC, tempo de chamada |
| 1.9.0 | 22/11/2026 | S-0059 | App de PC e APK Android na mesma versão |
| 1.9.1 | 22/11/2026 | S-0065 | Servidor fechado com convite, Membros do dono, Bagre DJ que para de verdade; Worker reconecta conexão aberta antes do portão |
| 1.9.2 | 23/11/2026 | S-0069 | Android se atualiza sozinho; gaveta de canais pela esquerda no celular |

Versões e datas conferidas pelos títulos dos commits; algumas versões intermediárias (1.2.1, 1.9.x de teste) não aparecem como commit próprio.
