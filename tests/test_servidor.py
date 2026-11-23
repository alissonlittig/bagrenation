"""S-1318: servidor fixo (como um servidor do Discord) com 2 navegadores ao mesmo tempo.

Prova: abrir = já estar no servidor (sem criar sala), ver quem está online, entrar e sair do canal de voz pelo
botão, voz e tela só entre quem está no canal, chat de texto permanente com imagem (botão), GIF (colar) e vídeo
(arrastar), tudo chegando no outro e continuando lá depois de recarregar.
Usa um servidor de teste (?servidor=teste-...), então não aparece no BAGRENATION de verdade.
Uso:  python tests/test_servidor.py [url_base] [pasta_prints]
Requer: pip install playwright pillow && playwright install chromium; internet (Worker do chat).
"""
import functools
import http.server
import io
import pathlib
import secrets
import sys
import threading

from PIL import Image
from playwright.sync_api import expect, sync_playwright

sys.path.insert(0, str(pathlib.Path(__file__).parent))
import test_e2e as T  # noqa: E402

SRV = f"teste-{secrets.token_hex(4)}"


def png():
    b = io.BytesIO()
    Image.new("RGB", (320, 180), (0, 240, 255)).save(b, "PNG")
    return b.getvalue()


def gif():
    frames = [Image.new("RGB", (120, 120), c) for c in ((255, 43, 214), (255, 230, 0), (57, 255, 136))]
    b = io.BytesIO()
    frames[0].save(b, "GIF", save_all=True, append_images=frames[1:], duration=200, loop=0)
    return b.getvalue()


# vídeo webm de verdade, gravado no próprio navegador (canvas animado + MediaRecorder), largado no chat como arquivo
DROP_VIDEO = """async () => {
  const c = Object.assign(document.createElement('canvas'), { width: 320, height: 240 });
  const g = c.getContext('2d');
  const rec = new MediaRecorder(c.captureStream(30), { mimeType: 'video/webm' });
  const parts = [];
  rec.ondataavailable = (e) => parts.push(e.data);
  let n = 0;
  const t = setInterval(() => { g.fillStyle = `hsl(${n++ * 12} 80% 50%)`; g.fillRect(0, 0, 320, 240); }, 33);
  rec.start();
  await new Promise((r) => setTimeout(r, 1500));
  rec.stop(); clearInterval(t);
  await new Promise((r) => { rec.onstop = r; });
  const file = new File(parts, 'clipe.webm', { type: 'video/webm' });
  const dt = new DataTransfer(); dt.items.add(file);
  const chat = document.getElementById('chat');
  for (const type of ['dragenter', 'dragover', 'drop']) chat.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
  return file.size;
}"""

PASTE_GIF = """async (bytes) => {
  const file = new File([new Uint8Array(bytes)], 'dancinha.gif', { type: 'image/gif' });
  const dt = new DataTransfer(); dt.items.add(file);
  document.getElementById('chatInput').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
}"""


def msg(pg, text):
    return pg.locator("#chatLog .msg", has=pg.locator(".msg-text", has_text=text))


def media_ok(pg):
    """Todas as imagens/GIFs do chat carregaram do Worker e o vídeo tem duração."""
    pg.wait_for_function("""() => {
      const imgs = [...document.querySelectorAll('#chatLog .msg-media img')];
      const vids = [...document.querySelectorAll('#chatLog .msg-media video')];
      return imgs.length >= 2 && vids.length >= 1 && imgs.every((i) => i.complete && i.naturalWidth > 0) && vids.every((v) => v.readyState >= 1 && v.duration > 0);
    }""", timeout=30000)


