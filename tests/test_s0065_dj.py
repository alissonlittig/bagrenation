"""S-0065: Bagre DJ para de verdade em todos os aparelhos. 3 clientes num servidor de teste (?servidor=teste-s65-...):
Ana e Bruno como o app de PC (window.__TAURI__ simulado: a música toca num <audio>, como no app de verdade, com um tom
local no lugar do áudio do YouTube) e Cris no site (390x844, player oficial do YouTube). Navegador sem som (--mute-audio).

O que conta é o que cada aparelho está tocando de verdade: <audio> do app (não pausado, com endereço) e o player do site.
Passos: tocar nos 3 | pausar e voltar | pular | a fila acabou = para em todos | fila limpa (!clear) | sair da call (só
quem saiu para) | entrar no meio (volta sincronizado) | 2 canais de voz ao mesmo tempo (cada um ouve o seu; !stop num não
mexe no outro; trocar de canal troca a música) | tirar o DJ (!dc) = para em todos | !stop = para em todos.
Na 1.9.0 o app de PC seguia tocando depois de !stop/!dc, da fila acabar e de sair da call (djSync só olhava o iframe).
Uso:  python tests/test_s0065_dj.py [url_base] [pasta_prints]
"""
import functools
import http.server
import math
import pathlib
import secrets
import struct
import sys
import tempfile
import threading
import time
import wave

from playwright.sync_api import expect, sync_playwright

sys.path.insert(0, str(pathlib.Path(__file__).parent))
import test_e2e as T  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRV = f"teste-s65-{secrets.token_hex(3)}"
BUNNY = "https://www.youtube.com/watch?v=aqz-KE-bpKQ"  # 10 min, toca embutido
ZOO = "https://youtu.be/jNQXAC9IVRw"                    # 19 s: a fila acaba sozinha
steps, errors = [], []
TONE = {"url": ""}

FAKE_APP = """
(() => {
  const ok = (v) => Promise.resolve(v);
  window.__auds = [];
  const A = window.Audio;
  // o tom falso dura 3 min: sem duração, ele não muda a duração da música no servidor (a do YouTube vale, como no app de verdade)
  window.Audio = function (...a) { const x = new A(...a); Object.defineProperty(x, 'duration', { get: () => NaN }); window.__auds.push(x); return x; };
  window.Audio.prototype = A.prototype;
  window.__TAURI__ = {
    core: { invoke: (cmd) => cmd === 'dj_audio' ? ok(window.__TONE + '?expire=' + (Math.floor(Date.now() / 1000) + 3600)) : cmd === 'is_visible' ? ok(true) : ok(null),
            Channel: class { constructor() { this.onmessage = null; } } },
    event: { listen: () => ok(() => {}) },
    opener: { openUrl: () => ok() },
    app: { getVersion: () => ok('teste') },
  };
})();
"""

SOUND = """() => {
  if (window.__auds) {  // app de PC: o que sai é o <audio>
    const a = window.__auds.filter((x) => !x.paused && x.src && !x.ended);
    return { on: a.length > 0, n: a.length, t: a.length ? a[0].currentTime : null, mode: 'app' };
  }
  const d = BAGRENATION.dj();  // site: o player oficial (iframe)
  return { on: !!d.frame && d.st === 1 && Date.now() - 0 > 0, t: d.at, mode: 'site', st: d.st, frame: d.frame };
}"""


def step(t):
    steps.append(t)
    print(f"ok {len(steps):2d}: {t}", flush=True)


def sound(pg):
    return pg.evaluate(SOUND)


def wait_sound(pg, on, label, timeout=40):
    """espera o aparelho tocar (on=True) ou ficar em silêncio (on=False); tocando = o tempo anda"""
    end = time.time() + timeout
    last = None
    while time.time() < end:
        s = sound(pg)
        last = s
        if on and s["on"]:
            t0 = s["t"] or 0
            pg.wait_for_timeout(1200)
            s2 = sound(pg)
            if s2["on"] and (s2["t"] or 0) > t0 + 0.4:
                return s2
        if not on and not s["on"]:
            pg.wait_for_timeout(1500)  # e continua em silêncio
            if not sound(pg)["on"]:
                return s
        pg.wait_for_timeout(300)
    raise AssertionError(f"{label}: esperava {'tocando' if on else 'em silêncio'} e está {last}")


