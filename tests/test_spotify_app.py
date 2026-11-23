"""S-0032: playlist do Spotify no APP de verdade (Felipe, desktop oculto do Windows, volume mestre mudo) com 2 navegadores
do site publicado (Martins no PC, Cris no celular), todos no canal de voz de um servidor de teste.

Felipe pede pelo /play no chat e pelo campo do Bagre DJ (Enter): playlist comum, editorial (37i9dQZF1...), grande (>100),
spotify.link, URI spotify:playlist:; depois a regressão do DJ (nome + Enter, link do YouTube, álbum do Spotify).
Mede quando a 1ª música toca, espera o "Pronto" do Bagre DJ e compara a fila dos 3; no app confere que o som sai pelo
<audio> escondido (só áudio, nenhum iframe do YouTube).
Modo "antes" só registra; "depois" confere (fila igual nos 3, playlist inteira até 100, 1ª toca em menos de 15 s).
Uso:  python tests/test_spotify_app.py <bagrenation.exe> <url_do_site> <antes|depois> [saida.json]
"""
import json
import pathlib
import sys
import time

from playwright.sync_api import expect, sync_playwright

sys.path.insert(0, str(pathlib.Path(__file__).parent))
import test_eco as E  # noqa: E402  (desktop oculto, volume mestre; lê o exe de sys.argv[1])

SITE = sys.argv[2]
MODE = sys.argv[3]
OUT = sys.argv[4] if len(sys.argv) > 4 else f"spotify_app_{MODE}.json"
CASES = [  # (rótulo, pedido, como, mínimo na fila depois do conserto)
    ("comum", "https://open.spotify.com/playlist/5omtcWLg3swaG4MEuKVGWI", "play", 70),
    ("editorial", "https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M?si=1a2b3c4d5e6f4a7b", "campo", 40),
    ("grande", "https://open.spotify.com/playlist/3LXvKNc8Y2lq1pTo1vtVy3", "campo", 85),
    ("spotify.link", "https://spotify.link/zLIDHxA0bKb", "play", 85),
    ("uri", "spotify:playlist:37i9dQZF1DXcBWIGoYBM5M", "campo", 40),
    ("nome", "legiao urbana tempo perdido", "campo", 1),
    ("youtube", "https://www.youtube.com/watch?v=aqz-KE-bpKQ", "play", 1),
    ("album", "https://open.spotify.com/album/4LH4d3cOWNNsVw41Gqt2kv", "play", 9),
]
END = ("Pronto:", "não existe", "Não achei", "Não consegui", "Cole o link", "não respondeu")


def bots(pg):
    return pg.evaluate("() => [...document.querySelectorAll('#chatLog .msg.is-bot')].map((e) => e.innerText)")


def say(pg, text):
    pg.fill("#chatInput", text)
    pg.press("#chatInput", "Enter")


def dj(pg):
    return pg.evaluate("() => BAGRENATION.dj()")


