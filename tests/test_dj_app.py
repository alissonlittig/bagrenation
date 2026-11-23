"""S-0037: Bagre DJ 1.8.1 no APP de verdade (Felipe, desktop oculto do Windows, volume mestre mudo) com 2 navegadores do
site publicado (Martins no PC, Cris no celular 390x844), os 3 no canal de voz de um servidor de teste.

1) Versão original (E1 do S-0032): Felipe pede 10 músicas pelo nome com !p; mostra título, canal e duração do que tocou e
   confere que nenhuma é Fortnite/remix/cover/live (Empty Out Your Pockets tem de vir a do Juice WRLD).
2) Comandos estilo Discord no app: !p, cartão Tocando agora nos 3, /play (Na fila), !q, !move, !seek, botão do cartão
   (pausa para os 3), /resume, !lyrics, !np, !dc. O som do app sai pelo <audio> escondido.
Uso:  python tests/test_dj_app.py <bagrenation.exe> <url_do_site> [saida.json]
"""
import json
import pathlib
import re
import sys
import time

from playwright.sync_api import expect, sync_playwright

sys.path.insert(0, str(pathlib.Path(__file__).parent))
import test_eco as E  # noqa: E402

SITE = sys.argv[2]
OUT = sys.argv[3] if len(sys.argv) > 3 else "dj_app.json"
SONGS = ["Empty Out Your Pockets", "Blinding Lights", "Bohemian Rhapsody", "Numb", "Mr. Brightside", "Evidencias",
         "Ai Se Eu Te Pego", "Garota de Ipanema", "Lucifernandis", "Quando Bate Aquela Saudade"]
BAD = re.compile(r"fortnite|remix|cover|nightcore|sped ?up|slowed|karaok|8d audio|\blive\b|ao vivo", re.I)
BUNNY = "https://www.youtube.com/watch?v=aqz-KE-bpKQ"
ZOO = "https://youtu.be/jNQXAC9IVRw"


def say(pg, text):
    pg.fill("#chatInput", text)
    pg.press("#chatInput", "Enter")


def dj(pg):
    return pg.evaluate("() => BAGRENATION.dj()")


def stopped(pages):
    for pg in pages:
        pg.wait_for_function("() => BAGRENATION.dj().q.length === 0", timeout=20000)


