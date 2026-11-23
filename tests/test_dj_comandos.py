"""S-0033/S-0037: Bagre DJ com os comandos dos bots de música do Discord (Rythm, Groovy, FredBoat), 3 navegadores.

Ana e Bruno (1366x768) e Cris (celular 390x844) no mesmo canal de voz, servidor de teste (?servidor=teste-djc-...),
navegadores com --mute-audio (sem som). Cada passo confere nos 3 o que o comando muda.
Uso:  python tests/test_dj_comandos.py [url_base] [pasta_prints]
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
import test_musica as M  # noqa: E402

SRV = f"teste-djc-{secrets.token_hex(3)}"
M.SRV = SRV
BUNNY = M.BUNNY
ZOO = M.ZOO
PLAYLIST = M.PLAYLIST
TABLE = []  # (comando, o que se viu) para a tabela do done


def ok(cmd, seen):
    TABLE.append((cmd, seen))
    M.step(f"{cmd}: {seen}")


def say(pg, text):
    M.say(pg, text)


def ephem(pg):
    return pg.locator("#chatLog .msg.ephem").last


def dj(pg):
    return M.dj(pg)


def up(pg):
    d = dj(pg)
    return d["q"][d["i"] + 1:]


def same_q(pages):
    qs = [(dj(p)["q"], dj(p)["i"]) for p in pages]
    assert all(q == qs[0] for q in qs), qs
    return qs[0]


def wait_all(pages, js, arg=None, timeout=20000):
    for p in pages:
        p.wait_for_function(js, arg=arg, timeout=timeout)


def settle(pages, quiet=4.0, limit=90):
    """espera a fila parar de crescer (playlist entra aos poucos) e ficar igual nos 3"""
    t0, last, since = time.time(), None, time.time()
    while time.time() - t0 < limit:
        qs = [len(dj(p)["q"]) for p in pages]
        if qs != last:
            last, since = qs, time.time()
        elif len(set(qs)) == 1 and time.time() - since > quiet:
            return qs[0]
        time.sleep(0.5)
    raise AssertionError(f"fila não assentou: {last}")


def run(base, shots):
    url = f"{base}?servidor={SRV}"
    with sync_playwright() as p:
        tmp = T.launch(p)
        tmp.close()
        wav = pathlib.Path(tempfile.gettempdir()) / "bagrenation_mic_falso.wav"
        br = p.chromium.launch(args=["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", f"--use-file-for-fake-audio-capture={wav}", "--mute-audio"])
        a = M.enter(br, url, "Ana")
        b = M.enter(br, url, "Bruno")
        c = M.enter(br, url, "Cris", viewport={"width": 390, "height": 844})
        for pg in (a, b, c):
            T.join_voice(pg)
        T.voice_ready(a, 2)
        c.click("#chanBtn")  # celular: Cris fica no #chat (um canal por vez), a música segue tocando
        c.click("#chanChat")
        A = (a, b, c)

        # sugestões ao digitar ! (como a lista de comandos do Discord)
        a.fill("#chatInput", "!s")
        a.dispatch_event("#chatInput", "input")
        expect(a.locator("#djSug")).to_be_visible()
        expect(a.locator("#djSug")).to_contain_text("!skip")
        a.fill("#chatInput", "")
        a.dispatch_event("#chatInput", "input")
        ok("sugestões (! no chat)", "digitar !s abre a lista com !skip, !shuffle, !seek...")

        # !p <link> -> cartão Tocando agora nos 3
        say(a, f"!p {BUNNY}")
        for pg in A:
            expect(pg.locator("#chatLog .djc-np.is-live")).to_contain_text("Big Buck Bunny", timeout=20000)
            M.playing(pg, "aqz-KE-bpKQ")
        expect(b.locator("#chatLog .djc-np.is-live .djc-kick")).to_contain_text("Tocando agora")
        expect(b.locator("#chatLog .djc-np.is-live .djc-sub")).to_contain_text("pedido por Ana")
        expect(b.locator("#people li.is-bot")).to_contain_text("Bagre DJ")
        b.wait_for_timeout(2500)
        g, _ = M.synced(A, label="!p")
        w = b.evaluate("() => parseFloat(document.querySelector('#chatLog .djc-np.is-live .djc-track i').style.width)")
        assert w > 0, w
        ok("!p / !play <link>", f"cartão Tocando agora (capa, quem pediu, barra {w:.1f}%) nos 3; tocam juntos (diferença {g:.2f} s); DJ no canal")
        T.shot(b, "djc_01_tocando_bruno") if T.SHOTS else None
        T.shot(c, "djc_02_tocando_cris_390") if T.SHOTS else None

        # !p 2ª -> cartão Na fila #1
        say(b, f"/play {ZOO}")
        for pg in A:
            expect(pg.locator("#chatLog .djc-add").last).to_contain_text("Na fila · #1", timeout=20000)
        expect(a.locator("#chatLog .djc-add").last).to_contain_text("Me at the zoo")
        ok("/play com música tocando", "cartão Na fila · #1 com capa, duração e quando toca, nos 3 (o / funciona igual ao !)")

        # !p <playlist do YouTube> + completa até 14 na fila
        say(a, f"!p {PLAYLIST}")
        a.wait_for_function("() => BAGRENATION.dj().q.length > 3", timeout=45000)
        n_pl = len(dj(a)["q"]) - 2
        items = [{"id": "aqz-KE-bpKQ", "t": f"Faixa {n:02d}", "a": "teste", "d": 600} for n in range(1, 15)]
        a.evaluate("it => BAGRENATION.musSend('add', { items: it })", items)
        a.wait_for_function("() => BAGRENATION.dj().q.length >= 16", timeout=15000)
        settle(A)
        same_q(A)
        nup = len(up(a))
        say(a, "!q")
        expect(ephem(a).locator(".djc-q")).to_be_visible()
        expect(ephem(a).locator(".djc-pg")).to_have_text(f"página 1 de {(nup + 9) // 10}")
        expect(ephem(a).locator(".djc-ol li")).to_have_count(10)
        ephem(a).locator(".djc-nav button[aria-label='Próxima página']").click()
        expect(ephem(a).locator(".djc-pg")).to_have_text(f"página 2 de {(nup + 9) // 10}")
        expect(ephem(a).locator(".djc-ol li").first.locator("b")).to_have_text("11")
        expect(b.locator("#chatLog .msg.ephem")).to_have_count(0)
        say(a, "!queue 2")
        expect(ephem(a).locator(".djc-pg")).to_contain_text("página 2")
        ok("!q / !queue [página]", f"playlist do YouTube ({n_pl} vídeos) + fila de {nup}: páginas de 10 com ◀ ▶ (página 2 começa no 11); só quem pediu vê")
        T.shot(a, "djc_03_fila_ana") if T.SHOTS else None

        # !move 5 1
        u = up(a)
        say(a, "!move 5 1")
        wait_all(A, "t => { const d = BAGRENATION.dj(); return d.q[d.i + 1] === t; }", u[4])
        same_q(A)
        ok("!m / !move <de> [para]", f"!move 5 1: “{u[4]}” virou a próxima nos 3")

        # !remove 2 e 2-3
        n0 = len(up(a))
        say(b, "!rm 2")
        wait_all(A, "n => { const d = BAGRENATION.dj(); return d.q.length - d.i - 1 === n; }", n0 - 1)
        say(b, "!remove 2-3")
        wait_all(A, "n => { const d = BAGRENATION.dj(); return d.q.length - d.i - 1 === n; }", n0 - 3)
        same_q(A)
        ok("!rm / !remove <nº> e <nº-nº>", f"fila {n0} -> {n0 - 1} -> {n0 - 3} nos 3")

        # !playtop e !removedupes e !shuffle
        say(c, f"!pt {ZOO}")
        wait_all(A, "() => { const d = BAGRENATION.dj(); return /zoo/i.test(d.q[d.i + 1] || ''); }")
        ok("!pt / !playtop", "Me at the zoo entrou como a próxima nos 3")
        a.evaluate("() => BAGRENATION.musSend('add', { items: [{ id: 'jNQXAC9IVRw', t: 'Me at the zoo', a: 'jawed', d: 19 }] })")
        a.wait_for_function("() => { const d = BAGRENATION.dj(); return d.q.slice(d.i + 1).filter((t) => /zoo/i.test(t)).length === 2; }")
        zoo_n = sum(1 for t in up(a) if "zoo" in t.lower())
        n_dup = len(up(a))
        say(c, "!removedupes")
        expect(a.locator("#chatLog .msg.is-bot").last).to_contain_text("repetid", timeout=15000)
        wait_all(A, "() => { const d = BAGRENATION.dj(); return d.q.slice(d.i + 1).filter((t) => /zoo/i.test(t)).length === 1; }")
        settle(A, quiet=2)
        ok("!removedupes / !rd", f"{zoo_n} cópias de Me at the zoo viraram 1 e as faixas com o mesmo vídeo do Big Buck Bunny saíram (fila {n_dup} -> {len(up(a))}) nos 3")
        before = sorted(up(a))
        say(b, "!shuffle")
        expect(a.locator("#chatLog .msg.is-bot").last).to_contain_text("embaralhou", timeout=15000)
        b.wait_for_timeout(800)
        assert sorted(up(c)) == before, (up(c), before)
        same_q(A)
        ok("!shuffle", "mesmas músicas em outra ordem, igual nos 3")

        # !skipto 2
        u = up(a)
        say(a, "!st 2")
        wait_all(A, "t => BAGRENATION.dj().title === t", u[1])
        ok("!st / !skipto <nº>", f"foi direto para a 2ª da fila (“{u[1]}”) nos 3")

        # garante música longa tocando para seek
        a.evaluate("() => BAGRENATION.musSend('add', { items: [{ id: 'aqz-KE-bpKQ', t: 'Big Buck Bunny (seek)', a: 'Blender', d: 635 }], now: true })")
        wait_all(A, "() => BAGRENATION.dj().title === 'Big Buck Bunny (seek)'")
        for pg in (a, b):
            M.playing(pg, "aqz-KE-bpKQ")
        say(a, "!seek 1:30")
        wait_all(A, "() => { const t = BAGRENATION.dj().target; return t > 89 && t < 96; }")
        say(b, "!fwd 30")
        wait_all(A, "() => { const t = BAGRENATION.dj().target; return t > 119 && t < 127; }")
        say(c, "!rwd 10")
        wait_all(A, "() => { const t = BAGRENATION.dj().target; return t > 109 && t < 117; }")
        say(a, "!seek 2m45s")
        wait_all(A, "() => { const t = BAGRENATION.dj().target; return t > 164 && t < 171; }")
        a.wait_for_timeout(2500)
        g, ps = M.synced((a, b), label="seek")
        ok("!seek <tempo> / !fwd / !rwd", f"1:30 -> +30 -> -10 -> 2m45s: a posição mudou nos 3 (players em {ps[0]:.0f} s, diferença {g:.2f} s)")

        # botão ⏯ do cartão (Bruno) pausa para os 3; /resume da Cris (que está no #chat, ainda no canal de voz)
        b.locator("#chatLog .djc-np.is-live .djc-play").click()
        wait_all(A, "() => BAGRENATION.dj().paused === true")
        expect(a.locator("#chatLog .djc-np.is-live")).to_have_class(__import__("re").compile("is-paused"))
        say(c, "/resume")
        wait_all(A, "() => BAGRENATION.dj().paused === false")
        say(a, "!pause")
        wait_all(A, "() => BAGRENATION.dj().paused === true")
        say(a, "!pause")
        wait_all(A, "() => BAGRENATION.dj().paused === false")
        ok("botões do cartão + !pause / !resume", "⏯ do Bruno pausou os 3; /resume da Cris voltou; !pause de novo alterna")
        b.locator("#chatLog .djc-np.is-live button[aria-label='Pular']").click()
        wait_all(A, "() => BAGRENATION.dj().title !== 'Big Buck Bunny (seek)'")
        ok("botão ⏭ do cartão", "pulou para a próxima nos 3")

        # !loop, !lq, !loop off
        say(a, "!loop")
        wait_all(A, "() => BAGRENATION.dj().loop === 'one'")
        say(b, "!lq")
        wait_all(A, "() => BAGRENATION.dj().loop === 'all'")
        say(c, "!loop off")
        wait_all(A, "() => BAGRENATION.dj().loop === 'off'")
        ok("!loop / !lq / !loop off", "repetir esta -> repetir a fila -> desligado nos 3")

        # !np (só quem pede), !vol (só da Ana)
        say(b, "!np")
        expect(ephem(b).locator(".djc-np")).to_be_visible()
        expect(a.locator("#chatLog .msg.ephem .djc-np")).to_have_count(0)
        ok("!np / !nowplaying", "cartão com barra e botões, só para quem pediu")
        say(a, "!vol 30")
        a.wait_for_function("() => BAGRENATION.dj().vol === 30")
        assert dj(b)["vol"] != 30, dj(b)
        expect(ephem(a)).to_contain_text("30%")
        ok("!vol / !volume <0-100>", f"Ana em 30%, Bruno continua em {dj(b)['vol']}% (cada um o seu)")

        # !clear
        cur = dj(a)["title"]
        say(b, "!clear")
        wait_all(A, "() => { const d = BAGRENATION.dj(); return d.q.length - d.i - 1 === 0; }")
        assert dj(a)["title"] == cur
        ok("!clear", f"fila vazia nos 3; “{cur}” continua tocando")

        # !lyrics
        say(a, "!lyrics bohemian rhapsody")
        expect(ephem(a).locator(".djc-ly .djc-lyr")).to_contain_text("Mama", timeout=30000)
        expect(ephem(a).locator(".djc-src")).to_contain_text("LRCLIB")
        T.shot(a, "djc_04_letra_ana") if T.SHOTS else None
        a.evaluate("() => BAGRENATION.musSend('add', { items: [{ id: 'aqz-KE-bpKQ', t: 'Big Buck Bunny', a: 'Blender Foundation', d: 635 }], now: true })")
        wait_all(A, "() => BAGRENATION.dj().title === 'Big Buck Bunny'")
        a.wait_for_timeout(1700)
        say(a, "!ly")
        expect(ephem(a)).to_contain_text("Não achei a letra", timeout=30000)
        ok("!lyrics / !ly [nome]", "letra de Bohemian Rhapsody (LRCLIB, grátis); Big Buck Bunny tocando: diz que não achou")

        # !oi vira mensagem normal; !help
        say(c, "!oi gente")
        expect(a.locator("#chatLog .msg:not(.ephem)").last).to_contain_text("!oi gente")
        say(c, "!help")
        expect(ephem(c).locator(".djc-help")).to_contain_text("!play")
        ok("!help / texto com ! que não é comando", "!help mostra a lista só para quem pediu; !oi gente vai como mensagem normal")
        T.shot(c, "djc_05_ajuda_cris_390") if T.SHOTS else None

        # !autoplay: fila acaba -> entra uma do mesmo artista
        say(a, "!autoplay on")
        wait_all(A, "() => BAGRENATION.dj().auto === true")
        say(a, "!pn numb linkin park")
        a.wait_for_function("() => /numb/i.test(BAGRENATION.dj().title || '')", timeout=30000)
        say(a, "!clear")
        a.wait_for_function("() => { const d = BAGRENATION.dj(); return d.q.length - d.i - 1 === 0; }")
        b.wait_for_function("() => BAGRENATION.dj().st === 1", timeout=30000)
        say(a, "!seek 3:04")
        a.wait_for_function("() => !/numb/i.test(BAGRENATION.dj().title || '') && BAGRENATION.dj().id", timeout=60000)
        auto_t = dj(a)["title"]
        expect(b.locator("#chatLog .msg.is-bot").last).to_be_visible()
        say(a, "!ap off")
        wait_all(A, "() => BAGRENATION.dj().auto === false")
        ok("!autoplay / !ap [on|off]", f"fila acabou depois de Numb: entrou “{auto_t}” sozinha; !ap off desliga nos 3")

        # !dc tira o DJ; !join põe o DJ esperando
        say(b, "!dc")
        wait_all(A, "() => BAGRENATION.dj().id === null")
        expect(a.locator("#people li.is-bot")).to_have_count(0)
        say(b, "!join")
        expect(a.locator("#chatLog .msg.is-bot").last).to_contain_text("Entrei em", timeout=15000)
        expect(a.locator("#people li.is-bot")).to_have_count(1, timeout=15000)
        ok("!dc / !leave e !join / !summon", "!dc parou, limpou e tirou o DJ do canal nos 3; !join pôs o DJ no canal esperando pedido")

        # todos saem da voz com música tocando -> o DJ sai sozinho (servidor de teste: 45 s; de verdade: 3 min)
        say(a, f"!p {BUNNY}")
        a.wait_for_function("() => BAGRENATION.dj().id === 'aqz-KE-bpKQ'", timeout=20000)
        t0 = time.time()
        for pg in A:
            pg.evaluate("() => document.querySelector('#leaveBtn') && document.querySelector('#leaveBtn').click()")
        a.wait_for_timeout(1500)
        for pg in A:
            if pg.locator("#vconn").count():
                pg.evaluate("() => { const x = document.querySelector('#vconnLeave'); if (x) x.click(); }")
        expect(a.locator("#chatLog .msg.is-bot").last).to_contain_text("Saí de", timeout=120000)
        took = time.time() - t0
        ok("sair sozinho do canal vazio", f"todos saíram da voz: em {took:.0f} s o DJ disse “Saí de 🔊 ...” e limpou a fila (servidor de teste 45 s; o de verdade espera 3 min)")
        br.close()
    assert not M.errors, "erros de console:\n" + "\n".join(M.errors)
    print(f"DJ COMANDOS OK ({len(M.steps)} passos), 0 erro de console, servidor de teste {SRV}")
    for cmd, seen in TABLE:
        print(f"TABELA | {cmd} | {seen}")


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