def run(base, shots):
    T.SHOTS = shots
    url = f"{base}?servidor={SRV}"
    steps = []
    step = lambda s: (steps.append(s), print("ok:", s, flush=True))
    with sync_playwright() as p:
        br = T.launch(p)
        a = T.page(br, "Ana")
        a.goto(url)
        # 1. abriu = já está no servidor: pergunta o nome só na primeira vez, sem criar/entrar em sala
        expect(a.locator("#nameDlg")).to_be_visible()
        expect(a.locator("#room")).to_be_visible()
        T.shot(a, "40_primeira_vez_nome")
        a.fill("#homeName", "Ana")
        a.click("#nameForm [type=submit]")
        expect(a.locator("#nameDlg")).to_be_hidden()
        T.connected(a)
        expect(a.locator("#chanChat")).to_have_attribute("aria-current", "page")
        b = T.page(br, "Bruno")
        b.goto(url)
        b.fill("#homeName", "Bruno")
        b.click("#nameForm [type=submit]")
        T.connected(b)
        for pg in (a, b):
            expect(pg.locator("#peopleCountSide")).to_have_text("2", timeout=45000)
            expect(pg.locator("#people li")).to_have_count(0)  # ninguém no canal de voz ainda
        assert a.evaluate("async () => (await BAGRENATION.voiceStats()).length") == 0
        step("os dois abriram direto no servidor, se veem online e ninguém entrou na voz sozinho")

        # 2. chat: texto, imagem (botão), GIF (colar) e vídeo (arrastar)
        a.fill("#chatInput", "salve bagres, https://example.com")
        a.press("#chatInput", "Enter")
        expect(msg(b, "salve bagres")).to_have_count(1, timeout=15000)
        expect(msg(b, "salve bagres").locator("a")).to_have_attribute("href", "https://example.com")
        b.set_input_files("#fileInput", files=[{"name": "print.png", "mimeType": "image/png", "buffer": png()}])
        expect(b.locator("#attach .att")).to_have_count(1)
        b.fill("#chatInput", "olha a imagem")
        T.shot(b, "41_previa_anexo")
        b.press("#chatInput", "Enter")
        expect(msg(a, "olha a imagem").locator(".msg-media img")).to_have_count(1, timeout=30000)
        a.evaluate(PASTE_GIF, list(gif()))
        expect(a.locator("#attach .att")).to_have_count(1)
        a.click("#chatForm [type=submit]")
        expect(b.locator(".msg-media .gif-tag")).to_have_count(1, timeout=30000)
        size = b.evaluate(DROP_VIDEO)
        expect(b.locator("#attach .att video")).to_have_count(1)
        b.fill("#chatInput", "e o video")
        b.press("#chatInput", "Enter")
        expect(msg(a, "e o video").locator(".msg-media video")).to_have_count(1, timeout=30000)
        for pg in (a, b):
            media_ok(pg)
        T.shot(a, "42_chat_texto_imagem_gif_video")
        step(f"texto com link, imagem (botão), GIF (colar) e vídeo webm de {size // 1024} KB (arrastar) chegaram e abriram nos dois")

        # 3. o histórico fica: recarregar
        b.reload()
        T.connected(b)
        expect(b.locator("#nameDlg")).to_be_hidden()  # nome lembrado: abre direto
        expect(msg(b, "salve bagres")).to_have_count(1, timeout=20000)
        expect(msg(b, "olha a imagem")).to_have_count(1)
        expect(msg(b, "e o video")).to_have_count(1)
        media_ok(b)
        assert b.locator("#chatLog .msg.mine").count() >= 2, "mensagens do Bruno não marcadas como dele"
        step("depois de recarregar, o histórico (texto, imagem, GIF, vídeo) continua lá")
        expect(a.locator("#peopleCountSide")).to_have_text("2", timeout=45000)

        # 4. canal de voz: A entra pelo canal da lateral; B vê A no canal mas não liga voz
        a.click("#chanVoice")
        expect(a.locator("#vconn")).to_be_visible()
        expect(a.locator("#room")).to_have_attribute("data-view", "voice")
        expect(T.row(b, "Ana")).to_have_count(1, timeout=20000)
        expect(b.locator("#voiceCount")).to_have_text("1")
        b.wait_for_timeout(3000)
        assert b.evaluate("async () => (await BAGRENATION.voiceStats()).length") == 0, "voz ligada com quem está fora do canal"
        T.shot(b, "43_fora_vendo_canal")
        step("Ana entrou no canal; Bruno vê Ana no canal sem ter voz ligada")
        b.click("#chanVoice")
        b.click("#joinVoiceBtn") if b.locator("#joinVoiceBtn").is_visible() else None
        for pg in (a, b):
            T.voice_ready(pg, 1)
        T.hears(b, "Ana")
        T.hears(a, "Bruno")
        expect(a.locator("#voiceCount")).to_have_text("2")
        step("Bruno entrou: os dois se ouvem (Opus nos dois sentidos)")

        # 5. tela dentro do canal + parar de assistir
        a.click("#shareBtn")
        T.playing(b)
        T.shot(b, "44_tela_no_canal_com_chat")
        b.click(".tile .js-unwatch")
        expect(b.locator(".tile")).to_have_count(0)
        T.row(b, "Ana").locator(".wbtn").click()
        T.playing(b)
        step("Ana compartilha a tela; Bruno assiste, para de assistir e volta")

        # 6. Bruno sai do canal: some da voz e da tela, continua online e no chat
        b.click("#leaveBtn")
        expect(b.locator("#vconn")).to_be_hidden()
        expect(T.row(a, "Bruno")).to_have_count(0, timeout=15000)
        a.wait_for_function("async () => (await BAGRENATION.voiceStats()).length === 0", timeout=15000)
        a.wait_for_function("async () => (await BAGRENATION.screen()).every((x) => !x.out)", timeout=15000)
        expect(b.locator(".tile")).to_have_count(0)
        expect(b.locator("#peopleCountSide")).to_have_text("2")
        b.fill("#chatInput", "saí da voz mas tô aqui")
        b.press("#chatInput", "Enter")
        expect(msg(a, "saí da voz")).to_have_count(1, timeout=15000)
        step("Bruno saiu do canal: voz e tela com ele fecharam, segue online e no chat")
        a.click("#shareBtn")  # para a tela
        a.click("#leaveBtn")
        expect(a.locator("#people li")).to_have_count(0)

        # 7. celular: lateral vira gaveta, chat ocupa a tela
        m = T.page(br, "Celular", viewport={"width": 390, "height": 844})
        m.goto(url)
        m.fill("#homeName", "Cel")
        m.click("#nameForm [type=submit]")
        T.connected(m)
        expect(msg(m, "e o video")).to_have_count(1, timeout=20000)
        m.wait_for_timeout(1500)
        T.shot(m, "45_celular_chat")
        m.click("#chanBtn")
        expect(m.locator("#panel")).to_be_visible()
        T.shot(m, "46_celular_canais")
        m.click("#chanVoice")
        expect(m.locator("#panel")).to_be_hidden()
        T.voice_ready(m, 0)
        T.shot(m, "47_celular_voz")
        step("celular: chat com histórico, gaveta de canais e canal de voz")
        br.close()
    assert not T.errors, "erros de console:\n" + "\n".join(T.errors)
    print(f"SERVIDOR OK ({len(steps)} passos), 0 erro de console, servidor de teste {SRV}")


if __name__ == "__main__":
    shots = pathlib.Path(sys.argv[2]) if len(sys.argv) > 2 else None
    if len(sys.argv) > 1 and sys.argv[1].startswith("http"):
        run(sys.argv[1], shots)
    else:
        h = functools.partial(type("Q", (http.server.SimpleHTTPRequestHandler,), {"log_message": lambda *a: None}), directory=str(T.ROOT))
        srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), h)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        run(f"http://127.0.0.1:{srv.server_address[1]}/", shots)
