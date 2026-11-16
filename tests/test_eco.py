"""S-1354: tela inteira compartilhada pelo app NÃO leva a voz do BAGRENATION (quem assiste não se escuta).

Cena do Felipe e do Martins: o app (Felipe) e um Chromium (Martins) no mesmo canal de voz de um servidor de teste.
O microfone do Martins é um tom de 4100 Hz ("voz"), que o app do Felipe toca no PC. Um processo à parte toca 1500 Hz
("som do PC": anime, jogo). O Felipe compartilha a TELA INTEIRA (surface 'monitor'); o navegador entregaria um som do
sistema falso de 440 Hz, que o app tem de trocar pelo som nativo sem o próprio app. Na faixa que chega ao Martins:
1500 Hz presente, 440 Hz ausente e 4100 Hz igual com o Martins falando e mudo (a voz dele não entra na tela).
Controle: a mesma voz chega forte no app (o teste veria se ela vazasse).
O app roda num desktop oculto do Windows (nada aparece na tela) e é uma cópia de teste (outro identificador, não
mexe no BAGRENATION instalado). Os tons tocam baixo (-20 a -26 dBFS) por uns 20 s. Com pycaw instalado, lista quem o
Windows diz que está tocando (prova que a voz sai pela sessão do WebView2 do app).
Nenhum som sai na caixa: o volume mestre do Windows fica MUDO durante o teste (o loopback pega o som antes do volume
mestre) e volta ao estado de antes no fim. Requer pycaw (pip install pycaw).
Uso:  python tests/test_eco.py <bagrenation.exe de teste> [pasta_prints]
"""
import ctypes
import ctypes.wintypes as wt
import math
import os
import pathlib
import secrets
import struct
import subprocess
import sys
import tempfile
import time
import wave

from playwright.sync_api import expect, sync_playwright

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from test_app import ARGS, PORT, serve, wait  # noqa: E402
from test_e2e import connected  # noqa: E402

EXE = pathlib.Path(sys.argv[1])
SHOTS = pathlib.Path(sys.argv[2]) if len(sys.argv) > 2 else None
SRV = f"teste-eco-{secrets.token_hex(3)}"
VOZ, PC, NAV = 4100, 1500, 440  # voz num tom alto (fala real dos outros no PC quase não tem 4,1 kHz)
TMP = pathlib.Path(tempfile.mkdtemp(prefix="bagre_eco_"))

# tela falsa = "tela inteira" com som do sistema falso (440 Hz), como o Chromium entregaria
FAKE_MONITOR = """navigator.mediaDevices.getDisplayMedia = async () => {
  const c = Object.assign(document.createElement('canvas'), { width: 1280, height: 720 });
  const g = c.getContext('2d'); let n = 0;
  setInterval(() => { g.fillStyle = `hsl(${n++ % 360} 60% 35%)`; g.fillRect(0, 0, 1280, 720); }, 33);
  const ac = new AudioContext(); const o = ac.createOscillator(); o.frequency.value = 440;
  const d = ac.createMediaStreamDestination(); o.connect(d); o.start();
  const v = c.captureStream(30).getVideoTracks()[0]; const real = v.getSettings.bind(v);
  v.getSettings = () => ({ ...real(), displaySurface: 'monitor' });
  return new MediaStream([v, ...d.stream.getAudioTracks()]);
};"""

# nível (dB) de cada frequência na faixa de áudio da tela recebida (média de 8 leituras)
SPECTRUM = """async (freqs) => {
  const ac = new AudioContext({ sampleRate: 48000 }); await ac.resume();
  const an = ac.createAnalyser(); an.fftSize = 8192; an.smoothingTimeConstant = 0;
  const v = document.querySelector('.tile video');
  ac.createMediaStreamSource(new MediaStream(v.srcObject.getAudioTracks())).connect(an);
  const bins = new Float32Array(an.frequencyBinCount), acc = freqs.map(() => 0);
  for (let k = 0; k < 8; k++) {
    await new Promise((r) => setTimeout(r, 250));
    an.getFloatFrequencyData(bins);
    freqs.forEach((f, i) => { const b = Math.round(f / (ac.sampleRate / an.fftSize)); acc[i] += Math.max(...bins.slice(b - 2, b + 3)) / 8; });
  }
  ac.close();
  return acc;
}"""


def tone(path, hz, secs, amp=0.05):
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(48000)
        w.writeframes(b"".join(struct.pack("<h", int(amp * 32767 * math.sin(2 * math.pi * hz * i / 48000))) for i in range(int(48000 * secs))))


# ---------- desktop oculto (CreateDesktop): a janela do app nunca aparece na tela ----------
u = ctypes.WinDLL("user32", use_last_error=True)
k = ctypes.WinDLL("kernel32", use_last_error=True)
u.CreateDesktopW.restype = wt.HANDLE
u.CreateDesktopW.argtypes = [wt.LPCWSTR, wt.LPCWSTR, ctypes.c_void_p, wt.DWORD, wt.DWORD, ctypes.c_void_p]


