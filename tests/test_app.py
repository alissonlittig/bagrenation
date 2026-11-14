"""Teste do app para PC (desktop/, Tauri) junto com o site no navegador, na mesma sala.

Abre o app escondido na bandeja (--minimized, a tela não muda), controla a página dele pelo DevTools do WebView2
e coloca um Chromium com microfone e tela falsos na mesma sala. Confere: app <-> site se veem e se ouvem, tela
do site chega no app, tecla global de push-to-talk e de mutar com OUTRA janela em foco (tecla F13/F14 injetada
no Windows, como um teclado), aviso de quem entra, bandeja (eventos), animações pausadas escondido, abrir com
o Windows (registro) e o link da sala apontando para o site público.
Uso:  python tests/test_app.py <caminho do bagrenation.exe> [pasta de prints]
Requer: pip install playwright psutil && playwright install chromium; internet (sinalização PeerJS pública).
"""
import ctypes
import ctypes.wintypes as wt
import functools
import http.server
import os
import pathlib
import re
import subprocess
import sys
import threading
import time
import winreg

from playwright.sync_api import Error as PwError, expect, sync_playwright

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from test_e2e import FAKE_SCREEN, ROOT, connected, launch, playing  # noqa: E402

EXE = pathlib.Path(sys.argv[1])
SHOTS = pathlib.Path(sys.argv[2]) if len(sys.argv) > 2 else None
PORT = 9333
ARGS = ("--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --disable-background-timer-throttling "
        "--disable-renderer-backgrounding --disable-backgrounding-occluded-windows --autoplay-policy=no-user-gesture-required "
        f"--remote-debugging-port={PORT} --use-fake-device-for-media-stream --auto-select-desktop-capture-source=Tela")  # "Tela inteira" do seletor (Windows em português), sem clicar
errors = []

# ---------- tecla "de verdade": SendInput por scan code (o gancho global vê igual a um teclado) ----------
user32 = ctypes.WinDLL("user32", use_last_error=True)


class KEYBDINPUT(ctypes.Structure):
    _fields_ = [("wVk", wt.WORD), ("wScan", wt.WORD), ("dwFlags", wt.DWORD), ("time", wt.DWORD), ("dwExtraInfo", ctypes.c_size_t)]


class INPUT(ctypes.Structure):
    class _U(ctypes.Union):
        _fields_ = [("ki", KEYBDINPUT), ("pad", ctypes.c_byte * 32)]
    _anonymous_ = ("u",)
    _fields_ = [("type", wt.DWORD), ("u", _U)]


def key(scan, up=False):
    i = INPUT(type=1)
    i.ki = KEYBDINPUT(0, scan, 0x0008 | (0x0002 if up else 0), 0, 0)  # KEYEVENTF_SCANCODE (| KEYUP)
    assert user32.SendInput(1, ctypes.byref(i), ctypes.sizeof(i)) == 1, ctypes.get_last_error()


F13, F14 = 0x64, 0x65
# no site, o avatar do "App" acende (alguém falando)
TALKING = "[...document.querySelectorAll('.avatar.speaking')].some((av) => av.closest('li, [data-id]').textContent.includes('App'))"


def wait(pg, expr, timeout=30000, polling=200):
    """wait_for_function sem eval: a CSP do app (script-src 'self') barra o eval do Playwright; evaluate passa pelo DevTools."""
    end = time.time() + timeout / 1000
    while time.time() < end:
        try:
            if pg.evaluate(expr):
                return
        except PwError as e:  # página ainda navegando (o WebView2 abre about:blank e depois o app)
            if "context was destroyed" not in str(e):
                raise
        time.sleep(polling / 1000)
    raise AssertionError(f"tempo esgotado: {expr[:120]}")


def fg_title():
    h = user32.GetForegroundWindow()
    buf = ctypes.create_unicode_buffer(256)
    user32.GetWindowTextW(h, buf, 256)
    return buf.value


def serve():
    h = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(ROOT))
    http.server.SimpleHTTPRequestHandler.log_message = lambda *a: None
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), h)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return f"http://127.0.0.1:{srv.server_port}/"


def autostart_reg():
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Run") as k:
            return winreg.QueryValueEx(k, "BAGRENATION")[0]
    except FileNotFoundError:
        return None


