"""S-0059 (BAGRENATION 1.8.2): chat sem mensagens do Bagre DJ, link clicável, tempo de chamada como no Discord. 3 navegadores.

Ana e Bruno (1366x768) e Cris (celular 390x844), servidor de teste (?servidor=teste-s59-...), navegadores com --mute-audio.
Confere:
  1. tempo de chamada: começa quando a 1ª pessoa entra, aparece no canal da lista e no topo da call, é o mesmo nos 3,
     quem entra depois vê o tempo certo (não 00:00), zera quando o canal esvazia;
  2. !p e /play no chat tocam nos 3, mas nada do DJ aparece no chat (nem o comando, nem 'Tocando agora', nem 'saiu');
     o retorno aparece no painel de música (#djFeed); !q abre a fila no painel; !dc tira o DJ sem mensagem;
  3. link do X/Twitter, YouTube e Instagram vira <a> (nova aba, rel=noopener), o clique abre a aba com o endereço certo,
     ponto final fora do link e prévia pequena do YouTube.
Uso:  python tests/test_s0059.py [url_base] [pasta_prints]
"""
import functools
import http.server
import pathlib
import re
import secrets
import sys
import tempfile
import threading
import time

from playwright.sync_api import expect, sync_playwright

sys.path.insert(0, str(pathlib.Path(__file__).parent))
import test_e2e as T  # noqa: E402
import test_musica as M  # noqa: E402

SRV = f"teste-s59-{secrets.token_hex(3)}"
M.SRV = SRV
LINKS = ["https://x.com/NASA/status/1858930170416726393", "https://www.youtube.com/watch?v=aqz-KE-bpKQ", "https://www.instagram.com/p/C1a2b3c4d5e/"]
TABLE = []


def ok(what, seen):
    TABLE.append((what, seen))
    M.step(f"{what}: {seen}")


def secs(txt):
    parts = [int(x) for x in txt.strip().split(":")]
    s = 0
    for x in parts:
        s = s * 60 + x
    return s


def call_time(pg):
    """(tempo no topo da call, tempo no canal 'voz' da lista) em segundos; None = não aparece"""
    v = pg.evaluate("""() => {
      const top = document.getElementById('callTime');
      const ch = document.querySelector('.chan[data-ch="voz"] .chan-time');
      return [top && !top.hidden ? top.textContent : null, ch && !ch.hidden ? ch.textContent : null];
    }""")
    return [secs(x) if x else None for x in v]


def no_dj_in_chat(pg, label):
    n = pg.evaluate("() => [...document.querySelectorAll('#chatLog .msg')].filter((li) => li.classList.contains('is-bot') || li.classList.contains('ephem') || /Bagre DJ/.test(li.querySelector('.msg-name')?.textContent || '') || /^[!/](p|play|q|dc)\\b/.test(li.querySelector('.msg-text')?.textContent || '')).length")
    assert n == 0, f"{label}: {n} mensagem(ns) do DJ/comando no chat"


