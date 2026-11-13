"""Teste de ponta a ponta do BAGRENATION com navegadores reais (Playwright + mídia falsa).

Três cenários: tela (compartilhamento), voz (3 abas com microfone falso + 1 sem microfone + celular)
e navegadores (Chromium com Edge e com Firefox: um cria, o outro entra pelo ID, os dois se ouvem).
Uso:  python tests/test_e2e.py                 (sobe um servidor local com os arquivos do projeto)
      ONLY=voz python tests/test_e2e.py        (só um cenário: tela, voz ou navegadores)
      python tests/test_e2e.py https://...     (testa um endereço já publicado)
      PW_CHANNEL=msedge python tests/test_e2e.py ...   (mesmo teste no Edge instalado)
Requer: pip install playwright && playwright install chromium
Usa o servidor público de sinalização do PeerJS, então precisa de internet.
"""
import functools
import math
import os
import re
import http.server
import pathlib
import struct
import sys
import tempfile
import threading
import wave

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
    if browser.browser_type.name == "chromium":
        ctx.grant_permissions(["clipboard-read", "clipboard-write"])
    pg = ctx.new_page()
    if fake:
        pg.add_init_script(FAKE_SCREEN)
    pg.on("console", lambda m: m.type == "error" and errors.append(f"[{name}] console: {m.text}"))
    pg.on("pageerror", lambda e: errors.append(f"[{name}] excecao: {e}"))
    pg.set_default_timeout(30000)
    return pg