def main():
    base = serve()
    env = dict(os.environ, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=ARGS)
    app = subprocess.Popen([str(EXE), "--minimized"], env=env)
    steps = []
    step = lambda s: (steps.append(s), print("ok:", s, flush=True))
    try:
        with sync_playwright() as p:
            for _ in range(60):
                try:
                    cdp = p.chromium.connect_over_cdp(f"http://127.0.0.1:{PORT}")
                    break
                except Exception:
                    time.sleep(0.5)
            a = cdp.contexts[0].pages[0]
            a.on("pageerror", lambda e: errors.append(f"[app] excecao: {e}"))
            a.on("console", lambda m: m.type == "error" and errors.append(f"[app] console: {m.text}"))
            a.set_default_timeout(30000)
            wait(a, "document.readyState === 'complete'")
            wait(a, "!!window.__TAURI__ && document.readyState === 'complete'", 20000)  # ponte do Tauri
            expect(a.locator("html")).to_have_class("is-app app-hidden")  # aberto na bandeja = animações pausadas
            assert a.evaluate("getComputedStyle(document.querySelector('.coin')).animationPlayState") == "paused"
            assert "BAGRENATION" not in fg_title(), "o app roubou o foco"
            step(f"app abriu escondido na bandeja (foco segue em '{fg_title()[:40]}'), animações pausadas")

            # registra as chamadas da página ao app. window.__TAURI__.core é congelado, então a página recarrega com
            # um window.__TAURI__ embrulhado (mesmas funções, cada invoke anotado em window.__calls).
            a.add_init_script("""(() => { window.__calls = []; let v = window.__TAURI__;
              const wrap = (T) => ({ ...T, __spy: 1, core: { ...T.core, invoke: (c, x, o) => { window.__calls.push([c, x]); return T.core.invoke(c, x, o); } } });
              Object.defineProperty(window, '__TAURI__', { configurable: true, enumerable: true,
                get: () => (v && v.core && !v.__spy ? (v = wrap(v)) : v), set: (T) => { v = T; } }); })()""")
            a.reload()
            wait(a, "document.readyState === 'complete' && window.__calls.some(([c]) => c === 'is_visible')", 20000)
            expect(a.locator("html")).to_have_class("is-app app-hidden")
            a.keyboard.press("Enter")
            a.fill("#homeName", "App")
            a.click("#createBtn")
            connected(a)
            code = a.url.split("#")[1]
            assert a.evaluate("document.getElementById('autoStart').closest('label').hidden") is False
            step(f"app criou a sala {code}")

            browser = launch(p)
            ctx = browser.new_context(viewport={"width": 1366, "height": 768}, bypass_csp=True)
            b = ctx.new_page()
            b.add_init_script(FAKE_SCREEN)
            b.on("pageerror", lambda e: errors.append(f"[site] excecao: {e}"))
            b.goto(base + "#" + code)
            connected(b)
            for pg in (a, b):
                expect(pg.locator("#peopleCount")).to_have_text("2", timeout=45000)
            wait(a, "window.__calls.some(([c, x]) => c === 'notify' && x.body.includes('entrou'))")
            step("site entrou pelo ID; app avisou 'Visitante entrou' com a janela escondida")

            # voz nos dois sentidos (pacotes chegando)
            for pg, who in ((a, "app"), (b, "site")):
                wait(pg, """async () => { const s = await BAGRENATION.voiceStats();
                    return s.length === 1 && s[0].rttMs !== null && /opus/i.test((s[0].recvCodec || {}).mimeType || '') && /opus/i.test((s[0].sendCodec || {}).mimeType || '') && s[0].packetsPerSecond > 20; }""", timeout=45000, polling=1000)
                print("   voz", who, pg.evaluate("async () => JSON.stringify((await BAGRENATION.voiceStats())[0]).slice(0, 300)"))
            step("voz app <-> site: Opus enviando e recebendo nos dois lados")

            # site transmite tela com áudio; app recebe
            b.evaluate("window.__surface = 'window'")
            b.click("#shareBtn")
            playing(a)
            assert a.locator(".tile video").evaluate("v => v.srcObject.getAudioTracks().length") == 1
            if SHOTS:
                SHOTS.mkdir(parents=True, exist_ok=True)
                a.screenshot(path=str(SHOTS / "app_sala_com_tela.png"))
            step("tela + áudio do site chegam no app")

            # app transmite a tela de verdade (getDisplayMedia do WebView2) e o site recebe
            b.click("#shareBtn")  # site para a dele; a única tela no site passa a ser a do app
            expect(b.locator('.tile video')).to_have_count(0)
            a.click("#shareBtn")  # clique de verdade: getDisplayMedia sem gesto do usuário derruba o renderer do WebView2
            expect(a.locator('#shareBtn')).to_have_class(re.compile('is-live'), timeout=15000)
            playing(b, 0)
            vw = b.evaluate("Math.max(...[...document.querySelectorAll('.tile video')].map(v => v.videoWidth))")
            step(f"app transmite a tela do PC pelo WebView2 e o site recebe ({vw} px de largura)")

            # tecla global: push-to-talk F13 e mutar F14, com outra janela em foco
            a.evaluate("document.getElementById('voiceMode').value = 'ptt'; document.getElementById('voiceMode').dispatchEvent(new Event('change'))")
            for btn, k in (("#pttKeyBtn", "F13"), ("#muteKeyBtn", "F14")):
                a.evaluate(f"document.querySelector('{btn}').click()")
                a.evaluate(f"document.dispatchEvent(new KeyboardEvent('keydown', {{ code: '{k}', key: '{k}', bubbles: true }}))")  # Playwright não tem F13
                expect(a.locator(btn)).to_have_text(k)
            a.wait_for_timeout(400)
            assert "BAGRENATION" not in fg_title()
            assert a.evaluate("BAGRENATION.mic().enabled") is False, "PTT solto mas microfone aberto"
            key(F13)
            wait(a, "BAGRENATION.mic().enabled === true", timeout=3000)
            b.wait_for_function(TALKING, timeout=8000)
            key(F13, up=True)
            wait(a, "BAGRENATION.mic().enabled === false", timeout=3000)
            step(f"push-to-talk F13 global com '{fg_title()[:40]}' em foco: abre segurando, fecha soltando; site vê falando")
            key(F14); key(F14, up=True)
            expect(a.locator("#micBtn")).to_have_attribute("aria-pressed", "true")
            b.wait_for_function("[...document.querySelectorAll('.is-muted')].some((el) => el.textContent.includes('App'))")
            key(F14); key(F14, up=True)
            expect(a.locator("#micBtn")).to_have_attribute("aria-pressed", "false")
            step("tecla global de mutar F14: muta e desmuta (site vê o estado)")

            # bandeja: os itens mandam 'tray' para a página
            a.evaluate("window.__TAURI__.event.emit('tray', 'deaf')")
            expect(a.locator("#deafBtn")).to_have_attribute("aria-pressed", "true")
            wait(a, "window.__calls.some(([c, x]) => c === 'tray_state' && x.deaf === true)")
            a.evaluate("window.__TAURI__.event.emit('tray', 'deaf')")
            expect(a.locator("#deafBtn")).to_have_attribute("aria-pressed", "false")
            step("bandeja: ensurdecer liga/desliga e o estado volta para o menu")

            # abrir com o Windows
            before = autostart_reg()
            assert a.evaluate("window.__TAURI__.core.invoke('autostart', { on: true })") is True
            reg = autostart_reg()
            assert reg and "--minimized" in reg and str(EXE.name).lower() in reg.lower(), reg
            a.evaluate(f"window.__TAURI__.core.invoke('autostart', {{ on: {str(bool(before)).lower()} }})")
            step(f"abrir com o Windows grava HKCU Run: {reg}")

            # link da sala = site público
            assert a.evaluate("document.querySelector('#copyLinkBtn') !== null")
            a.evaluate("navigator.clipboard.writeText = (t) => { window.__clip = t; return Promise.resolve(); }")
            a.evaluate("document.getElementById('copyLinkBtn').click()")
            assert a.evaluate("window.__clip") == f"https://alissonlittig.github.io/bagrenation/#{code}", a.evaluate("window.__clip")
            step("copiar link no app dá o endereço do site público")

            a.evaluate("document.getElementById('leaveBtn').click()")
            b.close(); browser.close()
    finally:
        app.terminate()
    if errors:
        print("\n".join(errors))
    assert not errors, f"{len(errors)} erro(s) no console"
    print(f"\nTUDO OK ({len(steps)} passos)")


if __name__ == "__main__":
    main()
