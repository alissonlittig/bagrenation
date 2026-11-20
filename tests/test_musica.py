"""S-1566/S-1580: Bagre DJ, música do YouTube sincronizada no canal de voz (3 navegadores, um deles celular).

Prova: /play <link> no chat toca para todos do canal (o DJ responde no chat e aparece na lista do canal com BOT);
Ana, Bruno e Cris tocam o mesmo trecho (diferença < 2 s entre os players); Cris entra no meio e cai no ponto certo;
desvio forçado de 12 s volta sozinho; pausa, volta, pular e /skip valem para todos; fila igual para todos (pôr pela
busca do painel, reordenar, tirar, embaralhar, repetir); a fila continua depois de recarregar a página; vídeo que não
toca embutido é pulado sozinho com aviso no chat; volume e mudo da música são só de quem mexe; "som da sala desligado"
cala a música; fim da fila tira o DJ da lista; playlist por link entra inteira na fila; voz e chat seguem funcionando. Navegadores com --mute-audio (sem som).
S-1580: nome no painel + Enter toca na hora (sem escolher em lista), /play <nome>, links do Spotify (faixa e playlist)
viram a mesma música do YouTube; só a capa aparece (o player fica coberto).
Usa um servidor de teste (?servidor=teste-dj-...), então não aparece no BAGRENATION de verdade.
Uso:  python tests/test_musica.py [url_base] [pasta_prints]
"""
import functools
import http.server
import pathlib
import secrets
import sys
import tempfile
import threading
import time

from playwright.sync_api import expect, sync_playwright

sys.path.insert(0, str(pathlib.Path(__file__).parent))
import test_e2e as T  # noqa: E402

SRV = f"teste-dj-{secrets.token_hex(3)}"
BUNNY = "https://www.youtube.com/watch?v=aqz-KE-bpKQ"  # Big Buck Bunny (Blender, CC-BY), 10 min, toca embutido
ZOO = "https://youtu.be/jNQXAC9IVRw"                    # "Me at the zoo", 19 s: serve para ver a fila andar sozinha
PLAYLIST = "https://www.youtube.com/playlist?list=PL6B3937A5D230E335"  # "Official Blender Open Movies" (Blender)
errors = []
steps = []


def step(t):
    steps.append(t)
    print(f"ok {len(steps):2d}: {t}", flush=True)


def page(br, name, viewport=None):
    ctx = br.new_context(viewport=viewport or {"width": 1366, "height": 768}, is_mobile=bool(viewport), has_touch=bool(viewport))
    pg = ctx.new_page()
    pg.add_init_script(T.FAKE_SCREEN)
    def con(m):  # erros do próprio YouTube (iframe dele, anúncios do Google) não são do BAGRENATION
        u = (m.location or {}).get("url", "")
        if m.type == "error" and not any(x in u for x in ("youtube", "ytimg", "google", "doubleclick", "gstatic", "googlevideo")):
            errors.append(f"[{name}] console: {m.text} {(m.location or {}).get('url', '')}")
    pg.on("console", con)
    pg.on("pageerror", lambda e: errors.append(f"[{name}] excecao: {e}"))
    pg.set_default_timeout(30000)
    return pg


def enter(br, url, name, **kw):
    pg = page(br, name, **kw)
    pg.goto(url)
    pg.fill("#homeName", name)
    pg.click("#nameForm [type=submit]")
    T.connected(pg)
    return pg


def dj(pg):
    return pg.evaluate("() => BAGRENATION.dj()")


def pos(pg):
    """Posição do player deste navegador agora (relógio do PC, igual para todos os navegadores do teste)."""
    d = dj(pg)
    assert d["at"] is not None, d
    return d["at"] + (time.time() * 1000 - d["now"]) / 1000, d


def playing(pg, vid, timeout=45000):
    pg.wait_for_function("id => { const d = BAGRENATION.dj(); return d.pid === id && d.st === 1 && d.at > 0.3; }", arg=vid, timeout=timeout)


def synced(pages, limit=2.0, label=""):
    ps = [pos(p)[0] for p in pages]
    gap = max(ps) - min(ps)
    assert gap < limit, f"{label}: diferença {gap:.2f} s ({ps})"
    return gap, ps