def main():
    import psutil
    errors = []
    res = []
    was_muted = E.master_mute(True)
    pid, hdesk = E.start_hidden(E.EXE)
    try:
        with sync_playwright() as p:
            for _ in range(80):
                try:
                    cdp = p.chromium.connect_over_cdp(f"http://127.0.0.1:{E.PORT}")
                    break
                except Exception:
                    time.sleep(0.5)
            a = cdp.contexts[0].pages[0]
            a.on("console", lambda m: m.type == "error" and not any(x in (m.location or {}).get("url", "") for x in ("youtube", "google", "ytimg")) and errors.append(f"[app] {m.text}"))
            a.set_default_timeout(30000)
            E.wait(a, "!!window.__TAURI__ && document.readyState === 'complete'", 30000)
            ver = a.evaluate("() => window.__TAURI__.app ? window.__TAURI__.app.getVersion() : ''")
            a.evaluate(f"location.search = '?servidor={E.SRV}'")
            E.wait(a, "document.readyState === 'complete' && location.search.includes('servidor')", 20000)
            if a.locator("#nameDlg").is_visible():
                a.fill("#homeName", "Felipe")
                a.click("#nameForm [type=submit]")
            E.connected(a)
            a.click("#chanVoice")
            expect(a.locator("#vconn")).to_be_visible()
            br = p.chromium.launch(args=["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--mute-audio"])
            others = []
            for name, vp in (("Martins", {"width": 1366, "height": 768}), ("Cris", {"width": 390, "height": 844})):
                pg = br.new_context(viewport=vp, is_mobile=vp["width"] < 500, has_touch=vp["width"] < 500).new_page()
                pg.on("console", lambda m, n=name: m.type == "error" and not any(x in (m.location or {}).get("url", "") for x in ("youtube", "google", "ytimg", "doubleclick", "gstatic")) and errors.append(f"[{n}] {m.text}"))
                pg.goto(f"{SITE}?servidor={E.SRV}")
                pg.fill("#homeName", name)
                pg.click("#nameForm [type=submit]")
                E.connected(pg)
                if not pg.locator("#chanVoice").is_visible():
                    pg.click("#chanBtn")
                pg.click("#chanVoice")
                others.append(pg)
            for pg in [a] + others:
                expect(pg.locator("#voiceCount")).to_have_text("3", timeout=45000)
            print(f"ok: app {ver} (Felipe) e site (Martins, Cris) no canal de voz", flush=True)
            a.click("#djBtn")
            for tag, q, how, minq in CASES:
                n0 = len(bots(a))
                t0 = time.time()
                if how == "play":
                    say(a, f"/play {q}")
                else:
                    a.fill("#djQ", q)
                    a.press("#djQ", "Enter")
                first = snd = done = None
                while time.time() - t0 < 120:
                    d = dj(a)
                    if first is None and d["q"]:
                        first = round(time.time() - t0, 1)
                    if snd is None and d["st"] == 1 and d["aud"] and d["id"] and d["pid"] == d["id"]:  # o som desta música (não o da anterior)
                        snd = round(time.time() - t0, 1)
                    new = bots(a)[n0:]
                    if any(any(e in x for e in END) for x in new):
                        done = round(time.time() - t0, 1)
                        break
                    if first is not None and not any("entram em instantes" in x for x in new) and time.time() - t0 > first + 6:
                        done = round(time.time() - t0, 1)
                        break
                    if first is None and time.time() - t0 > 25 and not new:
                        break
                    time.sleep(0.4)
                if first is not None:  # dá tempo de o app começar o som
                    for _ in range(40):
                        d = dj(a)
                        if d["st"] == 1 and d["aud"] and d["id"] and d["pid"] == d["id"]:
                            snd = snd or round(time.time() - t0, 1)
                            break
                        time.sleep(0.5)
                time.sleep(1.5)
                qs = [dj(x)["q"] for x in [a] + others]
                r = {"caso": tag, "pedido": q, "como": how, "primeira_s": first, "som_app_s": snd, "fim_s": done, "fila": [len(x) for x in qs],
                     "igual_3": qs[0] == qs[1] == qs[2], "iframes_app": a.evaluate("() => document.querySelectorAll('iframe[src*=\"youtube\"], #djFrame iframe').length"),
                     "dj": [x.replace("\n", " ")[:300] for x in bots(a)[n0:]], "primeiras": qs[0][:3]}
                res.append(r)
                print(json.dumps(r, ensure_ascii=False), flush=True)
                if qs[0]:
                    say(a, "/stop")
                    for pg in [a] + others:
                        pg.wait_for_function("() => BAGRENATION.dj().q.length === 0", timeout=20000)
                if MODE == "depois":
                    assert r["igual_3"], r
                    assert r["fila"][0] >= minq and first is not None and first < 15, r
                    assert snd is not None, f"o app não tocou o som: {r}"
                    if tag == "grande":
                        assert any("pega as 100 primeiras" in x for x in r["dj"]), r
            br.close()
    finally:
        for c in psutil.Process(pid).children(recursive=True) if psutil.pid_exists(pid) else []:
            c.kill()
        if psutil.pid_exists(pid):
            psutil.Process(pid).kill()
        E.u.CloseDesktop(hdesk)
        E.master_mute(was_muted)
    pathlib.Path(OUT).write_text(json.dumps({"modo": MODE, "app": ver, "site": SITE, "servidor": E.SRV, "casos": res, "erros_console": errors}, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"SPOTIFY APP {'OK' if MODE == 'depois' and not errors else 'REGISTRADO'} (app {ver}, {len(res)} casos, {len(errors)} erros de console)", flush=True)
    if MODE == "depois" and errors:
        print("\n".join(errors))
        sys.exit(1)


if __name__ == "__main__":
    main()
