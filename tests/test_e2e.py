"""Teste de ponta a ponta do BAGRENATION com navegadores reais (Playwright + mídia falsa).

Uso:  python tests/test_e2e.py                 (sobe um servidor local com os arquivos do projeto)
      python tests/test_e2e.py https://...     (testa um endereço já publicado)
Requer: pip install playwright && playwright install chromium
Usa o servidor público de sinalização do PeerJS, então precisa de internet.
"""
import functools
import re
import http.server
import pathlib
import sys
import threading

from playwright.sync_api import expect, sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
SHOTS = pathlib.Path(sys.argv[2]) if len(sys.argv) > 2 else None

# Substitui o seletor de tela por um canvas animado 1920x1080 + tom de 440 Hz.
FAKE_SCREEN = """
navigator.mediaDevices.getDisplayMedia = async (opts) => {
  window.__gdm = opts;
  const c = Object.assign(document.createElement('canvas'), { width: 1920, height: 1080 });
  const g = c.getContext('2d');
  let n = 0;
  setInterval(() => {
    g.fillStyle = `hsl(${n % 360} 70% 40%)`; g.fillRect(0, 0, 1920, 1080);
    g.fillStyle = '#fff'; g.font = '160px sans-serif'; g.fillText('quadro ' + n++, 200, 560);
  }, 33);
  const ac = new AudioContext();
  const osc = ac.createOscillator(), dest = ac.createMediaStreamDestination();
  osc.connect(dest); osc.start();
  const v = c.captureStream(30).getVideoTracks()[0];
  const real = v.getSettings.bind(v);
  v.getSettings = () => ({ ...real(), displaySurface: window.__surface }); // simula o tipo escolhido no seletor
  return new MediaStream([v, ...dest.stream.getAudioTracks()]);
};
"""

# Pico do sinal de áudio recebido na primeira tela (0 = silêncio).
AUDIO_PEAK = """async () => {
  const ac = new AudioContext(); await ac.resume();
  const an = ac.createAnalyser();
  ac.createMediaStreamSource(document.querySelector('.tile video').srcObject).connect(an);
  await new Promise(r => setTimeout(r, 1200));
  const d = new Float32Array(an.fftSize); an.getFloatTimeDomainData(d);
  return Math.max(...d.map(Math.abs));
}"""

# O Chromium sem janela ignora a política de autoplay (e já nasce "ativado"); isto reproduz a regra do Chrome real:
# tocar com som antes do primeiro clique na página é recusado.
BLOCK_AUTOPLAY = """
let clicked = false;
addEventListener('pointerdown', (e) => { clicked = clicked || e.isTrusted; }, true);
const realPlay = HTMLMediaElement.prototype.play;
HTMLMediaElement.prototype.play = function () {
  if (!this.muted && !clicked)
    return Promise.reject(new DOMException('play() sem gesto', 'NotAllowedError'));
  return realPlay.call(this);
};
"""

errors = []


def page(browser, name, viewport=None, fake=True):
    ctx = browser.new_context(viewport=viewport or {"width": 1366, "height": 768})
    ctx.grant_permissions(["clipboard-read", "clipboard-write"])
    pg = ctx.new_page()
    if fake:
        pg.add_init_script(FAKE_SCREEN)
    pg.on("console", lambda m: m.type == "error" and errors.append(f"[{name}] console: {m.text}"))
    pg.on("pageerror", lambda e: errors.append(f"[{name}] excecao: {e}"))
    pg.set_default_timeout(30000)
    return pg


def connected(pg):
    expect(pg.locator("#status")).to_have_attribute("data-state", "ok", timeout=45000)


def playing(pg, nth=0):
    """A tela nth está recebendo quadros de verdade (o tempo do vídeo anda)."""
    v = pg.locator(".tile video").nth(nth)
    expect(v).to_be_visible()
    pg.wait_for_function("i => { const v = document.querySelectorAll('.tile video')[i]; return v && v.videoWidth > 0 && v.currentTime > 0.5; }", arg=nth, timeout=45000)
    t0 = v.evaluate("v => v.currentTime")
    pg.wait_for_timeout(1200)
    assert v.evaluate("v => v.currentTime") > t0, "vídeo congelado"


def shot(pg, name):
    if SHOTS:
        SHOTS.mkdir(parents=True, exist_ok=True)
        pg.screenshot(path=str(SHOTS / f"{name}.png"))


