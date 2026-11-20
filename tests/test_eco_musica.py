"""S-1566: a música do Bagre DJ toca no app de verdade (player do site dentro do app, sem erro 153) e NÃO vaza para a
tela compartilhada nem para a voz.

Cena: o app (Felipe, desktop oculto do Windows) e um Chromium (Martins) no mesmo canal de voz de um servidor de teste.
Felipe põe música (/play) e compartilha a TELA INTEIRA; um processo à parte toca 1500 Hz ("som do PC").
Prova: (1) o player do YouTube toca dentro do app (estado "tocando", tempo andando) e o Windows mostra som saindo da
sessão de áudio do app; (2) na faixa da tela que chega ao Martins o som do PC está lá e a energia da música (faixas de
200 Hz a 3 kHz, longe dos tons do teste) é igual com a música tocando e pausada; (3) a voz do Felipe que chega ao
Martins também não muda com a música tocando ou pausada.
Nenhum som sai na caixa: volume mestre do Windows MUDO durante o teste (volta ao estado de antes no fim).
Uso:  python tests/test_eco_musica.py <bagrenation.exe de teste> [pasta_prints]
"""
import pathlib
import subprocess
import sys
import time

from playwright.sync_api import expect, sync_playwright

sys.path.insert(0, str(pathlib.Path(__file__).parent))
import test_eco as E  # noqa: E402  (desktop oculto, tela falsa, volume mestre, tons)

BUNNY = "https://www.youtube.com/watch?v=aqz-KE-bpKQ"
BANDS = [200, 300, 450, 650, 900, 1150, 2000, 2600, 3100]  # longe de 440, 1500 e 4100 Hz

BAND_DB = """async ([sel, freqs]) => {  // média (dB) das faixas no áudio de um elemento, 12 leituras (silêncio = -inf, vira -200)
  const ac = new AudioContext({ sampleRate: 48000 }); await ac.resume();
  const an = ac.createAnalyser(); an.fftSize = 4096; an.smoothingTimeConstant = 0;
  const el = typeof sel === 'string' ? document.querySelector(sel) : [...document.querySelectorAll('audio')].find((x) => x.srcObject && x.srcObject.getAudioTracks().length);
  ac.createMediaStreamSource(new MediaStream(el.srcObject.getAudioTracks())).connect(an);
  const bins = new Float32Array(an.frequencyBinCount); let acc = 0, n = 0;
  for (let k = 0; k < 12; k++) {
    await new Promise((r) => setTimeout(r, 200));
    an.getFloatFrequencyData(bins);
    for (const f of freqs) { const b = Math.round(f / (ac.sampleRate / an.fftSize)); acc += Math.max(...bins.slice(b - 3, b + 4)); n++; }
  }
  ac.close();
  return acc / n;
}"""


def session_peak(tree):
    from pycaw.pycaw import AudioUtilities, IAudioMeterInformation
    best = 0.0
    for se in AudioUtilities.GetAllSessions():
        if se.Process and se.ProcessId in tree:
            m = se._ctl.QueryInterface(IAudioMeterInformation)
            best = max(best, max(m.GetPeakValue() for _ in range(30) if not time.sleep(0.05)))
    return best