def launch(p):
    """Navegador com microfone falso: um tom contínuo de 440 Hz no lugar do microfone, permissão automática."""
    wav = pathlib.Path(tempfile.gettempdir()) / "bagrenation_mic_falso.wav"
    with wave.open(str(wav), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(48000)
        w.writeframes(b"".join(struct.pack("<h", int(12000 * math.sin(2 * math.pi * 440 * i / 48000))) * 2 for i in range(96000)))
    return p.chromium.launch(channel=os.environ.get("PW_CHANNEL"), args=[  # PW_CHANNEL=msedge testa no Edge instalado
        "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", f"--use-file-for-fake-audio-capture={wav}"])


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
        browser = launch(p)
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
        expect(c.locator("#hearBtn")).to_be_visible()  # navegador bloqueou o som: botão grande "Clique para ouvir"
        expect(c.locator("#hearBtn")).to_contain_text("Clique para ouvir")
        shot(c, "02b_clique_para_ouvir")
        c.click("#hearBtn")
        expect(c.locator("#hearBtn")).to_be_hidden()
        expect(c.locator(".unblock")).to_be_hidden()
        assert not c.locator(".tile video").evaluate("v => v.muted")
        c.wait_for_function("() => [...document.querySelectorAll('audio')].every(el => !el.paused && !el.muted)")
        for pg in (a, b, c):
            expect(pg.locator("#peopleCount")).to_have_text("3", timeout=45000)
        step("C entrou depois e recebeu a transmissão (3 na sala); som bloqueado vira botão 'Clique para ouvir'")

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
    print(f"TELA OK — {len(steps)} etapas, 0 erro de console")


# ---------------------------------------------------------------------------------------------
# Chat de voz: 3 abas com microfone falso + 1 sem microfone + celular.
# ---------------------------------------------------------------------------------------------
# Conta os estalos do teclado retrô (cada um cria uma fonte de áudio).
CLACKS = """
window.__clacks = 0;
const realSource = AudioContext.prototype.createBufferSource;
AudioContext.prototype.createBufferSource = function () { window.__clacks++; return realSource.call(this); };
"""
NO_MIC = "navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('negado', 'NotAllowedError'); };"
STATS = "() => window.BAGRENATION.voiceStats()"


def voice_ready(pg, n):
    """A aba tem n conexões de voz fechadas, com ping medido."""
    pg.wait_for_function("""async n => { const s = await window.BAGRENATION.voiceStats(); return s.length === n && s.every(x => x.rttMs !== null); }""", arg=n, timeout=60000)


def hears(pg, name, loud=True):
    """Chega (ou não chega) som de voz de `name` nesta aba: nível do áudio recebido, lido do getStats."""
    pg.wait_for_function("""async ([name, loud]) => {
        const s = (await window.BAGRENATION.voiceStats()).find(x => x.name === name);
        return !!s && (loud ? s.audioLevelIn > 0.01 : s.audioLevelIn < 0.001);
    }""", arg=[name, loud], timeout=20000)


def row(pg, name):
    return pg.locator("#people li", has=pg.locator(".nm", has_text=re.compile(rf"^{name}( \(você\))?$")))


def pick_avatar(pg, opener, av, tab="Clássicos"):
    pg.click(opener)
    expect(pg.locator("#avatarDlg")).to_be_visible()
    pg.click(f'#avatarTabs button:text-is("{tab}")')
    pg.click(f'#avatarGrid button[title="{av}"]')
    expect(pg.locator("#avatarDlg")).to_be_hidden()


def run_voice(base):
    with sync_playwright() as p:
        browser = launch(p)
        steps = []
        step = lambda s: (steps.append(s), print("ok:", s, flush=True))

        # 1. avatares: galeria no início, escolha lembrada, aparece para os outros; sem escolha = inicial
        a = page(browser, "vA")
        a.add_init_script(CLACKS)
        a.goto(base)
        a.click("#startBtn")
        a.locator("#homeName").press_sequentially("Ana")
        assert a.evaluate("window.__clacks") == 0  # som desligado por padrão: digitar não toca nada
        a.click("#home .js-sfx")
        a.locator("#joinInput").press_sequentially("k7q")
        assert a.evaluate("window.__clacks") == 3, a.evaluate("window.__clacks")  # som ligado: um estalo por tecla
        a.click("#home .js-sfx")
        a.fill("#joinInput", "")
        expect(a.locator("#homeAvatar")).to_have_text("A")  # padrão: inicial do nome
        a.click("#homeAvatar")
        tabs = a.locator("#avatarTabs button")
        assert tabs.all_text_contents() == ["Bagres", "Clássicos", "RPG", "Cyber"], tabs.all_text_contents()
        expect(a.locator('#avatarTabs button[aria-pressed="true"]')).to_have_text("Bagres")  # sem avatar: primeira aba
        n_av = 1
        for i, quantos in enumerate([4, 11, 10, 6]):  # cada aba: inicial + os avatares do grupo
            tabs.nth(i).click()
            expect(a.locator("#avatarGrid button")).to_have_count(quantos + 1)
            expect(a.locator("#avatarGrid button svg")).to_have_count(quantos)
            n_av += quantos
            shot(a, f"10_galeria_{i + 1}")
        assert a.locator('#avatarGrid button[title="Ampulho, viajante do tempo"]').count() == 1
        tabs.nth(1).click()
        a.click('#avatarGrid button[title="gato"]')
        expect(a.locator('#homeAvatar use[href="#av-gato"]')).to_have_count(1)
        assert a.evaluate("localStorage.getItem('bagrenation:avatar')") == "gato"
        shot(a, "11_inicio_com_avatar")
        a.click("#createBtn")
        connected(a)
        link = a.url
        code = link.split("#")[1]
        b = page(browser, "vB")
        b.goto(base)
        b.click("#startBtn")
        b.fill("#homeName", "Bruno")
        pick_avatar(b, "#homeAvatar", "robo")
        b.fill("#joinInput", code)
        b.click("#joinForm [type=submit]")
        connected(b)
        c = page(browser, "vC")
        c.goto(link)  # entra direto pelo link, sem avatar
        connected(c)
        c.fill("#nameInput", "Caio")
        c.press("#nameInput", "Enter")
        for pg in (a, b, c):
            expect(pg.locator("#peopleCount")).to_have_text("3", timeout=45000)
        expect(row(b, "Ana").locator('use[href="#av-gato"]')).to_have_count(1)
        expect(row(a, "Bruno").locator('use[href="#av-robo"]')).to_have_count(1)
        expect(row(a, "Caio").locator(".avatar")).to_have_text("C")
        pick_avatar(c, "#meAvatar", "bagre dj", "Bagres")  # trocar depois, já dentro da sala
        expect(row(a, "Caio").locator('use[href="#av-bagre-dj"]')).to_have_count(1)
        expect(a.locator('#voiceGrid .vcard use[href="#av-bagre-dj"]')).to_have_count(1)
        step(f"teclado retrô só com o som ligado; avatares: galeria com {n_av - 1} + inicial, escolha salva, vista pelos outros, troca dentro da sala")

        # 2. entrar na sala = entrar na voz; todos se ouvem; Opus 48 kHz estéreo 128 kb/s, quadros de 10 ms
        for pg in (a, b, c):
            voice_ready(pg, 2)
            expect(pg.locator("#micBtn")).to_have_attribute("data-state", "on")
        hears(a, "Bruno"); hears(a, "Caio"); hears(b, "Ana"); hears(c, "Ana")
        a.wait_for_timeout(4500)  # duas leituras do getStats para as taxas por segundo
        st = a.evaluate(STATS)
        for x in st:
            fm = x["sendCodec"]["sdpFmtpLine"]
            assert x["sendCodec"]["mimeType"] == "audio/opus" and x["sendCodec"]["clockRate"] == 48000 and x["sendCodec"]["channels"] == 2, x["sendCodec"]
            for want in ("stereo=1", "maxaveragebitrate=128000", "useinbandfec=1", "usedtx=0"):
                assert want in fm, (want, fm)
            assert "stereo=1" in x["recvCodec"]["sdpFmtpLine"], x["recvCodec"]
            assert 85 <= x["packetsPerSecond"] <= 115, f"esperava ~100 pacotes/s (quadros de 10 ms), veio {x['packetsPerSecond']}"
            assert x["rttMs"] < 50 and x["latencyMs"] < 200, x
        mic = a.evaluate("window.BAGRENATION.mic()")
        print("   microfone (getSettings):", {k: mic.get(k) for k in ("sampleRate", "channelCount", "echoCancellation", "noiseSuppression", "autoGainControl", "latency")})
        for x in st:
            print(f"   A -> {x['name']}: ping {x['rttMs']:.1f} ms · buffer {x['bufferMs']:.0f} ms · saída {x['playoutMs']:.0f} ms · atraso estimado {x['latencyMs']:.0f} ms"
                  f" · {x['packetsPerSecond']:.0f} pacotes/s · {x['kbpsSent']:.0f} kb/s · rota {x['route']} · {x['sendCodec']['sdpFmtpLine']}")
        expect(row(a, "Bruno").locator(".sub")).to_contain_text(re.compile(r"ping \d+ ms · atraso \d+ ms"), timeout=10000)
        assert a.evaluate("[...document.querySelectorAll('audio')].every(el => el.srcObject && !el.paused && !el.muted)")
        for pg in (a, b, c):  # ninguém apertou nada depois de entrar: conectado, microfone ligado, anel aceso
            expect(pg.locator("#vbText")).to_have_text("Na voz com 2 pessoas · microfone ligado")
            expect(pg.locator("#voiceBar")).to_have_attribute("data-state", "on")
            expect(pg.locator("#micFixBtn")).to_be_hidden()
        expect(b.locator("#vbTalk")).to_contain_text("Ana")
        assert a.evaluate("localStorage.getItem('bagrenation:vmode')") is None  # padrão: detecção de voz, microfone aberto
        step("voz ligada ao entrar: 3 abas se ouvem; Opus 48 kHz estéreo, 128 kb/s, FEC, ~100 pacotes/s (10 ms); ping e atraso na lista")

        # 3. indicador de quem fala + mudo: só o anel de quem está falando acende
        b.click("#micBtn")
        c.click("#micBtn")
        expect(b.locator("#micBtn")).to_have_attribute("aria-pressed", "true")
        expect(b.locator("#vbText")).to_contain_text("microfone mudo")
        expect(b.locator("#voiceBar")).to_have_attribute("data-state", "muted")
        expect(b.locator("#vbTalk")).to_have_text("falando: Ana", timeout=10000)
        for pg in (b, c):
            expect(row(pg, "Ana").locator(".avatar")).to_have_class(re.compile("speaking"), timeout=10000)
        expect(a.locator("#meAvatar")).to_have_class(re.compile("speaking"))
        expect(row(a, "Bruno")).to_have_class(re.compile("is-muted"))
        expect(row(a, "Bruno").locator(".avatar")).not_to_have_class(re.compile("speaking"))
        expect(a.locator('#voiceGrid .vcard .avatar.speaking')).to_have_count(1)  # no palco, só o da Ana
        hears(a, "Bruno", loud=False)
        hears(b, "Ana")
        shot(a, "12_sala_voz_falando_desktop")
        a.click("#micBtn")
        expect(row(b, "Ana").locator(".avatar")).not_to_have_class(re.compile("speaking"), timeout=10000)
        expect(row(b, "Ana")).to_have_class(re.compile("is-muted"))
        hears(b, "Ana", loud=False)
        a.click("#micBtn")
        hears(b, "Ana")
        expect(row(b, "Ana").locator(".avatar")).to_have_class(re.compile("speaking"), timeout=10000)
        step("anel de quem fala acende só em quem fala; mudo corta o som de verdade e avisa a sala")

        # 4. ensurdecer: cala a sala e o próprio microfone; voltar devolve o estado anterior
        b.click("#micBtn")  # Bruno volta a falar
        hears(a, "Bruno")
        b.click("#deafBtn")
        expect(b.locator("#deafBtn")).to_have_attribute("aria-pressed", "true")
        assert b.evaluate("[...document.querySelectorAll('audio')].every(el => el.muted)")
        expect(row(a, "Bruno")).to_have_class(re.compile("is-deaf"))
        hears(a, "Bruno", loud=False)
        b.click("#deafBtn")
        assert b.evaluate("[...document.querySelectorAll('audio')].every(el => !el.muted)")
        hears(a, "Bruno")
        expect(row(a, "Bruno")).not_to_have_class(re.compile("is-deaf|is-muted"))
        step("ensurdecer cala a sala e o microfone; ao voltar, tudo como antes")

        # 5. push-to-talk com tecla configurável
        c.click("#voiceBtn")
        expect(c.locator("#voicePop")).to_be_visible()
        assert c.locator("#micSelect option").count() >= 1
        expect(c.locator("#voiceMode")).to_have_value("vad")  # padrão: detecção de voz…
        expect(c.locator("#sensOut")).to_have_text("sempre aberto")  # …com o microfone aberto
        c.select_option("#voiceMode", "ptt")
        c.click("#pttKeyBtn")
        expect(c.locator("#pttKeyBtn")).to_have_text("Aperte…")
        c.keyboard.press("KeyG")
        expect(c.locator("#pttKeyBtn")).to_have_text("G")
        shot(c, "13_config_voz_ptt")
        c.keyboard.press("Escape")
        expect(c.locator("#voicePop")).to_be_hidden()
        c.click("#micBtn")  # tira o mudo do passo 3: em push-to-talk continua sem transmitir
        expect(c.locator("#micBtn")).to_have_attribute("aria-pressed", "false")
        c.locator("#stage").click(position={"x": 5, "y": 5})
        hears(a, "Caio", loud=False)
        assert c.evaluate("window.BAGRENATION.mic().enabled") is False
        c.keyboard.down("KeyG")
        hears(a, "Caio")
        expect(row(a, "Caio").locator(".avatar")).to_have_class(re.compile("speaking"), timeout=10000)
        c.keyboard.up("KeyG")
        hears(a, "Caio", loud=False)
        expect(row(a, "Caio").locator(".avatar")).not_to_have_class(re.compile("speaking"), timeout=10000)
        c.fill("#chatInput", "ggg")  # digitar a tecla no chat não transmite
        assert c.evaluate("window.BAGRENATION.mic().enabled") is False
        c.fill("#chatInput", "")
        expect(row(c, "Caio").locator(".sub")).to_contain_text("push-to-talk · G")
        expect(c.locator("#vbText")).to_contain_text("push-to-talk: segure G para falar")
        step("push-to-talk: tecla escolhida (G), só transmite com ela apertada, digitar no chat não aciona")

        # 6. detecção de voz: sensibilidade no máximo fecha o portão para o tom; no mínimo fica sempre aberto
        c.click("#voiceBtn")
        c.select_option("#voiceMode", "vad")
        c.locator("#sens").fill("100")
        expect(c.locator("#sensOut")).to_have_text("-20 dB")
        hears(a, "Caio", loud=False)
        c.locator("#sens").fill("0")
        expect(c.locator("#sensOut")).to_have_text("sempre aberto")
        hears(a, "Caio")
        c.locator("#sens").fill("40")
        hears(a, "Caio")
        # filtros: desligar eco e ruído reabre o microfone cru (e estéreo, se o aparelho der)
        c.click("label.check:has(#ecToggle)")
        c.click("label.check:has(#nsToggle)")
        assert not c.is_checked("#ecToggle") and not c.is_checked("#nsToggle")
        c.wait_for_function("() => { const m = window.BAGRENATION.mic(); return m && m.echoCancellation === false && m.noiseSuppression === false; }")
        raw = c.evaluate("window.BAGRENATION.mic()")
        print("   microfone cru (eco e ruído desligados):", {k: raw.get(k) for k in ("sampleRate", "channelCount", "echoCancellation", "noiseSuppression", "autoGainControl", "latency")})
        hears(a, "Caio")  # a troca de microfone não derruba a conexão
        assert c.evaluate("localStorage.getItem('bagrenation:vec')") == "0"
        # teste de microfone: retorno local liga e desliga
        c.click("#micTestBtn")
        expect(c.locator("#micTestBtn")).to_have_text("Parar")
        assert int(c.locator("#vu").get_attribute("aria-valuenow")) > 20, "medidor do microfone parado"
        shot(c, "14_config_voz_teste")
        c.click("#micTestBtn")
        expect(c.locator("#micTestBtn")).to_have_text("Testar")
        c.keyboard.press("Escape")
        step("detecção de voz com sensibilidade, eco/ruído ligáveis (microfone reaberto sem cair), teste de microfone")

        # 7. volume por pessoa
        vol = row(a, "Bruno").locator(".pvol")
        vol.fill("0.25")
        assert a.evaluate("[...document.querySelectorAll('audio')].filter(el => Math.abs(el.volume - 0.25) < 0.01).length") == 1
        vol.fill("0")
        assert a.evaluate("[...document.querySelectorAll('audio')].filter(el => el.muted).length") == 1
        vol.fill("1")
        assert a.evaluate("[...document.querySelectorAll('audio')].every(el => el.volume === 1 && !el.muted)")
        step("volume por pessoa: só a voz daquela pessoa muda")

        # 8. tela compartilhada junto com a voz, em conexões separadas
        a.click("#shareBtn")
        playing(b)
        assert b.locator(".tile video").evaluate("v => v.srcObject.getAudioTracks().length") == 1
        hears(b, "Ana")
        b.locator(".js-vol").fill("0")  # zera o som da tela: a voz segue
        assert b.locator(".tile video").evaluate("v => v.muted || v.volume === 0")
        assert b.evaluate("[...document.querySelectorAll('audio')].every(el => !el.muted && el.volume === 1)")
        hears(b, "Ana")
        b.locator(".js-vol").fill("1")
        b.click("#deafBtn")  # ensurdecer cala também o som da tela
        assert b.locator(".tile video").evaluate("v => v.muted")
        b.click("#deafBtn")
        assert not b.locator(".tile video").evaluate("v => v.muted")
        assert a.evaluate("document.documentElement.scrollWidth") <= 1366
        box = a.locator(".dock").bounding_box()
        main = a.locator(".main").bounding_box()
        assert box["x"] >= main["x"] and box["x"] + box["width"] <= main["x"] + main["width"], "barra de controles estourou a largura"
        shot(b, "15_tela_e_voz_desktop")
        shot(a, "15b_transmitindo_com_voz_desktop")
        step("tela compartilhada junto com a voz: som da tela e voz separados; barra cabe em 1366")

        # 9. sem microfone (permissão negada): ouve a sala, aparece mudo, botão oferece ligar
        d = page(browser, "vD")
        d.add_init_script(NO_MIC)
        d.goto(link)
        connected(d)
        expect(d.locator("#micBtn")).to_have_attribute("data-state", "none")
        voice_ready(d, 3)
        hears(d, "Ana")
        expect(d.locator("#people li.is-muted", has_text="(você)")).to_have_count(1)
        expect(a.locator("#people li.is-muted")).to_have_count(1, timeout=15000)
        expect(d.locator("#toasts")).to_contain_text("Sem microfone")
        expect(d.locator("#vbText")).to_contain_text("sem microfone: ninguém te ouve")
        expect(d.locator("#micFixBtn")).to_be_visible()
        shot(d, "15c_sem_microfone")
        d.click("#micFixBtn")  # continua negado: explica onde liberar
        expect(d.locator("#toasts")).to_contain_text("Libere no cadeado")
        step("sem microfone: entra, ouve a sala, aparece como mudo, aviso claro e botão 'Ativar microfone'")

        # 10. sair e voltar: a voz fecha e reabre
        b.click("#leaveBtn")
        expect(b.locator("#home")).to_be_visible()
        assert b.evaluate("document.querySelectorAll('audio').length") == 0
        expect(b.locator('#homeAvatar use[href="#av-robo"]')).to_have_count(1)  # avatar lembrado
        for pg in (a, c, d):
            expect(pg.locator("#peopleCount")).to_have_text("3", timeout=30000)
        voice_ready(a, 2)
        b.fill("#joinInput", code)
        b.click("#joinForm [type=submit]")
        connected(b)
        voice_ready(b, 3)
        voice_ready(a, 3)
        hears(a, "Bruno"); hears(b, "Ana")
        playing(b)  # a tela da Ana volta junto
        b.reload()  # recarregar: avatar e preferências continuam
        connected(b)
        voice_ready(b, 3)
        expect(row(a, "Bruno").locator('use[href="#av-robo"]')).to_have_count(1, timeout=30000)
        step("sair e voltar (e recarregar): voz reconecta, avatar lembrado")

        # 11. celular: entra na voz, controles cabem, configurações abrem dentro da tela
        m = page(browser, "vCel", viewport={"width": 390, "height": 844})
        m.goto(link)
        connected(m)
        voice_ready(m, 4)
        hears(m, "Ana")
        assert m.evaluate("document.documentElement.scrollWidth") <= 390
        for sel in ("#micBtn", "#deafBtn", "#voiceBtn", "#leaveBtn"):
            bx = m.locator(sel).bounding_box()
            assert bx and bx["x"] >= 0 and bx["x"] + bx["width"] <= 390, sel
        shot(m, "16_voz_celular")
        m.click("#voiceBtn")
        bx = m.locator("#voicePop").bounding_box()
        assert bx["x"] >= 0 and bx["x"] + bx["width"] <= 390 and bx["y"] >= 0, bx
        shot(m, "17_config_voz_celular")
        m.keyboard.press("Escape")
        m.click("#panelBtn")
        shot(m, "18_painel_celular")
        m.click("#panelClose")
        st = m.evaluate(STATS)
        print("   5 pessoas na malha; celular:", ", ".join(f"{x['name']} {x['rttMs']:.1f} ms/~{x['latencyMs']:.0f} ms" for x in st))
        step("celular 390×844 na voz, com 5 pessoas na malha")

        browser.close()

    assert not errors, "erros de console:\n" + "\n".join(errors)
    print(f"VOZ OK — {len(steps)} etapas, 0 erro de console")


# ---------------------------------------------------------------------------------------------
# Caso real: dois navegadores DIFERENTES (processos e perfis separados). Um cria a sala, o outro
# entra pelo ID, e os dois têm de se ouvir sem apertar mais nada.
# ---------------------------------------------------------------------------------------------
def run_cross(base):
    with sync_playwright() as p:
        home = launch(p)  # Chromium
        others = {
            "Edge": lambda: p.chromium.launch(channel="msedge", args=["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"]),
            "Firefox": lambda: p.firefox.launch(firefox_user_prefs={"media.navigator.streams.fake": True, "media.navigator.permission.disabled": True}),
        }
        done = []
        for kind, start in others.items():
            try:
                other = start()
            except Exception as err:  # navegador não instalado nesta máquina
                print(f"pulado: {kind} indisponível ({str(err).splitlines()[0][:80]})", flush=True)
                continue
            a = page(home, "xChromium")
            a.goto(base)
            a.click("#startBtn")
            a.fill("#homeName", "Ana")
            a.click("#createBtn")
            connected(a)
            code = a.url.split("#")[1]
            b = page(other, f"x{kind}")
            b.goto(base)
            b.click("#startBtn")
            b.fill("#homeName", "Edu")
            b.fill("#joinInput", code)
            b.click("#joinForm [type=submit]")
            connected(b)
            # daqui em diante ninguém aperta nada
            voice_ready(a, 1)
            voice_ready(b, 1)
            hears(a, "Edu")
            hears(b, "Ana")
            for pg in (a, b):
                expect(pg.locator("#vbText")).to_have_text("Na voz com 1 pessoa · microfone ligado")
                expect(pg.locator("#hearBtn")).to_be_hidden()
                assert pg.evaluate("[...document.querySelectorAll('audio')].every(el => el.srcObject && !el.paused && !el.muted)")
            expect(row(a, "Edu").locator(".avatar")).to_have_class(re.compile("speaking"), timeout=10000)
            expect(row(b, "Ana").locator(".avatar")).to_have_class(re.compile("speaking"), timeout=10000)
            a.wait_for_timeout(4500)
            for who, pg in (("Chromium", a), (kind, b)):
                x = pg.evaluate(STATS)[0]
                print(f"   {who} ouve {x['name']}: ping {x['rttMs']:.1f} ms · atraso estimado {x['latencyMs']:.0f} ms · envia {x['packetsPerSecond']:.0f} pacotes/s, {x['kbpsSent']:.0f} kb/s"
                      f" · {x['sendCodec'].get('mimeType')} {x['sendCodec'].get('sdpFmtpLine')}", flush=True)
            shot(b, f"20_{kind.lower()}_ouve_chromium")
            done.append(kind)
            print(f"ok: Chromium cria, {kind} entra pelo ID: os dois se ouvem sem apertar nada, microfone ligado, anel de quem fala", flush=True)
            a.context.close()
            other.close()
        home.close()
    assert done, "nenhum segundo navegador disponível para o caso real"
    assert not errors, "erros de console:\n" + "\n".join(errors)
    print(f"NAVEGADORES OK — Chromium com {' e '.join(done)}, 0 erro de console")


if __name__ == "__main__":
    which = os.environ.get("ONLY", "tela,voz,navegadores")  # ONLY=voz roda só o cenário de voz
    go = lambda base: [fn(base) for name, fn in (("tela", run), ("voz", run_voice), ("navegadores", run_cross)) if name in which]
    if len(sys.argv) > 1 and sys.argv[1].startswith("http"):
        go(sys.argv[1])
    else:
        class Quiet(http.server.SimpleHTTPRequestHandler):
            def log_message(self, *a):
                pass

        handler = functools.partial(Quiet, directory=str(ROOT))
        srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        go(f"http://127.0.0.1:{srv.server_address[1]}/")