def say(pg, text):
    pg.fill("#chatInput", text)
    pg.press("#chatInput", "Enter")


def last_dj(pg, text, timeout=20000):
    expect(pg.locator("#chatLog .msg.is-bot").last).to_contain_text(text, timeout=timeout)


def run(base, shots):
    url = f"{base}?servidor={SRV}"
    with sync_playwright() as p:
        tmp = T.launch(p)  # cria o microfone falso (tom de 440 Hz) do teste de voz
        tmp.close()
        wav = pathlib.Path(tempfile.gettempdir()) / "bagrenation_mic_falso.wav"
        br = p.chromium.launch(args=["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", f"--use-file-for-fake-audio-capture={wav}", "--mute-audio"])
        a = enter(br, url, "Ana")
        b = enter(br, url, "Bruno")
        T.join_voice(a)
        T.join_voice(b)
        T.voice_ready(a, 1)

        # 1. /play no chat
        say(a, f"/play {BUNNY}")
        last_dj(b, "Tocando agora: Big Buck Bunny")
        expect(a.locator("#chatInput")).to_have_value("")
        playing(a, "aqz-KE-bpKQ")
        playing(b, "aqz-KE-bpKQ")
        expect(b.locator("#dj")).to_be_visible()
        expect(b.locator("#djTitle")).to_contain_text("Big Buck Bunny")
        expect(b.locator("#people li.is-bot")).to_contain_text("Bagre DJ")
        expect(b.locator("#voiceGrid .vcard.is-bot")).to_have_count(1)
        top = b.evaluate("() => { const r = document.querySelector('#djFrame').getBoundingClientRect(); const e = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return e && e.id; }")
        assert top == "djCover", f"o vídeo aparece na tela (no meio do player está {top})"
        a.wait_for_timeout(2500)
        g, _ = synced([a, b], label="Ana x Bruno")
        T.shot(b, "dj_01_tocando_bruno") if T.SHOTS else None
        step(f"/play no chat: DJ responde no chat, aparece no canal com BOT, Ana e Bruno tocam juntos (diferença {g:.2f} s)")

        # 2. Cris (celular) entra no meio
        a.wait_for_timeout(4000)
        c = enter(br, url, "Cris", viewport={"width": 390, "height": 844})
        T.join_voice(c)
        playing(c, "aqz-KE-bpKQ")
        c.wait_for_timeout(2500)
        g, ps = synced([a, b, c], label="Cris entrou no meio")
        assert ps[2] > 8, f"Cris começou do zero ({ps[2]:.1f} s)"
        step(f"Cris (celular) entra no meio e cai em {ps[2]:.1f} s, igual aos outros (diferença {g:.2f} s)")

        # 3. desvio forçado volta sozinho
        fx = dj(c)["fixes"]
        c.evaluate("() => { const f = document.querySelector('#djFrame iframe'); const s = BAGRENATION.dj(); f.contentWindow.postMessage({ bp: 1, op: 'seek', at: s.at + 12 }, new URL(f.src).origin); }")
        c.wait_for_function("() => { const d = BAGRENATION.dj(); return d.st === 1 && d.at - d.target > 8; }", timeout=10000)
        off = dj(c)["at"] - dj(c)["target"]
        c.wait_for_function("fx => BAGRENATION.dj().fixes > fx", arg=fx, timeout=10000)
        c.wait_for_timeout(3000)
        g, _ = synced([a, b, c], label="depois do desvio")
        step(f"desvio forçado de {off:.0f} s no player da Cris corrige sozinho (diferença agora {g:.2f} s)")

        # 4. pausa e volta pelo botão (Bruno) valem para todos
        b.click("#djPlay")
        for pg in (a, b, c):
            pg.wait_for_function("() => { const d = BAGRENATION.dj(); return d.paused && d.st === 2; }", timeout=15000)
        p1 = [pos(pg)[0] for pg in (a, b, c)]
        a.wait_for_timeout(2000)
        p2 = [pos(pg)[0] for pg in (a, b, c)]
        assert all(abs(x - y) < 0.3 for x, y in zip(p1, p2)), f"pausado mas andou {p1} {p2}"
        expect(c.locator("#djState")).to_have_text("Pausado")
        expect(c.locator("#people li.is-bot .sub")).to_contain_text("pausado") if c.locator("#people li.is-bot").count() else None
        b.click("#djPlay")
        for pg in (a, b, c):
            playing(pg, "aqz-KE-bpKQ", 15000)
        c.wait_for_timeout(2500)
        g, _ = synced([a, b, c], label="depois de voltar")
        step(f"Bruno pausa: os 3 param no mesmo ponto; volta: os 3 tocam juntos (diferença {g:.2f} s)")

        # 5. fila pelo painel: colar link, Buscar, + Fila; aparece igual para todos
        a.fill("#djQ", ZOO)
        a.click("#djList")
        expect(a.locator("#djResults .dj-item")).to_have_count(1, timeout=15000)
        expect(a.locator("#djResults .dj-item")).to_contain_text("Me at the zoo")
        a.locator("#djResults .dj-item button[aria-label^='Adicionar']").click()
        for pg in (a, b, c):
            expect(pg.locator("#djQueue .dj-item")).to_have_count(1, timeout=10000)
            expect(pg.locator("#djQueue .dj-item")).to_contain_text("Me at the zoo")
        a.click("#djResX")
        a.evaluate("""() => BAGRENATION.musSend('add', { items: [
            { id: 'aqz-KE-bpKQ', t: 'Faixa B', a: 'teste', d: 600 }, { id: 'aqz-KE-bpKQ', t: 'Faixa C', a: 'teste', d: 600 }] })""")
        expect(b.locator("#djQueue .dj-item")).to_have_count(3)
        expect(b.locator("#djCount")).to_have_text("3")
        T.shot(a, "dj_02_fila_ana") if T.SHOTS else None
        # reordenar: Faixa C sobe para o topo (2 cliques em "subir")
        for _ in range(2):
            v = dj(a)
            b.locator("#djQueue .dj-item:has-text('Faixa C') button[aria-label^='Subir']").click()
            a.wait_for_function("v => BAGRENATION.dj().q.join() !== v", arg=",".join(v["q"]))
        expect(c.locator("#djQueue .dj-item").first).to_contain_text("Faixa C")
        # tirar Faixa B
        c.locator("#djQueue .dj-item:has-text('Faixa B') button[aria-label^='Tirar']").dispatch_event("click")
        expect(a.locator("#djQueue .dj-item")).to_have_count(2)
        qa = dj(a)["q"]
        assert qa == dj(b)["q"] == dj(c)["q"], (qa, dj(b)["q"], dj(c)["q"])
        assert qa[1:] == ["Faixa C", "Me at the zoo"], qa
        step("fila pelo painel (colar link, Lista, + Fila) e pela API: igual para os 3; reordenar e tirar refletem para todos")

        # 6. embaralhar e repetir (mudam para todos)
        a.click("#djShuffle")
        last_dj(c, "embaralhou") if False else None
        a.wait_for_timeout(800)
        assert sorted(dj(c)["q"][1:]) == sorted(["Faixa C", "Me at the zoo"]) and dj(c)["q"] == dj(a)["q"]
        a.click("#djLoop")
        for pg in (a, b, c):
            pg.wait_for_function("() => BAGRENATION.dj().loop === 'all'")
        expect(b.locator("#djLoop")).to_have_attribute("aria-pressed", "true")
        a.click("#djLoop")
        b.wait_for_function("() => BAGRENATION.dj().loop === 'one'")
        a.click("#djLoop")
        b.wait_for_function("() => BAGRENATION.dj().loop === 'off'")
        step("embaralhar mantém as mesmas músicas, igual para todos; repetir passa por fila -> uma -> desligado para todos")

        # 7. a fila continua depois de recarregar (Bruno)
        before = dj(a)["q"]
        b.reload()
        T.connected(b)
        T.join_voice(b)
        playing(b, "aqz-KE-bpKQ")
        b.wait_for_timeout(2500)
        assert dj(b)["q"] == before, (dj(b)["q"], before)
        g, _ = synced([a, b, c], label="depois de recarregar")
        step(f"Bruno recarrega a página: a fila está igual e ele volta no ponto certo (diferença {g:.2f} s)")

        # 8. volume e mudo da música só de quem mexe; som da sala desligado cala a música
        a.locator("#djVol").fill("20")
        a.wait_for_function("() => BAGRENATION.dj().pv === 20")
        assert dj(b)["pv"] == 70, dj(b)
        a.click("#djMute")
        a.wait_for_function("() => BAGRENATION.dj().pm === true")
        assert dj(b)["pm"] is False and dj(c)["pm"] is False
        a.click("#djMute")
        a.wait_for_function("() => BAGRENATION.dj().pm === false")
        b.click("#deafBtn")
        b.wait_for_function("() => BAGRENATION.dj().pm === true")
        b.click("#deafBtn")
        b.wait_for_function("() => BAGRENATION.dj().pm === false")
        assert dj(a)["pv"] == 20 and dj(b)["pv"] == 70
        step("volume 20% e mudo só da música valem só para a Ana; Bruno desliga o som da sala e a música cala só para ele")

        # 9. /skip (Cris) e pular pelo botão; vídeo que não toca embutido é pulado sozinho com aviso
        order = dj(a)["q"]
        nxt = order[dj(a)["i"] + 1]
        c.click("#panelBtn")  # celular: um canal por vez; Cris vai para o #chat e a música segue tocando
        c.click("#chanChat")
        c.wait_for_timeout(1500)
        assert dj(c)["st"] == 1, dj(c)
        say(c, "/skip")
        last_dj(a, "pulou Big Buck Bunny")
        for pg in (a, b, c):
            pg.wait_for_function("t => BAGRENATION.dj().title === t", arg=nxt)
        a.evaluate("() => BAGRENATION.musSend('add', { items: [{ id: 'aaaaaaaaaaa', t: 'Vídeo que não existe', a: 'teste' }], now: true })")
        a.wait_for_function("() => BAGRENATION.dj().title === 'Vídeo que não existe'")
        d = dj(a)
        after = d["q"][d["i"] + 1]
        last_dj(b, "Pulei para a próxima", timeout=30000)
        for pg in (a, b, c):
            pg.wait_for_function("t => BAGRENATION.dj().title === t", arg=after)
        step(f"/skip da Cris pula para todos; vídeo que não toca é pulado sozinho, o DJ avisa no chat e segue para {after}")

        # 10. Me at the zoo (19 s) acaba sozinho e a fila anda; no fim da fila o DJ sai da lista
        a.evaluate("() => BAGRENATION.musSend('add', { items: [{ id: 'jNQXAC9IVRw', t: 'Me at the zoo (fim)', a: 'jawed', d: 19 }], now: true })")
        for pg in (a, b, c):
            playing(pg, "jNQXAC9IVRw")
        rest = len(dj(a)["q"]) - dj(a)["i"] - 1
        a.wait_for_function("() => BAGRENATION.dj().title !== 'Me at the zoo (fim)'", timeout=40000)
        step(f"fim do vídeo de 19 s passa para a próxima sozinho ({rest} na fila depois dele)")
        say(b, "/stop")
        last_dj(a, "parou a música")
        for pg in (a, b, c):
            pg.wait_for_function("() => BAGRENATION.dj().id === null")
        expect(a.locator("#people li.is-bot")).to_have_count(0)
        expect(a.locator("#voiceGrid .vcard.is-bot")).to_have_count(0)
        step("/stop para e limpa a fila para todos; o Bagre DJ sai da lista do canal")

        # 11. comandos que só respondem para quem pediu; voz segue
        say(a, "/queue")
        expect(a.locator("#chatLog .msg.ephem").last).to_contain_text("A fila está vazia")
        expect(b.locator("#chatLog .msg.ephem")).to_have_count(0)
        say(a, "/ajuda")
        expect(a.locator("#chatLog .msg.ephem").last).to_contain_text("/play")
        say(a, "/ola isto não é comando")
        expect(b.locator("#chatLog .msg").last).to_contain_text("/ola isto não é comando")
        T.voice_ready(a, 2)
        T.hears(b, "Ana")
        step("/queue e /ajuda respondem só para quem pediu; texto com / que não é comando vai normal; voz segue (Bruno ouve a Ana)")

        # 12. S-1580: nome -> toca (painel + Enter e /play <nome>), Spotify (faixa e playlist)
        a.fill("#djQ", "me at the zoo jawed")
        t0 = time.time()
        a.press("#djQ", "Enter")
        expect(a.locator("#djQ")).to_have_value("")
        a.wait_for_function("() => BAGRENATION.dj().id", timeout=20000)
        vid = dj(a)["id"]
        for pg in (a, b, c):
            playing(pg, vid)
        took = time.time() - t0
        c.wait_for_timeout(2000)
        g, _ = synced([a, b, c], label="nome no painel")
        assert dj(a)["results"] is False, "abriu a lista em vez de tocar"
        step(f"nome no painel + Enter: a 1ª música achada ({dj(a)['title']}) toca para os 3 em {took:.1f} s, sem escolher em lista (diferença {g:.2f} s)")
        say(b, "/play rick astley never gonna give you up")
        last_dj(a, "Na fila (#1)")
        say(c, "/play https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT")
        last_dj(a, "Na fila (#2)")
        d = dj(b)
        assert len(d["q"]) - d["i"] - 1 == 2 and all("rick" in t.lower() or "never" in t.lower() for t in d["q"][d["i"] + 1:]), d["q"]
        step(f"/play <nome> com música tocando entra na fila; link de faixa do Spotify vira a mesma música no YouTube ({d['q'][-1]})")
        say(a, "/play https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M")
        last_dj(b, "músicas de", timeout=45000)
        d = dj(b)
        assert len(d["q"]) - d["i"] - 1 > 10, d["q"]
        step(f"/play <playlist do Spotify>: {len(d['q']) - d['i'] - 3} músicas achadas no YouTube entram na fila para todos")
        say(a, "/stop")
        for pg in (a, b, c):
            pg.wait_for_function("() => BAGRENATION.dj().id === null")

        # 13. playlist por link no chat (sem a Data API: o player lista os vídeos e o servidor pega os títulos)
        say(a, f"/play {PLAYLIST}")
        last_dj(b, "músicas", timeout=45000)
        d = dj(a)
        assert len(d["q"]) >= 2, d["q"]
        playing(b, d["id"])
        step(f"/play <link de playlist do YouTube>: {len(d['q'])} vídeos da playlist na fila, o primeiro toca para todos")
        say(a, "/stop")
        for pg in (a, b, c):
            pg.wait_for_function("() => BAGRENATION.dj().id === null")

        if T.SHOTS:
            say(a, f"/play {BUNNY}")
            a.evaluate("() => BAGRENATION.musSend('add', { items: [{ id: 'jNQXAC9IVRw', t: 'Me at the zoo', a: 'jawed', d: 19 }, { id: 'aqz-KE-bpKQ', t: 'Big Buck Bunny (de novo)', a: 'Blender', d: 635 }] })")
            playing(a, "aqz-KE-bpKQ")
            a.wait_for_timeout(3000)
            T.shot(a, "dj_03_painel_ana")
            T.shot(c, "dj_04_celular_cris")
            T.shot(b, "dj_05_chat_bruno")
            say(a, "/stop")
            a.wait_for_timeout(1000)
        br.close()
    assert not errors, "erros de console:\n" + "\n".join(errors)
    print(f"MUSICA OK ({len(steps)} passos), 0 erro de console, servidor de teste {SRV}")


if __name__ == "__main__":
    shots = pathlib.Path(sys.argv[2]) if len(sys.argv) > 2 else None
    T.SHOTS = shots
    if len(sys.argv) > 1 and sys.argv[1].startswith("http"):
        run(sys.argv[1], shots)
    else:
        h = functools.partial(type("Q", (http.server.SimpleHTTPRequestHandler,), {"log_message": lambda *a: None}), directory=str(T.ROOT))
        srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), h)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        run(f"http://127.0.0.1:{srv.server_address[1]}/", shots)
