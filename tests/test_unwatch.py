"""S-1202: parar de assistir uma tela e continuar na voz. 3 abas: A compartilha, B e C assistem.
Uso: python tests/test_unwatch.py [url] [pasta_prints]"""
import functools, http.server, pathlib, sys, threading
from playwright.sync_api import expect, sync_playwright
sys.path.insert(0, str(pathlib.Path(__file__).parent))
import test_e2e as T

SCR = "() => window.BAGRENATION.screen()"
def peer(pg, name): return next(x for x in pg.evaluate(SCR) if x["name"] == name)

def kbps(pg, name, key, ms=3000):
    a = peer(pg, name)[key]; pg.wait_for_timeout(ms); b = peer(pg, name)[key]
    return (b - a) * 8 / ms

def run(base, shots):
    T.SHOTS = shots
    with sync_playwright() as p:
        br = T.launch(p)
        a = T.page(br, "Ana"); a.goto(base); a.click("#startBtn"); a.fill("#homeName", "Ana"); a.click("#createBtn"); T.connected(a)
        code = a.url.split("#")[1]
        others = {}
        for n in ("Bruno", "Caio"):
            pg = T.page(br, n); pg.goto(base); pg.click("#startBtn"); pg.fill("#homeName", n); pg.fill("#joinInput", code)
            pg.click("#joinForm [type=submit]"); T.connected(pg); others[n] = pg
        b, c = others["Bruno"], others["Caio"]
        for pg in (a, b, c): T.voice_ready(pg, 2)
        a.click("#shareBtn")
        T.playing(b); T.playing(c)
        a.wait_for_timeout(2500)
        print("ok: B e C assistem; B recebe", round(kbps(b, "Ana", "got")), "kb/s")
        assert kbps(b, "Ana", "got") > 100
        T.shot(b, "30_b_assistindo")
        # B para de assistir pelo botão do bloco da tela
        b.click(".tile .js-unwatch")
        expect(b.locator(".tile")).to_have_count(0)
        expect(T.row(b, "Ana").locator(".wbtn")).to_have_text("Assistir")
        expect(T.row(b, "Ana").locator(".pill-live")).to_be_visible()
        a.wait_for_function("async () => (await window.BAGRENATION.screen()).find(x => x.name==='Bruno').out === false", timeout=15000)
        r = kbps(a, "Bruno", "sent"); rc = kbps(a, "Caio", "sent")
        print(f"ok: bitrate de video de A para B = {r:.1f} kb/s (C = {rc:.0f} kb/s)")
        assert r < 5 and rc > 100, (r, rc)
        expect(c.locator(".tile")).to_have_count(1); T.playing(c)
        # a voz de B segue: B ouve A e C, A e C ouvem B
        T.hears(b, "Ana"); T.hears(b, "Caio"); T.hears(a, "Bruno"); T.hears(c, "Bruno")
        print("ok: voz intacta: B ouve A e C; A e C ouvem B")
        a.wait_for_timeout(2500)
        assert "1 pessoa assistindo" in a.locator(".tile-stats").inner_text().lower(), a.locator(".tile-stats").inner_text()
        print("ok: A ve '1 pessoa assistindo'")
        T.shot(b, "31_b_parou"); T.shot(a, "32_a_contagem")
        # B volta a assistir
        T.row(b, "Ana").locator(".wbtn").click()
        T.playing(b)
        assert kbps(b, "Ana", "got") > 100
        expect(T.row(b, "Ana").locator(".wbtn")).to_have_text("Parar de assistir")
        print("ok: B voltou a assistir, video retomado")
        # e de novo pelo menu da pessoa, e C nao afetado
        T.row(b, "Ana").locator(".wbtn").click()
        expect(b.locator(".tile")).to_have_count(0)
        T.hears(b, "Ana")
        T.playing(c)
        print("ok: parar de novo pelo menu da pessoa")
        T.shot(b, "33_b_parou_menu")
        T.row(b, "Ana").locator(".wbtn").click(); T.playing(b)
        assert not T.errors, "erros de console:\n" + "\n".join(T.errors)
        print("UNWATCH OK, 0 erro de console")

if __name__ == "__main__":
    shots = pathlib.Path(sys.argv[2]) if len(sys.argv) > 2 else None
    if len(sys.argv) > 1 and sys.argv[1].startswith("http"): run(sys.argv[1], shots)
    else:
        h = functools.partial(type("Q", (http.server.SimpleHTTPRequestHandler,), {"log_message": lambda *a: None}), directory=str(T.ROOT))
        srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), h); threading.Thread(target=srv.serve_forever, daemon=True).start()
        run(f"http://127.0.0.1:{srv.server_address[1]}/", shots)
