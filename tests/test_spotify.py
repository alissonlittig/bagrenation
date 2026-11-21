"""S-0032: playlist do Spotify no Bagre DJ, com 3 navegadores (Ana e Bruno no PC, Cris no celular), sem som (--mute-audio).

Para cada link (playlist comum, editorial, grande, com ?si=, spotify.link, intl-pt, URI spotify:playlist:, /user/<x>/playlist/,
apagada, álbum e faixa), pedido por /play no chat, pelo campo do Bagre DJ (Enter) ou pela Lista:
mede quando a 1ª música toca, espera o "Pronto" do Bagre DJ, compara a fila dos 3 e limpa a fila (/stop).
Modo "antes" só registra o que acontece (sem conferir). Modo "depois" confere: fila igual para os 3, a playlist inteira (até 100)
entra, a 1ª toca logo, o aviso do corte aparece na playlist grande, apagada dá a mensagem certa e álbum e faixa continuam.
Usa um servidor de teste (?servidor=teste-sp-...), então não aparece no BAGRENATION de verdade.
Uso:  python tests/test_spotify.py <url_base> <antes|depois> [saida.json]
"""
import json
import pathlib
import secrets
import sys
import time

from playwright.sync_api import sync_playwright

sys.path.insert(0, str(pathlib.Path(__file__).parent))
import test_e2e as T  # noqa: E402
import test_musica as M  # noqa: E402

CASES = [  # (rótulo, link, como pede, mínimo na fila depois do conserto)
    ("comum", "https://open.spotify.com/playlist/5omtcWLg3swaG4MEuKVGWI", "play", 70),
    ("editorial", "https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M", "campo", 40),
    ("grande", "https://open.spotify.com/playlist/3LXvKNc8Y2lq1pTo1vtVy3", "play", 85),
    ("si", "https://open.spotify.com/playlist/4yYho7LxB5MMHzvjruKv8r?si=wPWu-vhaQdimDVplAmTaTg", "campo", 15),
    ("spotify.link", "https://spotify.link/zLIDHxA0bKb", "play", 85),
    ("intl-pt", "https://open.spotify.com/intl-pt/playlist/37i9dQZF1DXcBWIGoYBM5M", "campo", 40),
    ("uri", "spotify:playlist:37i9dQZF1DXcBWIGoYBM5M", "play", 40),
    ("user", "https://open.spotify.com/user/jaacolaa/playlist/11cFBb5706dtud5VHhUClD?si=_GsPgY3mS2uiNvF86QWrSA", "lista", 65),
    ("apagada", "https://open.spotify.com/playlist/0K592r6lH0IN5zCkM1SGdF", "play", 0),
    ("album", "https://open.spotify.com/album/4LH4d3cOWNNsVw41Gqt2kv", "play", 9),
    ("faixa", "https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT", "campo", 1),
]


def bot_texts(pg):
    return pg.evaluate("() => [...document.querySelectorAll('#chatLog .msg.is-bot')].map((e) => e.innerText)")


def toasts(pg):
    return pg.evaluate("() => [...document.querySelectorAll('#toasts .toast')].map((e) => e.textContent)")


def run(base, mode, out):
    srv = f"teste-sp-{secrets.token_hex(3)}"
    url = f"{base}?servidor={srv}"
    res = []
    with sync_playwright() as p:
        tmp = T.launch(p)
        tmp.close()
        wav = pathlib.Path(T.tempfile.gettempdir()) / "bagrenation_mic_falso.wav"
        br = p.chromium.launch(args=["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", f"--use-file-for-fake-audio-capture={wav}", "--mute-audio"])
        a = M.enter(br, url, "Ana")
        b = M.enter(br, url, "Bruno")
        c = M.enter(br, url, "Cris", viewport={"width": 390, "height": 844})
        for pg in (a, b, c):
            T.join_voice(pg)
        T.voice_ready(a, 2)
        a.click("#djBtn")
        for tag, link, how, minq in CASES:
            n0 = len(bot_texts(a))
            t0 = time.time()
            lista = ""
            if how == "play":
                M.say(a, f"/play {link}")
            elif how == "campo":
                a.fill("#djQ", link)
                a.press("#djQ", "Enter")
            else:  # Lista: vê os resultados e põe todas
                a.fill("#djQ", link)
                a.click("#djList")
                try:
                    a.wait_for_function("() => { const h = document.querySelector('#djResHead'); return h && !/Buscando/.test(h.textContent); }", timeout=60000)
                except Exception:
                    pass
                lista = a.inner_text("#djResHead")
                if a.locator("#djResults .dj-all button").count():
                    a.click("#djResults .dj-all button")
            first = None
            done = None
            while time.time() - t0 < 120:
                d = M.dj(a)
                if first is None and d["q"]:
                    first = round(time.time() - t0, 1)
                new = bot_texts(a)[n0:]
                if any(("Pronto:" in x) or ("não existe" in x) or ("Não achei" in x) or ("Não consegui" in x) or ("Cole o link" in x) or ("não respondeu" in x) for x in new):
                    done = round(time.time() - t0, 1)
                    break
                if first is not None and not any("entram em instantes" in x for x in new) and time.time() - t0 > first + 6:
                    done = round(time.time() - t0, 1)  # sem continuação (faixa, álbum curto, ou o servidor antigo)
                    break
                if first is None and time.time() - t0 > 25 and not new:
                    break  # nada aconteceu (servidor antigo com link que ele não entende)
                a.wait_for_timeout(400)
            a.wait_for_timeout(1500)
            qs = [M.dj(x)["q"] for x in (a, b, c)]
            r = {"caso": tag, "link": link, "como": how, "lista": lista, "primeira_s": first, "fim_s": done, "fila": [len(q) for q in qs],
                 "igual_3": qs[0] == qs[1] == qs[2], "dj": [x.replace("\n", " ")[:300] for x in bot_texts(a)[n0:]], "toasts": toasts(a)[-2:],
                 "primeiras": qs[0][:3]}
            res.append(r)
            print(json.dumps(r, ensure_ascii=False), flush=True)
            if qs[0]:
                M.say(a, "/stop")
                a.wait_for_function("() => BAGRENATION.dj().q.length === 0", timeout=20000)
                for x in (b, c):
                    x.wait_for_function("() => BAGRENATION.dj().q.length === 0", timeout=20000)
            if mode == "depois":
                assert r["igual_3"], r
                if minq:
                    assert r["fila"][0] >= minq, r
                    assert first is not None and first < 15, r
                else:
                    assert any("não existe ou é privado" in x for x in r["dj"]), r
                if tag == "grande":
                    assert any("pega as 100 primeiras" in x for x in r["dj"]), r
                if tag == "user":
                    assert " de " in lista.lower(), r
        errs = [e for e in M.errors if "favicon" not in e]
        br.close()
    pathlib.Path(out).write_text(json.dumps({"modo": mode, "base": base, "servidor": srv, "casos": res, "erros_console": errs}, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"SPOTIFY {'OK' if mode == 'depois' else 'REGISTRADO'} ({len(res)} casos, {len(errs)} erros de console)")
    if mode == "depois" and errs:
        print("\n".join(errs))
        sys.exit(1)


if __name__ == "__main__":
    run(sys.argv[1], sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else f"spotify_{sys.argv[2]}.json")
