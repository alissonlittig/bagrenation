"""S-1564: tela cheia imersiva de uma transmissão (como no YouTube): some tudo em volta, fica só a tela.

Prova com 2 navegadores (Ana transmite, Bruno assiste) + 1 celular: duplo clique, botão e tecla F entram na tela cheia
da Fullscreen API real; só a transmissão aparece (lateral, canais, #chat, membros, topo e dock fora da tela); controles
mínimos (nome, volume, mudo, sair) somem com o cursor após ~2,5 s parado e voltam ao mexer; Esc, F, duplo clique e o
botão saem e o layout volta igual; com 2 telas a escolhida é a que vai para a tela cheia; F fora de uma tela continua
sendo o modo foco. Usa um servidor de teste (?servidor=teste-...).
Uso:  python tests/test_telacheia.py [url_base] [pasta_prints]
"""
import functools
import http.server
import pathlib
import sys
import threading

from playwright.sync_api import expect, sync_playwright

sys.path.insert(0, str(pathlib.Path(__file__).parent))
import test_e2e as T  # noqa: E402

AROUND = ["#panel", "#chat", ".topbar", "#dockWrap"]
FS = "document.fullscreenElement"


def boxes(pg):
    return {s: pg.locator(s).first.bounding_box() for s in AROUND + [".tile"]}