def main():
    import psutil
    base = E.serve()
    E.tone(E.TMP / "voz.wav", E.VOZ, 90, 0.1)
    E.tone(E.TMP / "pc.wav", E.PC, 30)
    was_muted = E.master_mute(True)
    pid, hdesk = E.start_hidden(E.EXE)
    player = None
    errors = []
    try:
        with sync_playwright() as p:
            for _ in range(80):
                try:
                    cdp = p.chromium.connect_over_cdp(f"http://127.0.0.1:{E.PORT}")
                    break
                except Exception:
                    time.sleep(0.5)
            a = cdp.contexts[0].pages[0]
            a.on("console", lambda m: m.type == "error" and "youtube" not in (m.location or {}).get("url", "") and "google" not in (m.location or {}).get("url", "") and errors.append(f"[app] {m.text}"))
            a.set_default_timeout(30000)
            E.wait(a, "!!window.__TAURI__ && document.readyState === 'complete'", 30000)
            a.add_init_script(E.FAKE_MONITOR)
            a.evaluate(f"location.search = '?servidor={E.SRV}'")
            E.wait(a, "document.readyState === 'complete' && location.search.includes('servidor')", 20000)
            if a.locator("#nameDlg").is_visible():
                a.fill("#homeName", "Felipe")
                a.click("#nameForm [type=submit]")
            E.connected(a)
            a.click("#chanVoice")
            expect(a.locator("#vconn")).to_be_visible()

            br = p.chromium.launch(args=["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
                                         f"--use-file-for-fake-audio-capture={E.TMP / 'voz.wav'}", "--autoplay-policy=no-user-gesture-required", "--mute-audio"])
            b = br.new_context(viewport={"width": 1366, "height": 768}).new_page()
            b.add_init_script("localStorage.setItem('bagrenation:vns', '0'); localStorage.setItem('bagrenation:vec', '0')")
            b.on("console", lambda m: m.type == "error" and "youtube" not in (m.location or {}).get("url", "") and "google" not in (m.location or {}).get("url", "") and errors.append(f"[site] {m.text}"))
            b.goto(f"{base}?servidor={E.SRV}")
            b.fill("#homeName", "Martins")
            b.click("#nameForm [type=submit]")
            E.connected(b)
            b.click("#chanVoice")
            for pg in (a, b):
                expect(pg.locator("#voiceCount")).to_have_text("2", timeout=45000)
            E.wait(b, """async () => { const s = await BAGRENATION.voiceStats(); return s.length === 1 && s[0].packetsPerSecond > 20; }""", 45000, 1000)
            print("ok: app (Felipe) e site (Martins) no canal de voz", flush=True)

            # 1. música no app: /play no chat do app, player do site dentro do app
            a.fill("#chatInput", f"/play {BUNNY}")
            a.press("#chatInput", "Enter")
            E.wait(a, "(() => { const d = BAGRENATION.dj(); return d.pid === 'aqz-KE-bpKQ' && d.st === 1 && d.at > 2; })()", 60000, 500)
            a.evaluate("() => BAGRENATION.musSend('seek', { pos: 95 })")  # trecho com música e efeitos fortes
            E.wait(a, "(() => { const d = BAGRENATION.dj(); return d.st === 1 && d.at > 96; })()", 30000, 500)
            E.wait(b, "(() => { const d = BAGRENATION.dj(); return d.st === 1 && d.at > 96; })()", 30000, 500)
            t0 = a.evaluate("() => BAGRENATION.dj().at")
            time.sleep(2)
            t1 = a.evaluate("() => BAGRENATION.dj().at")
            assert t1 - t0 > 1.5, f"o player do app não anda ({t0} -> {t1})"
            dif = abs(a.evaluate("() => { const d = BAGRENATION.dj(); return d.at + (Date.now() - d.now) / 1000; }") - b.evaluate("() => { const d = BAGRENATION.dj(); return d.at + (Date.now() - d.now) / 1000; }"))
            b.click("#micBtn")  # Martins mudo: o som que o app toca agora é só a música
            time.sleep(1.5)
            tree = {pid} | {c.pid for c in psutil.Process(pid).children(recursive=True)}
            peak_on = session_peak(tree)
            a.evaluate("() => BAGRENATION.musSend('pause')")
            E.wait(a, "BAGRENATION.dj().st === 2", 15000, 300)
            time.sleep(1)
            peak_off = session_peak(tree)
            print(f"   app: player do YouTube tocando ({t0:.1f} s -> {t1:.1f} s), igual ao Martins (diferença {dif:.2f} s); pico da sessão de áudio do app com música {peak_on:.3f}, pausada {peak_off:.3f}", flush=True)
            assert peak_on > 0.01 and peak_on > peak_off * 3, f"não deu para ver a música saindo do app (pico {peak_on:.3f} / {peak_off:.3f})"
            a.evaluate("() => BAGRENATION.musSend('resume')")
            E.wait(a, "BAGRENATION.dj().st === 1", 15000, 300)
            b.click("#micBtn")

            # 2. tela inteira do Felipe com som do PC (1500 Hz) e a música tocando no app
            player = subprocess.Popen([sys.executable, "-c", f"import winsound\nfor _ in range(3): winsound.PlaySound(r'{E.TMP / 'pc.wav'}', winsound.SND_FILENAME)"])
            a.click("#shareBtn")
            E.wait(a, "document.querySelector('#shareBtn').classList.contains('is-live')", 20000)
            b.wait_for_selector(".tile video", timeout=30000)
            if b.locator(".unblock").is_visible():
                b.click(".unblock")
            time.sleep(3)
            pc_on = b.evaluate(E.SPECTRUM, [E.PC])[0]
            tela_on = max(-200.0, b.evaluate(BAND_DB, [".tile video", BANDS]))
            voz_on = max(-200.0, b.evaluate(BAND_DB, [None, BANDS]))
            a.evaluate("() => BAGRENATION.musSend('pause')")
            E.wait(a, "BAGRENATION.dj().st === 2", 15000, 300)
            time.sleep(1.5)
            pc_off = b.evaluate(E.SPECTRUM, [E.PC])[0]
            tela_off = max(-200.0, b.evaluate(BAND_DB, [".tile video", BANDS]))
            voz_off = max(-200.0, b.evaluate(BAND_DB, [None, BANDS]))
            print(f"   tela recebida pelo Martins: som do PC {E.PC} Hz {pc_on:.1f} / {pc_off:.1f} dB; faixas da música {tela_on:.1f} dB tocando / {tela_off:.1f} dB pausada", flush=True)
            print(f"   voz do Felipe recebida pelo Martins: faixas da música {voz_on:.1f} dB tocando / {voz_off:.1f} dB pausada", flush=True)
            if E.SHOTS:
                E.SHOTS.mkdir(parents=True, exist_ok=True)
                a.evaluate("() => BAGRENATION.musSend('resume')")
                time.sleep(2)
                a.screenshot(path=str(E.SHOTS / "app_dj_tocando.png"))
                b.screenshot(path=str(E.SHOTS / "eco_musica_martins.png"))
            assert pc_on > -75, f"som do PC não chegou na tela ({pc_on:.1f} dB)"
            assert tela_on - tela_off < 4, f"VAZOU a música na tela: {tela_on:.1f} dB tocando contra {tela_off:.1f} dB pausada"
            assert voz_on - voz_off < 4, f"VAZOU a música na voz: {voz_on:.1f} dB tocando contra {voz_off:.1f} dB pausada"
            print(f"ECO MUSICA OK: a música toca no app (sem erro 153) e não entra na tela nem na voz (diferença {tela_on - tela_off:+.1f} dB / {voz_on - voz_off:+.1f} dB); erros de console: {errors}", flush=True)
            a.click("#shareBtn")
            a.evaluate("() => BAGRENATION.musSend('stop')")
            time.sleep(1)
            br.close()
    finally:
        if player and player.poll() is None:
            player.kill()
        for c in psutil.Process(pid).children(recursive=True) if psutil.pid_exists(pid) else []:
            c.kill()
        if psutil.pid_exists(pid):
            psutil.Process(pid).kill()
        E.u.CloseDesktop(hdesk)
        E.master_mute(was_muted)


if __name__ == "__main__":
    main()