def to_chat(pg):
    if not pg.locator("#chatInput").is_visible():
        if not pg.locator("#chanChat").is_visible():
            pg.click("#panelBtn")
        pg.click("#chanChat")
    expect(pg.locator("#chatInput")).to_be_visible()


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
        A = (a, b, c)

        # 1. tempo de chamada
        assert call_time(b) == [None, None], call_time(b)
        T.join_voice(a)
        a.wait_for_function("() => !document.getElementById('callTime').hidden", timeout=10000)
        t_a = call_time(a)
        assert t_a[0] is not None and t_a[0] <= 3 and t_a[1] is not None, t_a
        b.wait_for_function("() => { const e = document.querySelector('.chan[data-ch=\"voz\"] .chan-time'); return e && !e.hidden; }", timeout=10000)
        ok("1ª pessoa entra", f"Ana entrou: topo da call {t_a[0]} s, canal da lista {t_a[1]} s; Bruno (fora da call) já vê o tempo no canal da lista")
        a.wait_for_timeout(6000)
        T.join_voice(b)
        T.join_voice(c)
        b.wait_for_function("() => !document.getElementById('callTime').hidden", timeout=10000)
        tb, ta, tc = call_time(b), call_time(a), call_time(c)
        assert tb[0] >= 6, f"Bruno entrou depois e viu {tb} (devia ver o tempo desde a Ana)"
        assert max(ta[0], tb[0], tc[0]) - min(ta[0], tb[0], tc[0]) <= 1, (ta, tb, tc)
        ok("quem entra depois", f"Bruno e Cris entraram 6 s depois e veem {tb[0]} s / {tc[0]} s (Ana {ta[0]} s): o mesmo tempo nos 3")
        T.voice_ready(a, 2)
        if shots:
            T.shot(a, "s59_01_tempo_call_ana")
            T.shot(c, "s59_02_tempo_call_cris_390")

        # 2. Bagre DJ sem chat
        to_chat(a)
        to_chat(b)
        n0 = [pg.locator("#chatLog .msg").count() for pg in A]
        M.say(a, f"!p {M.BUNNY}")
        for pg in A:
            M.playing(pg, "aqz-KE-bpKQ")
        expect(a.locator("#chatInput")).to_have_value("")
        b.wait_for_function("() => [...document.querySelectorAll('#djFeed .dj-ft')].some((e) => /Tocando agora/.test(e.textContent))", timeout=10000)
        a.wait_for_timeout(1500)
        for pg, n in zip(A, n0):
            assert pg.locator("#chatLog .msg").count() == n, "o !p ou o Tocando agora entrou no chat"
            no_dj_in_chat(pg, "!p")
        ok("!p <link> no chat", "toca nos 3; o comando não vira mensagem; 'Tocando agora' só no painel de música (#djFeed); 0 mensagem nova no chat dos 3")
        M.say(b, f"/play {M.ZOO}")
        for pg in A:
            pg.wait_for_function("() => BAGRENATION.dj().q.length === 2", timeout=20000)
        b.wait_for_function("() => [...document.querySelectorAll('#djFeed .dj-ft')].some((e) => /Na fila/.test(e.textContent))", timeout=10000)
        for pg, n in zip(A, n0):
            assert pg.locator("#chatLog .msg").count() == n
        ok("/play <link>", "entrou na fila nos 3; 'Na fila (#1)' no painel de música; nada no chat")
        M.say(a, "!q")
        expect(a.locator("#dj")).to_be_visible(timeout=5000)
        expect(a.locator("#djFeed .djc")).to_be_visible(timeout=5000)
        expect(a.locator("#djFeed")).to_contain_text("Me at the zoo")
        assert a.locator("#chatLog .djc").count() == 0
        ok("!q", "a fila abre no painel de música (cartão no #djFeed), não no chat")
        if shots:
            T.shot(a, "s59_03_painel_musica_fila_ana")
        to_chat(c)
        M.say(c, "!np")
        c.wait_for_function("() => !!document.querySelector('#djFeed .djc-np')", timeout=8000)
        if shots:
            T.shot(c, "s59_04_np_no_painel_cris_390")
        M.say(b, "!dc")
        for pg in A:
            pg.wait_for_function("() => BAGRENATION.dj().q.length === 0", timeout=20000)
        a.wait_for_timeout(1500)
        for pg, n in zip(A, n0):
            assert pg.locator("#chatLog .msg").count() == n
            no_dj_in_chat(pg, "!dc")
        ok("!np e !dc", "!np mostra o cartão no painel do Cris; !dc tira o DJ e limpa a fila nos 3 sem nenhuma mensagem no chat")

        # 3. links
        for pg in A:
            to_chat(pg)
        M.say(a, f"olha {LINKS[0]} e {LINKS[1]}. tambem {LINKS[2]}.")
        msg = b.locator("#chatLog .msg").last
        expect(msg.locator("a.msg-link")).to_have_count(3, timeout=10000)
        got = msg.locator("a.msg-link").evaluate_all("els => els.map((e) => [e.getAttribute('href'), e.target, e.rel])")
        assert [g[0] for g in got] == LINKS, got
        assert all(g[1] == "_blank" and "noopener" in g[2] for g in got), got
        expect(msg.locator("a.msg-prev img")).to_have_count(1)
        opened = []
        for i, link in enumerate(LINKS):
            with b.context.expect_page(timeout=15000) as pinfo:
                msg.locator("a.msg-link").nth(i).click()
            np_ = pinfo.value
            opened.append(np_.url if np_.url != "about:blank" else np_.evaluate("() => location.href"))
            np_.close()
        for want, got_url in zip(LINKS, opened):
            host = re.sub(r"^https?://(www\.)?", "", want).split("/")[0]
            assert host in got_url or got_url.startswith(want), (want, got_url)
        ok("links X, YouTube, Instagram", f"viram <a> com target=_blank e rel=noopener; o clique abriu aba nova em {', '.join(re.sub(r'^https?://', '', u)[:30] for u in opened)}; o ponto final ficou fora; prévia do YouTube")
        if shots:
            T.shot(b, "s59_05_links_bruno")
            T.shot(c, "s59_06_links_cris_390")

        # 4. canal esvazia: zera
        for pg in A:
            pg.evaluate("() => document.querySelector('#leaveBtn') && document.querySelector('#leaveBtn').click()")
        a.wait_for_timeout(1000)
        for pg in A:
            pg.evaluate("() => { const x = document.querySelector('#vconnLeave'); if (x) x.click(); }")
        b.wait_for_function("() => { const e = document.querySelector('.chan[data-ch=\"voz\"] .chan-time'); return !e || e.hidden; }", timeout=30000)
        ok("canal esvazia", "todos saíram: o tempo some da lista nos 3")
        a.wait_for_timeout(22000)  # passa a folga de 20 s (quem cai e volta logo não zera)
        T.join_voice(c)
        c.wait_for_function("() => !document.getElementById('callTime').hidden", timeout=10000)
        tz = call_time(c)
        assert tz[0] <= 3, tz
        ok("volta depois de vazio", f"Cris entrou de novo 22 s depois: o tempo recomeçou em {tz[0]} s")
        br.close()
    errs = [e for e in M.errors if "favicon" not in e]
    assert not errs, "erros de console:\n" + "\n".join(errs)
    print(f"S0059 OK ({len(M.steps)} passos), 0 erro de console, servidor de teste {SRV}")
    for what, seen in TABLE:
        print(f"TABELA | {what} | {seen}")


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