def main():
    import psutil
    errors, table, steps = [], [], []
    was_muted = E.master_mute(True)
    pid, hdesk = E.start_hidden(E.EXE)
    ver = ""
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
                pg.on("pageerror", lambda e, n=name: errors.append(f"[{n}] excecao: {e}"))
                pg.set_default_timeout(30000)
                pg.goto(f"{SITE}?servidor={E.SRV}")
                pg.fill("#homeName", name)
                pg.click("#nameForm [type=submit]")
                E.connected(pg)
                if not pg.locator("#chanVoice").is_visible():
                    pg.click("#chanBtn")
                pg.click("#chanVoice")
                others.append(pg)
            m, c = others
            A = [a, m, c]
            for pg in A:
                expect(pg.locator("#voiceCount")).to_have_text("3", timeout=45000)
            c.click("#chanBtn")
            c.click("#chanChat")
            print(f"ok: app {ver} (Felipe) e site (Martins, Cris 390) no canal de voz", flush=True)

            # 1) versão original: 10 músicas pelo nome, pedidas no APP
            for q in SONGS:
                t0 = time.time()
                say(a, f"!p {q}")
                a.wait_for_function("() => BAGRENATION.dj().id", timeout=30000)
                took = round(time.time() - t0, 1)
                snd = None
                for _ in range(40):
                    d = dj(a)
                    if d["st"] == 1 and d["aud"] and d["pid"] == d["id"]:
                        snd = round(time.time() - t0, 1)
                        break
                    time.sleep(0.5)
                info = a.evaluate("() => { const el = [...document.querySelectorAll('#chatLog .djc-np')].pop(); return el ? { t: el.querySelector('.djc-title').textContent, sub: el.querySelector('.djc-sub').textContent, d: el.querySelector('.djc-d').textContent } : null; }")
                d = dj(a)
                r = {"pedido": q, "titulo": d["title"], "canal": (info or {}).get("sub", ""), "duracao": (info or {}).get("d", ""), "id": d["id"], "toca_s": took, "som_app_s": snd,
                     "igual_3": all(dj(x)["id"] == d["id"] for x in others)}
                table.append(r)
                print("E1", json.dumps(r, ensure_ascii=False), flush=True)
                assert not BAD.search(d["title"] or ""), r
                assert r["igual_3"] and snd is not None, r
                say(a, "!dc")
                stopped(A)
            e = table[0]
            assert "juice wrld" in e["canal"].lower() and "fortnite" not in e["titulo"].lower(), e
            steps.append("E1: 10 músicas pelo nome no app, todas a versão original (sem Fortnite/remix/cover/live), mesma música nos 3, som pelo app")

            # 2) comandos no app
            say(a, f"!p {BUNNY}")
            for pg in A:
                expect(pg.locator("#chatLog .djc-np.is-live")).to_contain_text("Big Buck Bunny", timeout=20000)
            steps.append("!p no app: cartão Tocando agora nos 3")
            say(m, f"/play {ZOO}")
            for pg in A:
                expect(pg.locator("#chatLog .djc-add").last).to_contain_text("Na fila · #1", timeout=20000)
            a.evaluate("() => BAGRENATION.musSend('add', { items: [{ id: 'aqz-KE-bpKQ', t: 'Big Buck Bunny (2)', a: 'Blender', d: 635 }, { id: 'jNQXAC9IVRw', t: 'Me at the zoo (3)', a: 'jawed', d: 19 }] })")
            for pg in A:
                pg.wait_for_function("() => BAGRENATION.dj().q.length === 4")
            steps.append("/play do Martins: cartão Na fila · #1 nos 3")
            say(a, "!q")
            expect(a.locator("#chatLog .msg.ephem").last.locator(".djc-q .djc-ol li")).to_have_count(3)
            steps.append("!q no app: fila (3) só para o Felipe")
            say(a, "!move 3 1")
            for pg in A:
                pg.wait_for_function("() => { const d = BAGRENATION.dj(); return d.q[d.i + 1] === 'Me at the zoo (3)'; }")
            steps.append("!move 3 1 no app: mudou nos 3")
            say(c, "!seek 1:30")
            for pg in A:
                pg.wait_for_function("() => { const t = BAGRENATION.dj().target; return t > 89 && t < 97; }")
            a.wait_for_function("() => { const d = BAGRENATION.dj(); return d.st === 1 && d.at > 88; }", timeout=20000)
            steps.append(f"!seek 1:30 da Cris: posição nos 3 e o som do app foi para {dj(a)['at']:.0f} s")
            m.locator("#chatLog .djc-np.is-live .djc-play").click()
            for pg in A:
                pg.wait_for_function("() => BAGRENATION.dj().paused === true")
            a.wait_for_function("() => BAGRENATION.dj().st === 2", timeout=15000)
            say(a, "/resume")
            for pg in A:
                pg.wait_for_function("() => BAGRENATION.dj().paused === false")
            steps.append("⏯ do cartão (Martins) pausou o app e os 2 sites; /resume do app voltou")
            say(a, "!lyrics numb linkin park")
            expect(a.locator("#chatLog .msg.ephem").last.locator(".djc-lyr")).to_contain_text("tired", timeout=30000)
            steps.append("!lyrics no app: letra de Numb (LRCLIB)")
            say(a, "!np")
            expect(a.locator("#chatLog .msg.ephem").last.locator(".djc-np")).to_be_visible()
            say(a, "!dc")
            stopped(A)
            expect(m.locator("#people li.is-bot")).to_have_count(0)
            steps.append("!np e !dc no app: cartão só para ele; !dc tirou o DJ nos 3")
            for s in steps:
                print("ok:", s, flush=True)
            br.close()
    finally:
        for ch in psutil.Process(pid).children(recursive=True) if psutil.pid_exists(pid) else []:
            ch.kill()
        if psutil.pid_exists(pid):
            psutil.Process(pid).kill()
        E.u.CloseDesktop(hdesk)
        E.master_mute(was_muted)
        pathlib.Path(OUT).write_text(json.dumps({"app": ver, "site": SITE, "servidor": E.SRV, "e1": table, "passos": steps, "erros_console": errors}, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"DJ APP {'OK' if not errors else 'COM ERROS'} (app {ver}, {len(table)} músicas, {len(steps)} passos, {len(errors)} erros de console)", flush=True)
    if errors:
        print("\n".join(errors))
        sys.exit(1)


if __name__ == "__main__":
    main()