def dj(pg):
    return pg.evaluate("() => BAGRENATION.dj()")


OPS = {"!pause": "pause", "!resume": "resume", "!skip": "skip", "!dc": "leave", "!stop": "stop", "!clear": "clear"}


def say(pg, text):
    if not pg.locator("#chatInput").is_visible():  # celular no canal de voz: o chat fica em outra aba; o botão do painel manda a mesma ordem
        assert text in OPS, text
        assert pg.evaluate("op => BAGRENATION.musSend(op)", OPS[text]), f"musSend {text}"
        return
    pg.fill("#chatInput", text)
    pg.press("#chatInput", "Enter")


def page(br, name, app, viewport=None):
    ctx = br.new_context(viewport=viewport or {"width": 1366, "height": 768}, is_mobile=bool(viewport), has_touch=bool(viewport))
    pg = ctx.new_page()
    pg.add_init_script(T.FAKE_SCREEN)
    if app:
        pg.add_init_script(f"window.__TONE = {TONE['url']!r};")
        pg.add_init_script(FAKE_APP)

    def con(m):
        u = (m.location or {}).get("url", "")
        if m.type == "error" and not any(x in u for x in ("youtube", "ytimg", "google", "doubleclick", "gstatic", "googlevideo")):
            errors.append(f"[{name}] console: {m.text} {u}")
    pg.on("console", con)
    pg.on("pageerror", lambda e: errors.append(f"[{name}] excecao: {e}"))
    pg.set_default_timeout(30000)
    return pg


def enter(br, url, name, app, **kw):
    pg = page(br, name, app, **kw)
    pg.goto(url)
    pg.fill("#homeName", name)
    pg.click("#nameForm [type=submit]")
    T.connected(pg)
    T.join_voice(pg)
    return pg


def leave_voice(pg):
    pg.click("#leaveBtn") if pg.locator("#leaveBtn").is_visible() else pg.evaluate("() => document.getElementById('leaveBtn').click()")
    pg.wait_for_function("() => !BAGRENATION.chans().myVch", timeout=15000)


def join_chan(pg, ch):
    pg.evaluate("ch => document.querySelector(`.chan[data-ch=\"${ch}\"]`).click()", ch)
    pg.wait_for_function("ch => BAGRENATION.chans().myVch === ch", arg=ch, timeout=15000)


def tone_file():
    """3 min de tom baixo (o navegador está sem som); servido na mesma origem do site (a CSP só aceita 'self')"""
    f = pathlib.Path(tempfile.gettempdir()) / "s65_tom.wav"
    if not f.exists():
        with wave.open(str(f), "wb") as w:
            w.setnchannels(1); w.setsampwidth(2); w.setframerate(8000)
            w.writeframes(b"".join(struct.pack("<h", int(3000 * math.sin(2 * math.pi * 330 * i / 8000))) for i in range(8000 * 180)))
    return f


def site_server():
    tom = tone_file()

    class Q(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a): pass

        def translate_path(self, path):  # o tom do app de PC simulado (fora do repo)
            return str(tom) if path.split("?")[0] == "/__tom.wav" else super().translate_path(path)
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Q, directory=str(ROOT)))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return f"http://127.0.0.1:{srv.server_address[1]}/"