def run(base):
    with sync_playwright() as p:
        browser = p.chromium.launch()
        steps = []
        step = lambda s: (steps.append(s), print("ok:", s, flush=True))

        # 1. início sem erro; ID com formato errado e ID de sala que não existe são recusados
        a = page(browser, "A")
        a.goto(base)
        # 0. abertura: PRESS START leva ao início; nome novo na aba; som 8-bit nasce desligado
        assert a.title().startswith("BAGRENATION"), a.title()
        expect(a.locator("#title .logo")).to_have_text("BAGRENATION")
        expect(a.locator("#home")).to_be_hidden()
        shot(a, "00_abertura_desktop")
        a.click("#startBtn")
        expect(a.locator("#title")).to_be_hidden()
        expect(a.locator("h1")).to_be_visible()
        sfx = a.locator("#home .js-sfx")
        expect(sfx).to_have_attribute("aria-pressed", "false")
        sfx.click()
        expect(sfx).to_have_attribute("aria-pressed", "true")
        expect(sfx).to_contain_text("on")
        sfx.click()
        expect(sfx).to_have_attribute("aria-pressed", "false")
        step("abertura PRESS START, título BAGRENATION, som 8-bit desligado por padrão e alternável")
        a.fill("#joinInput", "isso nao e sala")
        a.click("#joinForm [type=submit]")
        expect(a.locator("#joinError")).to_contain_text("6 letras")
        a.fill("#joinInput", "zzzzzz")
        a.click("#joinForm [type=submit]")
        expect(a.locator("#joinError")).to_contain_text("Nenhuma sala ZZZ-ZZZ", timeout=20000)
        expect(a.locator("#home")).to_be_visible()
        a_crt = a.evaluate("getComputedStyle(document.body, '::after').display")
        shot(a, "01_inicio_desktop")
        step("início + ID inválido e ID inexistente recusados")

        # 2. criar sala gera ID de 6 caracteres; copiar ID e copiar link
        a.fill("#homeName", "Ana")
        a.click("#createBtn")
        connected(a)
        assert a.title().endswith("BAGRENATION"), a.title()
        shot(a, "01b_sala_vazia_desktop")
        link = a.url
        code = link.split("#")[1]
        assert len(code) == 7 and code[3] == "-" and code == code.upper(), code
        expect(a.locator("#roomId b")).to_have_count(6)
        a.click("#copyBtn")
        assert a.evaluate("navigator.clipboard.readText()") == code
        a.click("#copyLinkBtn")
        assert a.evaluate("navigator.clipboard.readText()") == link
        step(f"sala {code} criada; ID e link copiados")

        # 3. segundo navegador entra DIGITANDO o ID (minúsculo, sem hífen); os dois se veem
        b = page(browser, "B")
        b.goto(base)
        b.keyboard.press("Enter")  # qualquer tecla passa da abertura
        b.fill("#homeName", "Bruno")
        b.fill("#joinInput", code.replace("-", "").lower())
        expect(b.locator("#joinInput")).to_have_value(code.replace("-", ""))
        b.click("#joinForm [type=submit]")
        connected(b)
        assert b.url.endswith("#" + code)
        for pg in (a, b):
            expect(pg.locator("#peopleCount")).to_have_text("2", timeout=45000)
        step("B entrou digitando o ID (2 na sala)")

        # 3b. recarregar a página não perde a sala
        b.reload()
        connected(b)
        assert b.url.endswith("#" + code)
        for pg in (a, b):
            expect(pg.locator("#peopleCount")).to_have_text("2", timeout=45000)
        step("B recarregou e continua na mesma sala")

        # 4. A transmite; B recebe vídeo e áudio
        a.click("#shareBtn")
        expect(a.locator(".tile")).to_have_count(1)
        playing(b)
        assert b.locator(".tile video").evaluate("v => v.srcObject.getAudioTracks().length") == 1, "sem faixa de áudio"
        expect(b.locator(".tile-name")).to_have_text("Ana")
        expect(b.locator(".tile-stats")).to_contain_text("1920×1080", timeout=15000)
        expect(a.locator(".tile-stats")).to_contain_text("1 pessoa assistindo", timeout=15000)
        shot(b, "02_assistindo_desktop")
        step("B recebe a transmissão 1920×1080 com áudio; números reais na barra")

        # 5. som: bloqueio de autoplay tratado; mutar e volume por transmissão
        vid = b.locator(".tile video")
        if b.locator(".unblock").is_visible():
            assert vid.evaluate("v => v.muted")
            b.click(".unblock")
        assert not vid.evaluate("v => v.muted")
        assert b.evaluate(AUDIO_PEAK) > 0.1, "áudio não chega ao espectador"
        b.click(".js-mute")
        assert vid.evaluate("v => v.muted")
        b.click(".js-mute")
        b.locator(".js-vol").fill("0.3")
        assert abs(vid.evaluate("v => v.volume") - 0.3) < 0.01 and not vid.evaluate("v => v.muted")
        b.locator(".js-vol").fill("0")
        expect(b.locator(".js-mute")).to_have_attribute("aria-pressed", "true")
        b.click(".js-mute")  # sair do volume zero pelo botão devolve som audível
        assert vid.evaluate("v => v.volume") == 0.5 and not vid.evaluate("v => v.muted")
        expect(b.locator(".tile")).to_have_class(re.compile("speaking"), timeout=5000)  # tela acende com som
        expect(b.locator("#people li.is-live .avatar.speaking")).to_have_count(1)
        assert a.locator("#meter i.on").count() >= 3, "medidor de áudio enviado parado"
        step("ativar som, mutar, volume e saída do volume zero")

        # 6. quem transmite silencia o próprio áudio para todos
        a.click("#audioBtn")
        expect(a.locator("#audioBtn")).to_have_attribute("aria-pressed", "true")
        assert not a.evaluate("document.querySelector('.tile video').srcObject.getAudioTracks()[0].enabled")
        assert b.evaluate(AUDIO_PEAK) < 0.01, "áudio silenciado ainda chega"
        a.click("#audioBtn")
        step("transmissor silencia e reativa o áudio enviado")

        # 7. trocar qualidade e prioridade ao vivo não derruba a transmissão
        a.click("#settingsBtn")
        a.select_option("#quality", "720p30")
        a.select_option("#hint", "detail")
        a.keyboard.press("Escape")
        expect(a.locator("#settings")).to_be_hidden()
        playing(b)
        step("qualidade/prioridade trocadas ao vivo")

        # 7b. Sem Discord: seletor sem tela inteira; tela inteira escolhida mesmo assim = áudio cortado; janela mantém áudio
        local_audio = "document.querySelector('.tile video').srcObject.getAudioTracks().length"
        a.evaluate("window.__surface = 'monitor'")
        a.click("#discordBtn")  # transmitindo: reabre o seletor na hora
        expect(a.locator("#discordBtn")).to_have_attribute("aria-pressed", "true")
        a.wait_for_function("window.__gdm && window.__gdm.monitorTypeSurfaces === 'exclude'")
        assert a.evaluate("[window.__gdm.systemAudio, window.__gdm.windowAudio]") == ["exclude", "window"]
        a.wait_for_function(f"{local_audio} === 0")
        expect(a.locator("#toasts")).to_contain_text("áudio foi cortado")
        expect(a.locator("#audioBtn")).to_be_disabled()
        a.evaluate("window.__surface = 'window'")
        a.click("#swapBtn")
        a.wait_for_function(f"{local_audio} === 1")
        expect(a.locator("#toasts")).to_contain_text("só o som desta janela")
        a.click("#discordBtn")
        expect(a.locator("#discordBtn")).to_have_attribute("aria-pressed", "false")
        a.evaluate("window.__surface = undefined")
        a.click("#swapBtn")
        a.wait_for_function("window.__gdm.monitorTypeSurfaces === 'include'")
        playing(b)
        assert b.evaluate(AUDIO_PEAK) > 0.1, "áudio não voltou depois de desligar Sem Discord"
        a.click("#guideBtn")
        expect(a.locator("#guideDlg")).to_be_visible()
        shot(a, "07_guia_discord")
        a.keyboard.press("Escape")
        step("Sem Discord: opções do seletor, corte na tela inteira, janela com áudio, guia")

        # 8. chat: entrega e não interpreta HTML
        a.click("#panelBtn") if a.locator("#panel").is_hidden() else None
        a.fill("#chatInput", '<img src=x onerror="document.title=1">oi')
        a.press("#chatInput", "Enter")
        b.click("#panelBtn") if b.locator("#panel").is_hidden() else None
        expect(b.locator("#chatLog")).to_contain_text("<img src=x")
        assert b.locator("#chatLog img").count() == 0
        step("chat entregue como texto puro")

        # 9. quem chega depois já recebe a transmissão em andamento
        c = page(browser, "C")
        c.add_init_script(BLOCK_AUTOPLAY)
        c.goto(link)
        connected(c)
        playing(c)
        expect(c.locator(".unblock")).to_be_visible()
        assert c.locator(".tile video").evaluate("v => v.muted")
        c.click(".unblock")
        expect(c.locator(".unblock")).to_be_hidden()
        assert not c.locator(".tile video").evaluate("v => v.muted")
        for pg in (a, b, c):
            expect(pg.locator("#peopleCount")).to_have_text("3", timeout=45000)
        step("C entrou depois e recebeu a transmissão (3 na sala)")

        # 10. duas transmissões ao mesmo tempo + destaque
        b.click("#shareBtn")
        expect(c.locator(".tile")).to_have_count(2, timeout=45000)
        playing(c, 1)
        c.locator(".js-focus").first.click()
        expect(c.locator(".tile.focused")).to_have_count(1)
        shot(c, "03_duas_telas_destaque")
        c.locator(".tile.focused .js-focus").click()
        step("duas transmissões simultâneas e modo destaque")

        # 10b. dentro da sala, ID inexistente não troca a sala
        c.click("#joinOtherBtn")
        c.fill("#joinOtherInput", "zzzzzz")
        c.click("#joinOtherForm [type=submit]")
        expect(c.locator("#joinOtherError")).to_contain_text("Nenhuma sala", timeout=20000)
        c.keyboard.press("Escape")
        assert c.url.endswith("#" + code)
        connected(c)
        expect(c.locator(".tile")).to_have_count(2)
        step("ID inexistente dentro da sala não troca a sala")

        # 11. parar remove a tela de quem assiste
        b.click("#shareBtn")
        expect(c.locator(".tile")).to_have_count(1, timeout=20000)
        step("parar transmissão remove a tela dos espectadores")

        # 12. queda de internet de quem assiste: indica e volta sozinho
        c.context.set_offline(True)
        expect(c.locator("#status")).to_have_attribute("data-state", "offline", timeout=15000)
        c.wait_for_timeout(4000)
        c.context.set_offline(False)
        connected(c)
        playing(c)
        step("queda de rede sinalizada e recuperada")

        # 13. quem criou a sala sai: a sala continua e o link segue valendo
        a.close()
        for pg in (b, c):
            expect(pg.locator("#peopleCount")).to_have_text("2", timeout=45000)
            expect(pg.locator(".tile")).to_have_count(0, timeout=20000)
        d = page(browser, "D")
        d.goto(link)
        connected(d)
        for pg in (b, c, d):
            connected(pg)
            expect(pg.locator("#peopleCount")).to_have_text("3", timeout=60000)
        b.click("#shareBtn")
        playing(d)
        playing(c)
        step("criador saiu, sala sobreviveu, D entrou pelo mesmo link e assiste B")

        # 14. celular: assiste, sem estouro lateral
        m = page(browser, "celular", viewport={"width": 390, "height": 844})
        m.goto(base)
        assert m.evaluate("document.documentElement.scrollWidth") <= 390
        shot(m, "04a_abertura_celular")
        m.click("#startBtn")
        expect(m.locator("#home")).to_be_visible()
        assert m.evaluate("document.documentElement.scrollWidth") <= 390
        shot(m, "04_inicio_celular")
        m.goto(link)  # só muda o #código: entra na sala sem recarregar
        connected(m)
        playing(m)
        assert m.evaluate("document.documentElement.scrollWidth") <= 390
        shot(m, "05_assistindo_celular")
        m.click("#panelBtn")
        expect(m.locator("#roomId b")).to_have_count(6)
        shot(m, "06_painel_celular")
        m.click("#panelClose")
        step("celular 390×844 assiste sem estouro lateral")

        # 15. sair volta ao início e avisa a sala
        d.click("#leaveBtn")
        expect(d.locator("#home")).to_be_visible()
        expect(b.locator("#peopleCount")).to_have_text("3", timeout=30000)  # b, c, celular
        step("sair volta ao início")

        # 16. menos movimento: sem linhas de CRT e sem animação no logo; link de sala pula a abertura
        r = browser.new_context(reduced_motion="reduce").new_page()
        r.on("console", lambda msg: msg.type == "error" and errors.append(f"[reduzido] console: {msg.text}"))
        r.goto(base)
        assert r.evaluate("getComputedStyle(document.body, '::after').display") == "none"
        assert r.evaluate("getComputedStyle(document.querySelector('.glitch'), '::before').animationName") == "none"
        assert a_crt == "block", a_crt
        expect(d.locator("#title")).to_be_hidden()
        step("prefers-reduced-motion desliga CRT e glitch")

        browser.close()

    assert not errors, "erros de console:\n" + "\n".join(errors)
    print(f"TUDO OK — {len(steps)} etapas, 0 erro de console")


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1].startswith("http"):
        run(sys.argv[1])
    else:
        class Quiet(http.server.SimpleHTTPRequestHandler):
            def log_message(self, *a):
                pass

        handler = functools.partial(Quiet, directory=str(ROOT))
        srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        run(f"http://127.0.0.1:{srv.server_address[1]}/")
