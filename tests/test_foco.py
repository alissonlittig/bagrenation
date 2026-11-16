"""S-1351: modo foco no canal de voz (esconde lateral, #chat e barras; foco na tela ou nas pessoas).

Prova com 2 navegadores (Ana transmite, Bruno assiste) + 1 celular: botão e tecla F entram no foco, Esc e "Sair" voltam,
foco na tela deixa uma tela ocupando o palco (com 2 telas, escolher qual), foco nas pessoas mostra a grade com destaque
em quem fala, a escolha fica lembrada ao recarregar, mensagem nova no #chat aparece no botão Sair, celular sem sobra lateral.
Usa um servidor de teste (?servidor=teste-...), não aparece no BAGRENATION de verdade.
Uso:  python tests/test_foco.py [url_base] [pasta_prints]
"""
import functools
import http.server
import pathlib
import sys
import threading

from playwright.sync_api import expect, sync_playwright

sys.path.insert(0, str(pathlib.Path(__file__).parent))
import test_e2e as T  # noqa: E402

HIDDEN = ["#panel", "#chat", ".topbar", "#voiceBar"]


def box(pg, sel):
    return pg.locator(sel).first.bounding_box()


def normal(pg):
    expect(pg.locator("#room")).not_to_have_attribute("data-focus", "screen")
    expect(pg.locator("#room")).not_to_have_attribute("data-focus", "people")
    expect(pg.locator("#focusBar")).to_be_hidden()
    expect(pg.locator(".topbar")).to_be_visible()