def only_video(pg):
    """Na tela cheia o que se vê em qualquer ponto é a própria transmissão (nada do layout por cima ou em volta)."""
    vw = pg.viewport_size
    pts = [(5, 5), (vw["width"] - 5, 5), (5, vw["height"] // 2), (vw["width"] - 5, vw["height"] // 2), (vw["width"] // 2, vw["height"] // 2)]
    out = pg.evaluate("pts => pts.map(([x, y]) => !!document.elementFromPoint(x, y)?.closest('.tile.is-full'))", pts)
    assert all(out), f"algo fora da transmissão aparece na tela cheia: {list(zip(pts, out))}"
    r = pg.evaluate(f"(() => {{ const r = {FS}.getBoundingClientRect(); return [r.width, r.height]; }})()")
    assert r == [vw["width"], vw["height"]], f"a tela cheia não preenche a janela: {r} x {vw}"


def full_on(pg, name=None):
    pg.wait_for_function(f"() => {FS} && {FS}.classList.contains('tile') && {FS}.classList.contains('is-full')")
    if name:
        expect(pg.locator(".tile.is-full .tile-name")).to_have_text(name)
    expect(pg.locator(".tile.is-full .js-full")).to_have_attribute("aria-label", "Sair da tela cheia (Esc)")
    only_video(pg)


def full_off(pg, before):
    pg.wait_for_function(f"() => !{FS}")
    expect(pg.locator(".tile.is-full")).to_have_count(0)
    pg.wait_for_timeout(300)
    after = boxes(pg)
    for s, b in before.items():
        a = after[s]
        assert a and all(abs(a[k] - b[k]) < 1 for k in b), f"layout não voltou igual em {s}: {b} -> {a}"


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
        before = boxes(b)
        T.shot(b, "tc_00_antes")
        step("Ana transmite, Bruno assiste")

        # 1. duplo clique no vídeo: tela cheia real, só a transmissão
        tile = b.locator(".tile").first
        tile.dblclick(position={"x": 200, "y": 200})
        full_on(b, "Ana")
        for s in AROUND:
            assert not b.evaluate("s => { const e = document.querySelector(s); const r = e.getBoundingClientRect(); const x = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return !!x && e.contains(x); }", s), f"{s} ainda aparece"
        T.playing(b)
        expect(b.locator(".tile.is-full .tile-bar")).to_have_css("opacity", "1")
        for sel in (".js-unwatch", ".js-pip", ".js-focus", ".tile-stats"):
            expect(b.locator(f".tile.is-full {sel}")).to_be_hidden()
        for sel in (".js-full", ".js-mute", ".js-vol"):
            expect(b.locator(f".tile.is-full {sel}")).to_be_visible()
        T.shot(b, "tc_01_tela_cheia_controles")
        step("duplo clique: Fullscreen API na tela da Ana, preenche 1366×768, lateral/canais/#chat/topo/dock fora; controles só sair, volume e mudo")

        # 2. parado 2,5 s: controles e cursor somem; mexeu, voltam
        b.mouse.move(600, 300)
        b.wait_for_timeout(3200)
        assert b.evaluate(f"{FS}.classList.contains('fs-idle')"), "controles não somem parado"
        b.wait_for_timeout(300)
        assert b.evaluate("getComputedStyle(document.querySelector('.tile.is-full .tile-bar')).opacity") == "0"
        assert b.evaluate("getComputedStyle(document.querySelector('.tile.is-full video')).cursor") == "none", "cursor não some"
        T.shot(b, "tc_02_so_o_video")
        b.mouse.move(640, 320)
        assert not b.evaluate(f"{FS}.classList.contains('fs-idle')"), "controles não voltam ao mexer o mouse"
        b.mouse.move(700, 740)  # em cima da barra: não some enquanto o mouse está nela
        b.wait_for_timeout(3000)
        assert not b.evaluate(f"{FS}.classList.contains('fs-idle')"), "barra sumiu com o mouse em cima"
        step("parado ~2,5 s: barra, nome e cursor somem (print só com o vídeo); mexeu o mouse, voltam; mouse na barra segura")

        # 3. volume e mudo na tela cheia
        vol = b.locator(".tile.is-full .js-vol")
        vol.fill("0.5")
        b.wait_for_timeout(200)
        b.click(".tile.is-full .js-mute")
        expect(b.locator(".tile.is-full .js-mute")).to_have_attribute("aria-pressed", "true")
        b.click(".tile.is-full .js-mute")
        expect(b.locator(".tile.is-full .js-mute")).to_have_attribute("aria-pressed", "false")
        assert b.evaluate(f"{FS} !== null"), "mexer no volume tirou da tela cheia"
        step("volume e mudo funcionam sem sair da tela cheia")

        # 4. Esc sai e volta ao layout de antes
        b.keyboard.press("Escape")
        full_off(b, before)
        expect(b.locator(".tile .js-full")).to_have_attribute("aria-label", "Tela cheia: Ana")
        step("Esc sai; lateral, #chat, topo, dock e a tela voltam exatamente às mesmas posições")

        # 5. botão no canto e tecla F (mouse em cima da tela); duplo clique sai
        tile.hover()
        b.click(".tile .js-full")
        full_on(b, "Ana")
        b.click(".tile.is-full .js-full")
        full_off(b, before)
        tile.hover(position={"x": 300, "y": 200})
        b.keyboard.press("f")
        full_on(b, "Ana")
        b.keyboard.press("f")
        full_off(b, before)
        tile.dblclick(position={"x": 300, "y": 200})
        full_on(b)
        b.mouse.dblclick(400, 300)
        full_off(b, before)
        expect(b.locator("#room")).not_to_have_attribute("data-focus", "screen")
        step("botão do canto entra e sai; F com o mouse na tela entra e sai; duplo clique sai; layout igual em todas")

        # 6. F fora de uma tela continua sendo o modo foco (S-1351)
        b.locator("#stage").click(position={"x": 5, "y": 5})
        b.mouse.move(5, 5)
        b.keyboard.press("f")
        expect(b.locator("#room")).to_have_attribute("data-focus", "screen")
        assert b.evaluate(f"!{FS}")
        b.locator(".tile.focused").dblclick(position={"x": 300, "y": 200})  # do modo foco também vai para tela cheia
        full_on(b, "Ana")
        b.keyboard.press("Escape")
        b.wait_for_function(f"() => !{FS}")
        expect(b.locator("#room")).to_have_attribute("data-focus", "screen")  # sair da tela cheia volta ao foco, como estava
        b.keyboard.press("Escape")
        full_off(b, before)
        step("F fora da tela = modo foco; do foco, duplo clique = tela cheia; Esc volta ao foco; Esc de novo volta ao normal")

        # 7. duas telas: a escolhida vai para a tela cheia
        b.click("#shareBtn")
        expect(b.locator(".tile")).to_have_count(2)
        T.playing(b, 0)
        mine = b.locator(".tile.is-local")
        mine.dblclick(position={"x": 100, "y": 100})
        full_on(b, "Bruno (você)")
        b.keyboard.press("Escape")
        b.wait_for_function(f"() => !{FS}")
        ana = b.locator(".tile:not(.is-local)")
        ana.hover(position={"x": 100, "y": 100})
        b.keyboard.press("f")
        full_on(b, "Ana")
        T.playing(b, 0)
        T.shot(b, "tc_03_duas_telas_ana")
        b.keyboard.press("Escape")
        b.wait_for_function(f"() => !{FS}")
        b.click("#shareBtn")
        expect(b.locator(".tile")).to_have_count(1)
        step("2 telas: duplo clique na minha prévia = ela em tela cheia; F em cima da da Ana = a da Ana")

        # 8. regressão rápida: chat e voz seguem durante e depois
        tile.dblclick(position={"x": 200, "y": 200})
        full_on(b)
        a.fill("#chatInput", "oi na tela cheia")
        a.press("#chatInput", "Enter")
        b.wait_for_timeout(1500)
        assert b.evaluate(f"{FS} !== null"), "mensagem nova tirou da tela cheia"
        b.keyboard.press("Escape")
        full_off(b, before)
        expect(b.locator("#chatLog")).to_contain_text("oi na tela cheia")
        expect(b.locator("#voiceCount")).to_have_text("2")
        step("mensagem que chega durante a tela cheia não tira dela; depois está no #chat; voz segue com 2")

        # 9. celular 390×844 (toque): botão entra em tela cheia e preenche; botão sai
        ctx = browser.new_context(viewport={"width": 390, "height": 844}, has_touch=True, is_mobile=True)
        c = ctx.new_page()
        c.add_init_script(T.FAKE_SCREEN)
        c.on("pageerror", lambda e: T.errors.append(f"[C] excecao: {e}"))
        T.enter(c, base, "Caio")
        T.playing(c)
        if c.locator(".unblock").is_visible():
            c.click(".unblock")
        cb = c.locator(".tile").first.bounding_box()
        c.tap(".tile .tile-video", position={"x": 30, "y": 30})
        c.tap(".tile .js-full")
        full_on(c, "Ana")
        T.shot(c, "tc_04_celular")
        c.tap(".tile.is-full .js-full")
        c.wait_for_function(f"() => !{FS}")
        nb = c.locator(".tile").first.bounding_box()
        assert all(abs(nb[k] - cb[k]) < 1 for k in cb), f"celular: layout não voltou {cb} -> {nb}"
        step("celular 390×844: toque no botão = tela cheia preenchendo, toque em sair volta igual")
        assert not T.errors, "erros de console: " + " | ".join(T.errors)
        browser.close()
    print(f"TELA CHEIA OK {len(steps)} passos, 0 erro de console")


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
