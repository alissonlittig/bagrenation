"""S-0057: o app Android (APK instalado no emulador) com 1 cliente do site, num servidor de teste (?servidor=teste-...).

Passos: entrar | voz (ouve o site; o site vê a conexão) | chat com imagem (escolhida no seletor do Android) e imagem do site
chegando | Bagre DJ (player oficial do YouTube pelo player.html do site) | ver a tela do site e tela cheia | compartilhar a
tela do Android (MediaProjection) e seguir transmitindo com o app atrás | voltar não fecha o app.
O app é controlado pelo DevTools do WebView (adb forward) e pelos botões do Android (uiautomator); prints do emulador.
Uso: python tests/test_android.py <pasta_prints>   (emulador ligado, APK instalado; navegador do site sem som)
"""
import functools, http.server, json, pathlib, re, secrets, socket, subprocess, sys, threading, time, xml.etree.ElementTree as ET

from playwright.sync_api import expect, sync_playwright

sys.path.insert(0, str(pathlib.Path(__file__).parent))
import test_e2e as T  # noqa: E402

ADB = r"C:\SISTEMA_ANTIGO\kit\android\sdk\platform-tools\adb.exe"
PKG = "io.github.alissonlittig.bagrenation"
SRV = f"teste-and-{secrets.token_hex(3)}"
T.SRV = SRV  # o cliente do site entra no mesmo servidor de teste
BUNNY = "https://www.youtube.com/watch?v=aqz-KE-bpKQ"
ROOT = pathlib.Path(__file__).resolve().parents[1]
SHOTS = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else None
passos = []


def adb(*a, binario=False, timeout=60):
    r = subprocess.run([ADB, *a], capture_output=True, timeout=timeout)
    return r.stdout if binario else r.stdout.decode("utf-8", "replace")


def ok(t):
    passos.append(t)
    print("ok:", t, flush=True)


def foto(nome):
    if SHOTS:
        SHOTS.mkdir(parents=True, exist_ok=True)
        (SHOTS / f"{nome}.png").write_bytes(adb("exec-out", "screencap", "-p", binario=True))


def nos():
    adb("shell", "uiautomator", "dump", "/sdcard/ui.xml")
    x = adb("shell", "cat", "/sdcard/ui.xml")
    x = x[x.find("<?xml"):]
    out = []
    for n in ET.fromstring(x).iter("node"):
        b = [int(v) for v in re.findall(r"\d+", n.get("bounds", ""))]
        if len(b) == 4:
            out.append(((n.get("text", "") or n.get("content-desc", "")), b))
    return out