def run(base, shots):
    T.SHOTS = shots
    with sync_playwright() as p:
        browser = T.launch(p)
        steps = []
        step = lambda s: (steps.append(s), print("ok:", s, flush=True))
        a = T.page(browser, "A")
        b = T.page(browser, "B", viewport={"width": 1366, "height": 768})
        T.enter(a, base, "Ana")
        T.enter(b, base, "Bruno")
        for pg in (a, b):
            expect(pg.locator("#voiceCount")).to_have_text("2", timeout=45000)
        a.click("#shareBtn")
        T.playing(b)
        if b.locator(".unblock").is_visible():
            b.click(".unblock")
        step("Ana transmite, Bruno assiste (base do v1.1.0)")

        # 0. S-1354: o botão do dock não pode ficar por baixo do #chat (era o "não retrai": Foco e Sair escondidos)
        for w, h in ((1366, 768), (1536, 816), (1280, 720), (1920, 1009)):
            b.set_viewport_size({"width": w, "height": h})
            b.wait_for_timeout(200)
            fb, ch = box(b, "#focusBtn"), box(b, "#chat")
            assert fb["x"] + fb["width"] <= ch["x"], f"{w}x{h}: botão Foco passa por baixo do #chat ({fb} x {ch})"
            expect(b.locator("#focusTop")).to_be_visible()
        b.set_viewport_size({"width": 1366, "height": 768})
        b.click("#focusTop")
        expect(b.locator("#room")).to_have_attribute("data-focus", "screen")
        b.keyboard.press("Escape")
        normal(b)
        b.locator("#chanChat").click()
        expect(b.locator("#focusTop")).to_be_hidden()  # fora do canal de voz (no #chat) o botão some
        b.locator("#chanVoice").click()
        step("dock inteiro à esquerda do #chat em 1280/1366/1536/1920; botão 'Retrair laterais' no topo entra no foco")

        # 1. botão Foco: sem escolha anterior e com tela aberta = foco na tela
        expect(b.locator("#focusBtn")).to_be_visible()
        b.click("#focusBtn")
        expect(b.locator("#room")).to_have_attribute("data-focus", "screen")
        for sel in HIDDEN:
            expect(b.locator(sel)).to_be_hidden()
        expect(b.locator("#focusBar")).to_be_visible()
        expect(b.locator(".tile.focused")).to_have_count(1)
        expect(b.locator("#focusFaces li")).to_have_count(2)
        b.wait_for_timeout(400)
        t, vw = box(b, ".tile.focused"), b.viewport_size
        assert t["width"] > vw["width"] * 0.9 and t["height"] > vw["height"] * 0.6, f"tela não ocupa o palco: {t}"
        assert b.locator("#focusBtn").get_attribute("aria-pressed") == "true"
        T.playing(b)
        T.shot(b, "foco_tela_desktop")
        step(f"botão Foco: lateral, #chat, topo e faixa somem; tela ocupa {t['width']:.0f}×{t['height']:.0f} de {vw['width']}×{vw['height']}; vídeo segue rodando")

        # 2. Esc volta; F entra de novo (lembra o último foco)
        b.keyboard.press("Escape")
        normal(b)
        expect(b.locator("#chat")).to_be_visible()
        expect(b.locator(".tile.focused")).to_have_count(0)  # o destaque automático do foco não fica no modo normal
        b.locator("#stage").click(position={"x": 5, "y": 5})
        b.keyboard.press("f")
        expect(b.locator("#room")).to_have_attribute("data-focus", "screen")
        step("Esc volta ao normal (sem destaque sobrando); tecla F entra de novo no foco na tela")

        # 3. foco nas pessoas: grade grande, destaque em quem fala, tela some (som da tela continua tocando)
        b.click("#focusPeople")
        expect(b.locator("#room")).to_have_attribute("data-focus", "people")
        expect(b.locator(".tile")).to_be_hidden()
        expect(b.locator("#voiceGrid .vcard")).to_have_count(2)
        expect(b.locator("#voiceGrid .vcard").first).to_be_visible()
        expect(b.locator("#voiceGrid .vcard .avatar.speaking").first).to_be_visible(timeout=15000)  # microfone falso = tom contínuo
        b.wait_for_timeout(400)
        av = box(b, "#voiceGrid .vcard .avatar")
        assert av["width"] >= 84, f"avatar pequeno no foco nas pessoas: {av}"
        lit = b.evaluate("[...document.querySelectorAll('#voiceGrid .vcard')].filter(c => c.querySelector('.avatar.speaking')).map(c => getComputedStyle(c).boxShadow)")
        assert lit and all("57, 255, 136" in s for s in lit), f"cartão de quem fala sem destaque: {lit}"
        assert not b.locator(".tile video").evaluate("v => v.paused"), "som/vídeo da tela parou no foco nas pessoas"
        expect(b.locator('#voiceGrid .vcard.is-live')).to_have_count(1)
        T.shot(b, "foco_pessoas_desktop")
        step(f"foco nas pessoas: grade com 2 cartões, avatar {av['width']:.0f}px, contorno verde em quem fala, selo ao vivo; tela continua tocando")

        # 4. lembrar a escolha: recarregou e entrou no canal = volta no foco nas pessoas
        b.reload()
        T.connected(b)
        T.join_voice(b)
        expect(b.locator("#room")).to_have_attribute("data-focus", "people")
        expect(b.locator("#voiceGrid .vcard")).to_have_count(2, timeout=45000)
        step("recarregar e entrar no canal: volta no mesmo foco (lembrado)")

        # 5. mensagem no #chat durante o foco: aviso no botão Sair; Sair volta e marca como lida
        a.fill("#chatInput", "foco teste")
        a.press("#chatInput", "Enter")
        expect(b.locator("#focusUnread")).to_be_visible(timeout=20000)
        b.click("#focusExit")
        normal(b)
        expect(b.locator("#chatLog")).to_contain_text("foco teste")
        expect(b.locator("#focusUnread")).to_be_hidden()
        step("mensagem nova no #chat aparece no botão Sair; Sair (1 clique) volta e marca como lida")

        # 6. duas telas: no foco na tela dá para escolher qual fica grande (botão ou clique na miniatura)
        T.playing(b)
        b.click("#shareBtn")
        expect(b.locator(".tile")).to_have_count(2)
        b.click("#focusBtn")  # o último foco foi o das pessoas
        expect(b.locator("#room")).to_have_attribute("data-focus", "people")
        b.click("#focusScreen")
        expect(b.locator("#room")).to_have_attribute("data-focus", "screen")
        expect(b.locator("#focusScreens button")).to_have_count(2)
        expect(b.locator(".tile.focused .tile-name")).to_have_text("Ana")  # a de outra pessoa antes da minha prévia
        b.click("#focusScreens button:has-text('Bruno')")
        expect(b.locator(".tile.focused .tile-name")).to_have_text("Bruno (você)")
        expect(b.locator("#focusScreens button[aria-pressed=true]")).to_have_text("Bruno (você)")
        b.locator(".tile:not(.focused)").click(position={"x": 30, "y": 40})
        expect(b.locator(".tile.focused .tile-name")).to_have_text("Ana")
        b.wait_for_timeout(400)
        T.shot(b, "foco_tela_duas_desktop")
        b.click("#focusExit")
        b.click("#shareBtn")  # para a transmissão do Bruno
        expect(b.locator(".tile")).to_have_count(1)
        step("2 telas: escolher qual fica grande pelo botão com o nome e pelo clique na miniatura")

        # 7. celular 390×844: os dois focos, sem barra de rolagem lateral; Esc/Sair voltam
        c = T.page(browser, "C", viewport={"width": 390, "height": 844})
        T.enter(c, base, "Caio")
        T.playing(c)
        if c.locator(".unblock").is_visible():
            c.click(".unblock")
        c.click("#focusBtn")
        expect(c.locator("#room")).to_have_attribute("data-focus", "screen")
        for sel in HIDDEN:
            expect(c.locator(sel)).to_be_hidden()
        c.wait_for_timeout(400)
        t = box(c, ".tile.focused")
        assert t["width"] > 360, f"tela estreita no celular: {t}"
        assert c.evaluate("document.documentElement.scrollWidth") <= 390, "sobra lateral no celular (foco na tela)"
        T.shot(c, "foco_tela_celular")
        c.click("#focusPeople")
        expect(c.locator("#voiceGrid .vcard")).to_have_count(3, timeout=45000)
        c.wait_for_timeout(400)
        assert c.evaluate("document.documentElement.scrollWidth") <= 390, "sobra lateral no celular (foco nas pessoas)"
        ex = box(c, "#focusExit")
        assert ex and ex["x"] + ex["width"] <= 390, f"botão Sair fora da tela: {ex}"
        T.shot(c, "foco_pessoas_celular")
        c.click("#focusExit")
        normal(c)
        step("celular 390×844: foco na tela e nas pessoas sem sobra lateral, Sair à vista e voltando ao normal")

        # 8. sair do canal de voz sai do foco; entrar de novo volta nele
        c.click("#focusBtn")
        expect(c.locator("#room")).to_have_attribute("data-focus", "people")
        c.click("#leaveBtn")
        expect(c.locator("#focusBar")).to_be_hidden()
        expect(c.locator("#joinVoiceBtn")).to_be_visible()
        c.click("#joinVoiceBtn")
        expect(c.locator("#room")).to_have_attribute("data-focus", "people")
        step("sair do canal de voz tira o foco (botão Entrar à vista); voltar ao canal volta no foco escolhido")
        assert not T.errors, "erros de console: " + " | ".join(T.errors)
        browser.close()
    print(f"FOCO OK {len(steps)} passos, 0 erro de console")


if __name__ == "__main__":
    shots = pathlib.Path(sys.argv[2]) if len(sys.argv) > 2 else None
    if len(sys.argv) > 1 and sys.argv[1].startswith("http"):
        run(sys.argv[1], shots)
    else:
        class Quiet(http.server.SimpleHTTPRequestHandler):
            def log_message(self, *a):
                pass

        root = pathlib.Path(__file__).resolve().parent.parent
        srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=str(root)))
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        run(f"http://127.0.0.1:{srv.server_address[1]}/", shots)