def run(base, shots):
    url = f"{base}?servidor={SRV}"
    TONE["url"] = f"{base}__tom.wav"  # base externa: o arquivo __tom.wav precisa estar na pasta dela
    with sync_playwright() as p:
        T.launch(p).close()  # cria o microfone falso
        wav = pathlib.Path(tempfile.gettempdir()) / "bagrenation_mic_falso.wav"
        br = p.chromium.launch(args=["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", f"--use-file-for-fake-audio-capture={wav}",
                                     "--autoplay-policy=no-user-gesture-required", "--mute-audio"])
        ana = enter(br, url, "Ana", True)
        bruno = enter(br, url, "Bruno", True)
        cris = enter(br, url, "Cris", False, viewport={"width": 390, "height": 844})
        todos = [("Ana", ana), ("Bruno", bruno), ("Cris", cris)]
        assert dj(ana)["aud"] is False and ana.evaluate("() => document.documentElement.classList.contains('is-app')"), "Ana devia estar como o app de PC"
        step(f"3 clientes no canal de voz de {SRV}: Ana e Bruno como o app de PC (<audio>), Cris no site 390x844 (player do YouTube)")

        say(ana, f"!p {BUNNY}")
        for n, pg in todos:
            wait_sound(pg, True, f"{n} depois de !p")
        assert dj(ana)["aud"] and dj(bruno)["aud"] and dj(cris)["frame"], "modos errados"
        step("!p: tocando nos 3 (Ana e Bruno pelo <audio> do app, Cris pelo player do site)")

        say(bruno, "!pause")
        for n, pg in todos:
            wait_sound(pg, False, f"{n} depois de !pause")
        say(cris, "!resume")
        for n, pg in todos:
            wait_sound(pg, True, f"{n} depois de !resume")
        step("pausar (!pause do Bruno) silencia os 3; voltar (!resume da Cris) toca nos 3")

        k0 = dj(ana)["k"]
        say(ana, f"!p {ZOO}")
        ana.wait_for_function("() => BAGRENATION.dj().q.length >= 2", timeout=20000)
        say(cris, "!skip")
        for n, pg in todos:
            pg.wait_for_function("k => { const d = BAGRENATION.dj(); return d.k && d.k !== k; }", arg=k0, timeout=20000)
            wait_sound(pg, True, f"{n} depois de !skip")
        assert dj(cris)["id"] == "jNQXAC9IVRw", dj(cris)
        step("pular (!skip da Cris): os 3 vão para a próxima e continuam tocando")

        for n, pg in todos:  # 'Me at the zoo' tem 19 s: a fila acaba sozinha
            wait_sound(pg, False, f"{n} quando a fila acabou", timeout=60)
        assert all(dj(pg)["id"] is None for _, pg in todos), [dj(pg)["id"] for _, pg in todos]
        step("a fila acabou: silêncio nos 3 (na 1.9.0 o app de PC seguia tocando)")

        say(ana, f"!p {BUNNY}")
        for n, pg in todos:
            wait_sound(pg, True, f"{n} depois do 2o !p")
        say(bruno, f"!p {ZOO}")
        say(bruno, f"!p {ZOO}")
        ana.wait_for_function("() => { const d = BAGRENATION.dj(); return d.q.length - d.i - 1 >= 2; }", timeout=20000)
        say(ana, "!clear")
        for n, pg in todos:
            pg.wait_for_function("() => { const d = BAGRENATION.dj(); return d.id && d.q.length - d.i - 1 === 0; }", timeout=15000)
            wait_sound(pg, True, f"{n} depois de !clear")
        step("fila limpa (!clear): as 2 da fila saem nos 3 e a atual continua tocando")

        leave_voice(bruno)
        wait_sound(bruno, False, "Bruno saiu da call", timeout=8)
        wait_sound(ana, True, "Ana com o Bruno fora")
        wait_sound(cris, True, "Cris com o Bruno fora")
        step("sair da call: o Bruno (app de PC) para na hora; Ana e Cris seguem (na 1.9.0 o app de PC seguia tocando fora da call)")

        T.join_voice(bruno)
        wait_sound(bruno, True, "Bruno voltou no meio")
        d = dj(bruno)
        gap = abs((d["at"] or 0) - (d["target"] or 0))
        assert gap < 2.5, f"Bruno voltou fora do ponto: {d['at']} x {d['target']}"
        step(f"entrar no meio: o Bruno volta e toca no ponto do canal (diferença {gap:.2f} s)")

        ch2 = ana.evaluate("""async (base) => { // canal de voz novo, por uma conexão à parte
          const key = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
          const ws = new WebSocket(base.replace(/^http/, 'ws') + '/ws');
          return await new Promise((ok, no) => {
            ws.onmessage = (e) => { const d = JSON.parse(e.data); if (d.t === 'ok') ws.send(JSON.stringify({ t: 'chan', op: 'add', kind: 'voice', name: 'Sala 2' })); if (d.t === 'chanok') { ws.close(); ok(d.id); } if (d.t === 'err') no(d.text); };
            ws.onopen = () => ws.send(JSON.stringify({ t: 'me', key, name: 'Criador', av: '', st: 'on' }));
            setTimeout(() => no('sem resposta'), 10000);
          });
        }""", f"https://bagrenation-chat.alissondelittig.workers.dev/s/{SRV}")
        bruno.wait_for_selector(f'.chan[data-ch="{ch2}"]', state="attached", timeout=15000)
        kv = dj(ana)["k"]
        join_chan(bruno, ch2)
        wait_sound(bruno, False, "Bruno na Sala 2 (sem música)", timeout=8)
        say(bruno, f"!p {BUNNY}")
        wait_sound(bruno, True, "Bruno tocando na Sala 2")
        assert dj(bruno)["k"] != kv and dj(ana)["k"] == kv, "os 2 canais se misturaram"
        say(bruno, "!stop")
        wait_sound(bruno, False, "Bruno depois de !stop na Sala 2", timeout=8)
        wait_sound(ana, True, "Ana no canal de voz depois do !stop da Sala 2")
        wait_sound(cris, True, "Cris no canal de voz depois do !stop da Sala 2")
        join_chan(bruno, "voz")
        wait_sound(bruno, True, "Bruno de volta ao canal de voz")
        assert dj(bruno)["k"] == kv, "o Bruno voltou tocando outra música"
        step("2 canais de voz ao mesmo tempo: a Sala 2 tocou a sua sem mexer no canal de voz; !stop na Sala 2 parou só lá; trocar de canal troca a música (e canal sem música = silêncio)")

        if shots:
            T.SHOTS = pathlib.Path(shots)
            T.shot(ana, "s65_01_dj_tocando_ana")
        say(cris, "!dc")
        for n, pg in todos:
            wait_sound(pg, False, f"{n} depois de !dc", timeout=10)
        assert all(dj(pg)["id"] is None for _, pg in todos)
        step("tirar o Bagre DJ (!dc da Cris): silêncio nos 3, inclusive nos 2 apps de PC")

        say(ana, f"!p {BUNNY}")
        for n, pg in todos:
            wait_sound(pg, True, f"{n} depois do 3o !p")
        say(bruno, "!stop")
        for n, pg in todos:
            wait_sound(pg, False, f"{n} depois de !stop", timeout=10)
        step("!stop do Bruno: silêncio nos 3")
        if shots:
            T.shot(ana, "s65_02_dj_parado_ana")
        br.close()


if __name__ == "__main__":
    base = sys.argv[1] if len(sys.argv) > 1 and sys.argv[1] != "local" else None
    shots = sys.argv[2] if len(sys.argv) > 2 else None
    base = base or site_server()
    try:
        run(base, shots)
    except Exception as e:  # noqa: BLE001
        print(f"FALHOU no passo {len(steps) + 1}: {e}", flush=True)
        print("RESULTADO", {"rc": 1, "passos": len(steps), "erro": str(e)[:300]})
        sys.exit(1)
    bad = [e for e in errors if "ERR_BLOCKED_BY_CLIENT" not in e]
    print("\n".join(bad[:10]))
    print(f"S0065 DJ OK ({len(steps)} passos), {len(bad)} erro(s) de console")
    print("RESULTADO", {"rc": 0, "passos": len(steps), "erros_console": len(bad)})