def toque(pad, tentativas=15, exato=False):
    """Toca no 1º elemento nativo cujo texto casa com o padrão (regex, sem caixa)."""
    rx = re.compile(pad, re.I)
    for _ in range(tentativas):
        for t, b in nos():
            if (rx.fullmatch(t) if exato else rx.search(t)) and b[2] > b[0]:
                adb("shell", "input", "tap", str((b[0] + b[2]) // 2), str((b[1] + b[3]) // 2))
                time.sleep(0.8)
                return t
        time.sleep(1)
    raise AssertionError(f"não achei na tela do Android: {pad} (tem: {[t for t, _ in nos() if t][:30]})")


def tem(pad):
    rx = re.compile(pad, re.I)
    return any(rx.search(t) for t, _ in nos())


def webview_cdp():
    """Liga a porta 9333 ao DevTools do WebView do app (o APK tem webContentsDebuggingEnabled)."""
    for _ in range(30):
        pid = adb("shell", "pidof", PKG).strip()
        socks = adb("shell", "cat", "/proc/net/unix")
        if pid and f"webview_devtools_remote_{pid}" in socks:
            adb("forward", "tcp:9333", f"localabstract:webview_devtools_remote_{pid}")
            return "http://127.0.0.1:9333"
        time.sleep(1)
    raise AssertionError("DevTools do WebView não apareceu")


JS_ARQ = """b64 => { const u = Uint8Array.from(atob(b64), c => c.charCodeAt(0)); const f = new File([u], 'bagre_teste.png', { type: 'image/png' });
  const dt = new DataTransfer(); dt.items.add(f); const i = document.querySelector('#fileInput'); i.files = dt.files; i.dispatchEvent(new Event('change', { bubbles: true })); }"""


class WV:
    """Cliente mínimo do DevTools do WebView (o Playwright não conecta no WebView do Android): avaliar JS, toque e teclado reais."""
    def __init__(self, url):
        from websockets.sync.client import connect
        alvo = json.loads(subprocess.run(["curl", "-s", url + "/json"], capture_output=True, text=True).stdout)[0]
        self.ws = connect(alvo["webSocketDebuggerUrl"], max_size=None, open_timeout=20)
        self.n, self.logs = 0, []
        self.cmd("Runtime.enable")
        self.cmd("Page.enable")

    def _ev(self, m):
        me = m.get("method")
        if me == "Runtime.consoleAPICalled":
            txt = " ".join(str(a.get("value", a.get("description", ""))) for a in m["params"]["args"])
            self.logs.append((m["params"]["type"], txt))
            if txt.startswith("BAGRE-ANDROID"):
                print("  ", txt, flush=True)
        elif me == "Runtime.exceptionThrown":
            d = m["params"]["exceptionDetails"]
            self.logs.append(("error", f"{d.get('text')} {d.get('exception', {}).get('description', '')}"))

    def cmd(self, method, **params):
        self.n += 1
        i = self.n
        self.ws.send(json.dumps({"id": i, "method": method, "params": params}))
        while True:
            m = json.loads(self.ws.recv(timeout=180))
            if m.get("id") == i:
                if "error" in m:
                    raise AssertionError(f"{method}: {m['error']}")
                return m.get("result", {})
            self._ev(m)

    def evaluate(self, fn, arg=None):
        expr = f"({fn})({json.dumps(arg)})" if arg is not None else f"({fn})()"
        r = self.cmd("Runtime.evaluate", expression=expr, awaitPromise=True, returnByValue=True, userGesture=True)
        if "exceptionDetails" in r:
            raise AssertionError(r["exceptionDetails"].get("exception", {}).get("description") or r["exceptionDetails"].get("text"))
        return r["result"].get("value")

    def wait_for_function(self, fn, arg=None, timeout=45000):
        fim = time.time() + timeout / 1000
        while True:
            try:
                v = self.evaluate(fn, arg)
            except AssertionError:
                v = None
            if v:
                return v
            if time.time() > fim:
                raise AssertionError(f"esperei {timeout} ms e não aconteceu no Android: {fn[:160]}")
            time.sleep(0.5)

    def wait_for_timeout(self, ms):
        time.sleep(ms / 1000)

    def visible(self, sel):
        return self.evaluate("s => { const e = document.querySelector(s); if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; }", sel)

    def click(self, sel, timeout=30000):
        self.wait_for_function("s => { const e = document.querySelector(s); if (!e) return false; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; }", sel, timeout)
        x, y = self.evaluate("s => { const r = document.querySelector(s).getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; }", sel)
        self.cmd("Input.dispatchTouchEvent", type="touchStart", touchPoints=[{"x": x, "y": y}])
        self.cmd("Input.dispatchTouchEvent", type="touchEnd", touchPoints=[])
        time.sleep(0.4)

    def fill(self, sel, text):
        self.evaluate("s => { const e = document.querySelector(s); e.focus(); e.value = ''; e.dispatchEvent(new Event('input', { bubbles: true })); }", sel)
        self.cmd("Input.insertText", text=text)

    def enter(self, sel):
        self.evaluate("s => document.querySelector(s).focus()", sel)
        self.cmd("Input.dispatchKeyEvent", type="keyDown", key="Enter", code="Enter", windowsVirtualKeyCode=13, nativeVirtualKeyCode=13, text="\r")
        self.cmd("Input.dispatchKeyEvent", type="keyUp", key="Enter", code="Enter", windowsVirtualKeyCode=13, nativeVirtualKeyCode=13)

    def goto(self, url):
        self.cmd("Page.navigate", url=url)
        time.sleep(1.5)
        self.wait_for_function("() => document.readyState === 'complete'")

    def erros(self):
        return [t for k, t in self.logs if k == "error"]


def a_connected(app):
    app.wait_for_function("() => document.querySelector('#status').dataset.state === 'ok'", timeout=45000)


def a_join_voice(app):
    if not app.visible("#chanVoice"):
        app.click("#panelBtn")
    app.click("#chanVoice")
    app.wait_for_function("() => !!document.querySelector('#vconn')")


def a_voice_ready(app, n):
    app.wait_for_function("async n => { const s = await window.BAGRENATION.voiceStats(); return s.length === n && s.every(x => x.rttMs !== null); }", n, 60000)


def a_hears(app, name):
    app.wait_for_function("async name => { const s = (await window.BAGRENATION.voiceStats()).find(x => x.name === name); return !!s && s.audioLevelIn > 0.01; }", name, 20000)


def a_playing(app):
    app.wait_for_function("() => { const v = document.querySelector('.tile video'); return v && v.videoWidth > 0 && v.currentTime > 0.5; }", timeout=45000)
    t0 = app.evaluate("() => document.querySelector('.tile video').currentTime")
    time.sleep(1.2)
    assert app.evaluate("() => document.querySelector('.tile video').currentTime") > t0, "vídeo congelado no Android"


def servir():
    s = socket.socket(); s.bind(("127.0.0.1", 0)); port = s.getsockname()[1]; s.close()
    class Q(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a): pass
    h = functools.partial(Q, directory=str(ROOT))
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", port), h)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return f"http://127.0.0.1:{port}/index.html"


def main():
    base = servir()
    erros = []
    adb("shell", "am", "force-stop", PKG)
    adb("logcat", "-c")
    for perm in ("android.permission.RECORD_AUDIO", "android.permission.POST_NOTIFICATIONS", "android.permission.BLUETOOTH_CONNECT"):
        adb("shell", "pm", "grant", PKG, perm)
    adb("shell", "am", "start", "-W", "-n", f"{PKG}/.MainActivity")
    time.sleep(4)
    foto("a00_abriu")
    with sync_playwright() as p:
        tmp = T.launch(p); tmp.close()  # cria o microfone falso (tom de 440 Hz)
        wav = pathlib.Path(T.tempfile.gettempdir()) / "bagrenation_mic_falso.wav"
        br = p.chromium.launch(args=["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", f"--use-file-for-fake-audio-capture={wav}", "--mute-audio", "--autoplay-policy=no-user-gesture-required", "--disable-features=WebRtcHideLocalIpsWithMdns"])  # emulador atrás de NAT duplo: o site mostra o IP da rede local em vez do .local
        site = T.page(br, "Site", viewport={"width": 1366, "height": 768})
        site.on("console", lambda m: m.type == "error" and "youtube" not in m.text.lower() and "google" not in m.text.lower() and erros.append(f"[site] {m.text}"))

        app = WV(webview_cdp())
        assert app.evaluate("() => document.documentElement.classList.contains('is-android') && !!window.BAGRE_MOB"), "mobile.js não ligou"
        info = app.evaluate("() => Capacitor.Plugins.Bagre.info()")
        print("app", info, flush=True)

        # 1. entrar (servidor de teste) com nome
        app.goto(f"https://localhost/?servidor={SRV}")
        app.wait_for_function("() => !!window.BAGRE_MOB")
        if app.visible("#nameDlg"):
            app.fill("#homeName", "Droid")
            app.click("#nameForm [type=submit]")
        a_connected(app)
        T.enter(site, base, "Sitio", voice=False)
        app.wait_for_function("() => BAGRENATION.members().some(m => m.name === 'Sitio')")
        foto("a01_entrou")
        ok(f"entrar: app {info['version']} no servidor de teste {SRV}, vê o Sitio na lista")

        # 2. voz com o site
        a_join_voice(app)
        T.join_voice(site)
        a_voice_ready(app, 1)
        T.voice_ready(site, 1)
        a_hears(app, "Sitio")
        mic = app.evaluate("() => BAGRENATION.mic()")
        assert mic, "microfone do Android não abriu"
        svc = adb("shell", "dumpsys", "activity", "services", PKG)
        assert "CallService" in svc and "isForeground=true" in svc, "serviço da voz não está em primeiro plano"
        st = app.evaluate("async () => (await BAGRENATION.voiceStats())[0]")
        foto("a02_voz")
        ok(f"voz: conectado ao Sitio (ping {st.get('rttMs')} ms), ouve o Sitio (nível {st.get('audioLevelIn'):.3f}), microfone aberto ({mic.get('sampleRate')} Hz, {mic.get('channelCount')} canal), serviço em primeiro plano ligado")

        # 3. chat com imagem: escolhida no seletor de arquivos do Android
        img = ROOT / "og.png"
        adb("push", str(img), "/sdcard/Download/bagre_teste.png")
        adb("shell", "am", "broadcast", "-a", "android.intent.action.MEDIA_SCANNER_SCAN_FILE", "-d", "file:///sdcard/Download/bagre_teste.png")
        if not app.visible("#chatInput"):  # celular na voz: o #chat fica na gaveta dos canais
            app.click("#panelBtn")
            app.click("#chanChat")
            app.wait_for_function("() => document.querySelector('#room').dataset.view === 'chat'")
        app.click("#fileBtn")
        time.sleep(2.5)
        try:
            if tem("Recent|Recentes|Downloads|Files|Arquivos|Choose|Escolher"):
                foto("a03_seletor_android")
                if not tem("bagre_teste"):
                    try: toque(r"Show roots|Mostrar raízes", 3)
                    except AssertionError: pass
                    toque(r"^Downloads$|^Download$", 5, exato=True)
                toque("bagre_teste", 10)
                via = "seletor do Android"
            else:
                raise AssertionError("seletor não abriu")
        except AssertionError as e:
            print("  seletor nativo:", e, flush=True)
            adb("shell", "input", "keyevent", "4")
            import base64
            app.evaluate(JS_ARQ, base64.b64encode(img.read_bytes()).decode())
            via = "campo de arquivo (seletor nativo não respondeu)"
        time.sleep(1.5)
        app.wait_for_function("() => !document.querySelector('#attach').hidden", timeout=15000)
        app.click(".composer-row [type=submit]")
        expect(site.locator("#chatLog .msg img").last).to_be_visible(timeout=45000)
        site.evaluate("""async () => { const c = document.createElement('canvas'); c.width = 320; c.height = 200; const g = c.getContext('2d');
          g.fillStyle = '#ff2bd6'; g.fillRect(0, 0, 320, 200); g.fillStyle = '#00f0ff'; g.fillRect(40, 40, 240, 120);
          const b = await new Promise(r => c.toBlob(r, 'image/png')); const f = new File([b], 'do_site.png', { type: 'image/png' });
          const dt = new DataTransfer(); dt.items.add(f); const i = document.querySelector('#fileInput'); i.files = dt.files; i.dispatchEvent(new Event('change', { bubbles: true })); }""")
        site.wait_for_timeout(1200)
        site.click(".composer-row [type=submit]")
        app.wait_for_function("() => document.querySelectorAll('#chatLog .msg img').length >= 2", timeout=45000)
        app.fill("#chatInput", "foi pelo celular")
        app.enter("#chatInput")
        expect(site.locator("#chatLog")).to_contain_text("foi pelo celular")
        foto("a03_chat_imagem")
        ok(f"chat com imagem: o Android mandou uma imagem ({via}) que chegou no site, recebeu a do site e mandou texto")

        # 4. Bagre DJ pelo player oficial do site
        site.fill("#chatInput", f"!p {BUNNY}")
        site.press("#chatInput", "Enter")
        app.wait_for_function("() => { const d = BAGRENATION.dj(); return d.pid === 'aqz-KE-bpKQ' && d.st === 1 && d.at > 1; }", timeout=60000)
        d = app.evaluate("() => BAGRENATION.dj()")
        src = app.evaluate("() => (document.querySelector('#djFrame iframe') || {}).src || ''")
        assert "alissonlittig.github.io/bagrenation/player.html" in src, f"player do DJ não é o do site: {src}"
        assert not d["aud"], "no Android o DJ não usa o yt-dlp"
        t0 = d["at"]; app.wait_for_timeout(3000)
        t1 = app.evaluate("() => BAGRENATION.dj().at")
        assert t1 > t0 + 2, f"DJ parado no Android ({t0} -> {t1})"
        g = abs(app.evaluate("() => BAGRENATION.dj().at") - site.evaluate("() => BAGRENATION.dj().at"))
        if not app.evaluate("() => !!document.querySelector('#djCover')"):
            raise AssertionError("capa do player sumiu")
        foto("a04_dj")
        ok(f"Bagre DJ: '{d['title']}' tocando no Android pelo player.html do site (player oficial coberto), tempo andando {t0:.1f} -> {t1:.1f} s, diferença para o site {g:.2f} s")
        site.fill("#chatInput", "!dc"); site.press("#chatInput", "Enter")

        # 5. ver a tela do site, em tela cheia
        app.click("#panelBtn")
        app.click("#chanVoice")
        app.wait_for_function("() => document.querySelector('#room').dataset.view === 'voice'")
        site.click("#shareBtn")
        a_playing(app)
        if app.visible(".unblock"):
            app.click(".unblock")
        foto("a05_vendo_tela")
        app.click(".tile .js-full")
        app.wait_for_function("() => document.fullscreenElement && document.fullscreenElement.classList.contains('tile')", timeout=15000)
        time.sleep(3)
        still = app.evaluate("() => !!document.fullscreenElement")
        assert still, "a tela cheia fechou sozinha"
        rot = adb("shell", "dumpsys", "window", "displays")
        foto("a06_tela_cheia")
        deitado = "mCurrentRotation=ROTATION_90" in rot or "mCurrentRotation=ROTATION_270" in rot or "rotation=1" in rot or "rotation=3" in rot
        adb("shell", "input", "keyevent", "4")  # voltar sai da tela cheia
        app.wait_for_function("() => !document.fullscreenElement", timeout=10000)
        ok(f"ver a tela do outro: a transmissão do site toca no Android; tela cheia fica aberta (sem barras){' e o celular deita' if deitado else ''}; voltar sai da tela cheia")
        site.click("#shareBtn")  # o site para de transmitir

        # 6. compartilhar a tela do Android
        app.click("#shareBtn")
        time.sleep(2)
        foto("a07_pedido_captura")
        try:
            if tem("A single app|Um único app|Single app"):
                toque("A single app|Um único app|Single app")
                toque("Entire screen|Tela inteira|Share entire screen")
        except AssertionError:
            pass
        toque(r"^(Start|Iniciar|Start now|Iniciar agora|Share screen|Compartilhar tela)$", 10, exato=True)
        site.wait_for_function("async () => (await BAGRENATION.screen()).some(x => x.got > 20000)", timeout=45000)
        T.playing(site)
        wh = site.evaluate("() => { const v = document.querySelector('.tile video'); return [v.videoWidth, v.videoHeight]; }")
        foto("a08_compartilhando_android")
        T.SHOTS = SHOTS
        T.shot(site, "a09_site_vendo_android")
        ok(f"compartilhar tela: o site recebe a tela do Android ({wh[0]}x{wh[1]}) pelo MediaProjection")

        # 7. app atrás (HOME): voz e tela continuam
        g0 = site.evaluate("async () => (await BAGRENATION.screen()).reduce((n, x) => n + x.got, 0)")
        adb("shell", "input", "keyevent", "3")
        time.sleep(2)
        adb("shell", "am", "start", "-a", "android.settings.SETTINGS")
        time.sleep(6)
        g1 = site.evaluate("async () => (await BAGRENATION.screen()).reduce((n, x) => n + x.got, 0)")
        a_hears(app, "Sitio")
        foto("a10_app_atras_configuracoes")
        T.shot(site, "a11_site_vendo_config_do_android")
        assert g1 > g0 + 20000, f"a tela parou com o app atrás ({g0} -> {g1} bytes)"
        ok(f"app atrás: com as Configurações na frente a tela segue chegando no site (+{(g1 - g0) // 1024} KB em 6 s) e o Android ainda ouve o Sitio")
        adb("shell", "am", "start", "-n", f"{PKG}/.MainActivity")
        time.sleep(2)
        app.click("#shareBtn")  # parar de transmitir
        time.sleep(2)
        svc = adb("shell", "dumpsys", "activity", "services", PKG)
        ok("parar a tela: " + ("serviço segue só com a voz" if "CallService" in svc else "serviço fechado"))

        # 8. voltar com nada aberto: o app vai para trás e continua na voz
        adb("shell", "input", "keyevent", "4")
        time.sleep(2)
        vivo = adb("shell", "pidof", PKG).strip()
        a_hears(app, "Sitio")
        ok(f"voltar: o app foi para trás sem fechar (processo {vivo}) e continua na voz")
        app.evaluate("() => BAGRE_MOB.hooks.leave()")
        time.sleep(2)
        svc = adb("shell", "dumpsys", "activity", "services", PKG)
        ok("sair da voz: " + ("serviço em primeiro plano desligado" if "CallService" not in svc else "AINDA LIGADO"))
        br.close()
    log = adb("logcat", "-d", "-s", "BagreCall:*", "AndroidRuntime:E")
    (SHOTS / "logcat.txt").write_text(log, encoding="utf-8") if SHOTS else None
    ruins = [e for e in erros + [f"[android] {x}" for x in app.erros()] if "ERR_BLOCKED_BY_CLIENT" not in e and "youtube" not in e.lower() and "google" not in e.lower()]
    print(json.dumps({"passos": len(passos), "erros_console": ruins[:20]}, ensure_ascii=False, indent=1))
    print("ANDROID OK" if not ruins else "ANDROID OK COM AVISOS DE CONSOLE", f"({len(passos)} passos)")


if __name__ == "__main__":
    main()