class STARTUPINFOW(ctypes.Structure):
    _fields_ = [("cb", wt.DWORD), ("lpReserved", wt.LPWSTR), ("lpDesktop", wt.LPWSTR), ("lpTitle", wt.LPWSTR),
                ("dwX", wt.DWORD), ("dwY", wt.DWORD), ("dwXSize", wt.DWORD), ("dwYSize", wt.DWORD),
                ("dwXCountChars", wt.DWORD), ("dwYCountChars", wt.DWORD), ("dwFillAttribute", wt.DWORD), ("dwFlags", wt.DWORD),
                ("wShowWindow", wt.WORD), ("cbReserved2", wt.WORD), ("lpReserved2", ctypes.c_void_p),
                ("hStdInput", wt.HANDLE), ("hStdOutput", wt.HANDLE), ("hStdError", wt.HANDLE)]


class PROCESS_INFORMATION(ctypes.Structure):
    _fields_ = [("hProcess", wt.HANDLE), ("hThread", wt.HANDLE), ("dwProcessId", wt.DWORD), ("dwThreadId", wt.DWORD)]


def start_hidden(exe):
    desk = "bagrenation_eco_teste"
    hdesk = u.CreateDesktopW(desk, None, None, 0, 0x10000000, None)  # GENERIC_ALL
    assert hdesk, ctypes.get_last_error()
    os.environ["WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"] = ARGS  # herdado pelo app
    si = STARTUPINFOW(); si.cb = ctypes.sizeof(si); si.lpDesktop = desk
    if os.environ.get("ECO_LOG"):  # saída de erro do app num arquivo (diagnóstico)
        import msvcrt
        f = open(os.environ["ECO_LOG"], "wb")
        h = msvcrt.get_osfhandle(f.fileno())
        k.SetHandleInformation(wt.HANDLE(h), 1, 1)
        si.dwFlags = 0x100; si.hStdOutput = si.hStdError = h
    pi = PROCESS_INFORMATION()
    ok = k.CreateProcessW(str(exe), f'"{exe}"', None, None, bool(os.environ.get("ECO_LOG")), 0x08000000, None, None, ctypes.byref(si), ctypes.byref(pi))  # CREATE_NO_WINDOW
    assert ok, ctypes.get_last_error()
    return pi.dwProcessId, hdesk


def master_mute(on):
    """Muda o volume mestre do Windows; devolve o estado anterior."""
    from pycaw.pycaw import AudioUtilities
    vol = AudioUtilities.GetSpeakers().EndpointVolume
    before = bool(vol.GetMute())
    vol.SetMute(int(on), None)
    return before


def main():
    import psutil
    base = serve()
    tone(TMP / "voz.wav", VOZ, 60, 0.1)
    tone(TMP / "pc.wav", PC, 30)
    was_muted = master_mute(True)  # antes de qualquer som; volta no finally
    pid, hdesk = start_hidden(EXE)
    player = None
    errors = []
    try:
        with sync_playwright() as p:
            for _ in range(80):
                try:
                    cdp = p.chromium.connect_over_cdp(f"http://127.0.0.1:{PORT}")
                    break
                except Exception:
                    time.sleep(0.5)
            a = cdp.contexts[0].pages[0]
            a.on("console", lambda m: m.type == "error" and errors.append(f"[app] {m.text}"))
            a.set_default_timeout(30000)
            wait(a, "!!window.__TAURI__ && document.readyState === 'complete'", 30000)
            a.add_init_script(FAKE_MONITOR)
            a.evaluate(f"location.search = '?servidor={SRV}'")
            wait(a, "document.readyState === 'complete' && location.search.includes('servidor')", 20000)
            if a.locator("#nameDlg").is_visible():
                a.fill("#homeName", "Felipe")
                a.click("#nameForm [type=submit]")
            connected(a)
            a.click("#chanVoice")
            expect(a.locator("#vconn")).to_be_visible()

            br = p.chromium.launch(args=["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
                                         f"--use-file-for-fake-audio-capture={TMP / 'voz.wav'}", "--autoplay-policy=no-user-gesture-required",
                                         "--mute-audio"])  # Martins está em outro PC: o som dele não sai nas caixas deste
            b = br.new_context(viewport={"width": 1366, "height": 768}).new_page()
            b.add_init_script("localStorage.setItem('bagrenation:vns', '0'); localStorage.setItem('bagrenation:vec', '0')")  # sem filtro de ruído: tom contínuo passa
            b.on("console", lambda m: m.type == "error" and errors.append(f"[site] {m.text}"))
            b.goto(f"{base}?servidor={SRV}")
            b.fill("#homeName", "Martins")
            b.click("#nameForm [type=submit]")
            connected(b)
            b.click("#chanVoice")
            for pg in (a, b):
                expect(pg.locator("#voiceCount")).to_have_text("2", timeout=45000)
            print("ok: app (Felipe) e site (Martins) no canal de voz", flush=True)

            # o app está tocando a voz do Martins (700 Hz) no PC
            wait(a, """async () => { const s = await BAGRENATION.voiceStats(); return s.length === 1 && s[0].packetsPerSecond > 20; }""", 45000, 1000)
            player = subprocess.Popen([sys.executable, "-c",
                                       f"import winsound,time\nfor _ in range(2): winsound.PlaySound(r'{TMP / 'pc.wav'}', winsound.SND_FILENAME)"])
            tree = {pid} | {c.pid for c in psutil.Process(pid).children(recursive=True)}
            audio_proc = [c.pid for c in psutil.Process(pid).children(recursive=True) if "audio.mojom" in " ".join(c.cmdline())]
            print(f"   árvore do app: {len(tree)} processos; serviço de áudio do WebView2 (pid {audio_proc}) é filho do app: {bool(audio_proc)}; som do PC no pid {player.pid} (fora da árvore: {player.pid not in tree})", flush=True)
            assert audio_proc, "serviço de áudio do WebView2 não está na árvore do app"
            try:  # quem o Windows diz que está tocando som (diagnóstico)
                from pycaw.pycaw import AudioUtilities
                time.sleep(1)
                from pycaw.pycaw import IAudioMeterInformation
                for se in AudioUtilities.GetAllSessions():
                    if se.Process:
                        peak = max(se._ctl.QueryInterface(IAudioMeterInformation).GetPeakValue() for _ in range(20) if not time.sleep(0.05))
                        print(f"   sessão de áudio: pid {se.ProcessId} {se.Process.name()} pico {peak:.3f} {'(árvore do app)' if se.ProcessId in tree else ''}", flush=True)
            except ImportError:
                pass

            a.click("#shareBtn")
            wait(a, "document.querySelector('#shareBtn').classList.contains('is-live')", 20000)
            b.wait_for_selector(".tile video", timeout=30000)
            if b.locator(".unblock").is_visible():
                b.click(".unblock")
            time.sleep(3)
            pc, voz, nav = b.evaluate(SPECTRUM, [PC, VOZ, NAV])
            b.click("#micBtn")  # Martins muda: o que sobrar em 4100 Hz é do ambiente, não da voz dele
            time.sleep(1.5)
            pc2, voz_mudo, nav2 = b.evaluate(SPECTRUM, [PC, VOZ, NAV])
            b.click("#micBtn")
            print(f"   faixa da tela recebida pelo Martins: {PC} Hz (som do PC) {pc:.1f} dB · {VOZ} Hz (voz dele) falando {voz:.1f} dB / mudo {voz_mudo:.1f} dB · {NAV} Hz (som do sistema do navegador) {nav:.1f} dB", flush=True)
            time.sleep(1.5)
            # controle: a voz do Martins chega forte no app (se vazasse, apareceria na tela)
            ctl = a.evaluate("""async () => { const ac = new AudioContext({ sampleRate: 48000 }); await ac.resume();
                const an = ac.createAnalyser(); an.fftSize = 8192;
                const el = [...document.querySelectorAll('audio')].find((x) => x.srcObject && x.srcObject.getAudioTracks().length);
                ac.createMediaStreamSource(el.srcObject).connect(an); await new Promise((r) => setTimeout(r, 800));
                const d = new Float32Array(an.frequencyBinCount); an.getFloatFrequencyData(d);
                const b = Math.round(%d / (48000 / 8192)); const v = Math.max(...d.slice(b - 2, b + 3)); ac.close(); return v; }""" % VOZ)
            print(f"   controle: voz do Martins tocando no app a {VOZ} Hz = {ctl:.1f} dB", flush=True)
            if SHOTS:
                SHOTS.mkdir(parents=True, exist_ok=True)
                b.screenshot(path=str(SHOTS / "eco_martins_assiste.png"))
            assert ctl > -50, f"a voz do Martins não está tocando forte no app (controle falhou: {ctl:.1f} dB)"
            assert pc > -75 and pc2 > -75, f"som do PC não chegou na tela ({pc:.1f} dB)"
            assert voz - voz_mudo < 6, f"VAZOU a voz do BAGRENATION: {voz:.1f} dB falando contra {voz_mudo:.1f} dB mudo"
            assert voz < ctl - 30, f"VAZOU a voz do BAGRENATION ({voz:.1f} dB na tela, {ctl:.1f} dB no app)"
            assert max(nav, nav2) < pc - 40, f"o som do sistema do navegador não foi trocado ({nav:.1f} dB)"
            print(f"ECO OK: só o som do PC vai na tela; a voz do Martins fica {ctl - voz:.0f} dB abaixo do que o app toca e não muda com ele mudo; erros de console: {errors}", flush=True)
            a.click("#shareBtn")  # parar
            br.close()
    finally:
        if player and player.poll() is None:
            player.kill()
        for c in psutil.Process(pid).children(recursive=True) if psutil.pid_exists(pid) else []:
            c.kill()
        if psutil.pid_exists(pid):
            psutil.Process(pid).kill()
        u.CloseDesktop(hdesk)
        master_mute(was_muted)


if __name__ == "__main__":
    main()
