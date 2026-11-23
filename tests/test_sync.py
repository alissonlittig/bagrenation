"""S-1378: tudo que um muda aparece para TODOS na hora, sem recarregar (meta < 2 s), com o tempo medido.

3 clientes no site (Ana e Bruno em 1366, Caio no celular 390x844) e, se passar o exe, o app para PC num desktop oculto.
Cada ação é feita por um e conferida em todos os outros: criar, renomear e apagar canal de texto e de voz (quem não
criou também mexe), renomear o #chat fixo, mensagem, editar, reação, apagar mensagem, nome, avatar e status.
Usa um servidor de teste (?servidor=teste-...). Imprime a tabela ação x sincroniza x tempo (pior cliente).
Uso:  python tests/test_sync.py [url_base] [pasta_prints] [exe_do_app_de_teste]
"""
import pathlib
import re
import secrets
import sys
import time

from playwright.sync_api import expect, sync_playwright

sys.path.insert(0, str(pathlib.Path(__file__).parent))
import test_e2e as T  # noqa: E402
from test_canais import chan, create  # noqa: E402
from test_membros import enter, hover_tools, member, msg, say  # noqa: E402

SRV = f"teste-sync-{secrets.token_hex(3)}"
LIMIT = 2.0
rows = []


def timed(label, act, checks):
    """Faz `act` e espera cada `checks` (um por cliente); tempo = do clique até o último cliente mostrar."""
    t0 = time.perf_counter()
    act()
    worst = 0.0
    for who, fn in checks:
        fn()
        worst = max(worst, time.perf_counter() - t0)
    rows.append((label, ", ".join(w for w, _ in checks), worst))
    print(f"ok: {label}: {worst:.2f} s", flush=True)
    assert worst < LIMIT, f"{label} levou {worst:.2f} s (meta < {LIMIT} s)"


def gear(pg, name):
    if not pg.locator("#panel").is_visible():
        pg.click("#chanBtn")
    row = pg.locator(".chan-row", has=pg.locator(".chan-name", has_text=re.compile(rf"^{re.escape(name)}$")))
    row.hover()
    row.locator(".chan-gear").click(force=True)
    expect(pg.locator("#chanDlg")).to_be_visible()


def open_app(p, exe, url):
    import test_eco as E
    from test_app import PORT, wait
    pid, _ = E.start_hidden(exe)
    for _ in range(80):
        try:
            cdp = p.chromium.connect_over_cdp(f"http://127.0.0.1:{PORT}")
            break
        except Exception:
            time.sleep(0.5)
    d = cdp.contexts[0].pages[0]
    wait(d, "!!window.__TAURI__ && document.readyState === 'complete'", 30000)
    d.evaluate(f"location.search = '?servidor={SRV}'")
    wait(d, "document.readyState === 'complete' && location.search.includes('servidor')", 20000)
    if d.locator("#nameDlg").is_visible():
        d.fill("#homeName", "Dani")
        d.click("#nameForm [type=submit]")
    T.connected(d)
    return d, pid


def run(base, shots, exe=None):
    T.SHOTS = shots
    url = f"{base}?servidor={SRV}"
    pid = None
    with sync_playwright() as p:
        br = T.launch(p)
        a = enter(br, url, "Ana")
        b = enter(br, url, "Bruno")
        c = enter(br, url, "Caio", viewport={"width": 390, "height": 844})
        pages = {"Ana": a, "Bruno": b, "Caio": c}
        if exe:
            d, pid = open_app(p, exe, url)
            pages["App"] = d
        n = len(pages)
        for pg in pages.values():
            expect(pg.locator("#online li")).to_have_count(n, timeout=20000)
        others = lambda me: [(k, v) for k, v in pages.items() if v is not me]
        everyone = lambda: list(pages.items())

        def seen(fn, pgs):
            return [(k, (lambda pg=pg: fn(pg))) for k, pg in pgs]

        # mensagens (#chat)
        timed("mensagem nova", lambda: say(a, "sync um"), seen(lambda pg: expect(msg(pg, "sync um")).to_have_count(1, timeout=5000), others(a)))

        def edit():
            hover_tools(a, "sync um").locator("[data-act=edit]").click()
            box = a.locator(".msg.editing .msg-edit input")
            box.fill("sync um editada")
            box.press("Enter")
        timed("editar mensagem", edit, seen(lambda pg: expect(msg(pg, "sync um editada").locator(".msg-edited")).to_have_count(1, timeout=5000), others(a)))

        def react():
            hover_tools(b, "sync um editada").locator("[data-act=react]").click()
            b.locator("#reactPop .emo-btn", has_text="🔥").click()
        timed("reação", react, seen(lambda pg: expect(msg(pg, "sync um editada").locator(".react", has_text="🔥")).to_have_count(1, timeout=5000), others(b)))

        def delete():
            hover_tools(a, "sync um editada").locator("[data-act=del]").click()
            a.click("#delOk")
        timed("apagar mensagem", delete, seen(lambda pg: expect(msg(pg, "sync um editada")).to_have_count(0, timeout=5000), others(a)))

        # pessoas: nome, avatar, status (Bruno muda; os outros veem na lista de membros)
        def rename_me():
            b.fill("#nameInput", "Bruninho")
            b.press("#nameInput", "Enter")
        timed("trocar nome", rename_me, seen(lambda pg: expect(member(pg, "online", "Bruninho")).to_have_count(1, timeout=5000), others(b)))
        before = member(a, "online", "Bruninho").locator(".avatar").get_attribute("data-av")

        def avatar():
            b.click("#meAvatar")
            expect(b.locator("#avatarDlg")).to_be_visible()
            b.locator("#avatarGrid button:not([aria-pressed=true])").last.click()
            expect(b.locator("#avatarDlg")).to_be_hidden()
        timed("trocar avatar", avatar, seen(lambda pg: expect(member(pg, "online", "Bruninho").locator(".avatar")).not_to_have_attribute("data-av", before or "-", timeout=5000), others(b)))

        def status():
            b.click("#statusBtn")
            b.click("#statusPop [data-st=idle]")
        timed("status ausente", status, seen(lambda pg: expect(member(pg, "idle", "Bruninho")).to_have_count(1, timeout=5000), others(b)))
        b.click("#statusBtn")
        b.click("#statusPop [data-st=auto]")
        for _, pg in others(b):
            expect(member(pg, "online", "Bruninho")).to_have_count(1, timeout=10000)

        # canais: Ana cria; Bruno (não criou) renomeia e apaga; Caio (celular) renomeia o #chat fixo
        has = lambda name, k=1: (lambda pg: expect(chan(pg, name)).to_have_count(k, timeout=5000))
        timed("criar canal de texto", lambda: create(a, "text", "sync texto"), seen(has("sync-texto"), others(a)))
        a.wait_for_timeout(900)  # o servidor aceita um comando de canal a cada 0,8 s por conexão
        timed("criar canal de voz", lambda: create(a, "voice", "Sala Sync"), seen(has("Sala Sync"), others(a)))
        T.shot(c, "80_sync_celular_canais")

        def ren(pg, old, new):
            def go():
                gear(pg, old)
                pg.fill("#chanName", new)
                pg.click("#chanOk")
            return go
        timed("renomear canal de texto (outro)", ren(b, "sync-texto", "sync renomeado"), seen(has("sync-renomeado"), everyone()))
        b.wait_for_timeout(900)
        timed("renomear canal de voz (outro)", ren(b, "Sala Sync", "Sala Nova"), seen(has("Sala Nova"), everyone()))
        timed("renomear #chat fixo (celular)", ren(c, "chat", "geral"), seen(has("geral"), everyone()))
        c.wait_for_timeout(900)
        ren(c, "geral", "chat")()
        for _, pg in everyone():
            has("chat")(pg)
        T.shot(a, "81_sync_renomeados")

        def kill(pg, name):
            def go():
                gear(pg, name)
                pg.click("#chanDel")
                expect(pg.locator("#chanDel")).to_have_text(re.compile("Confirmar"))
                pg.click("#chanDel")
            return go
        b.wait_for_timeout(900)
        timed("apagar canal de texto (outro)", kill(b, "sync-renomeado"), seen(has("sync-renomeado", 0), everyone()))
        b.wait_for_timeout(900)
        timed("apagar canal de voz (outro)", kill(b, "Sala Nova"), seen(has("Sala Nova", 0), everyone()))
        gear(c, "chat")
        expect(c.locator("#chanDel")).to_be_hidden()  # o #chat principal só renomeia
        c.keyboard.press("Escape")
        T.shot(b, "82_sync_fim")
        for pg in pages.values():
            expect(pg.locator("body")).not_to_contain_text(re.compile("modera", re.I))
        assert not T.errors, "erros de console: " + " | ".join(T.errors)
        br.close()
    if pid:
        import psutil
        for ch in psutil.Process(pid).children(recursive=True):
            ch.kill()
        psutil.Process(pid).kill()
    print("\n| ação | conferido em | sincroniza? | tempo (pior cliente) |\n|---|---|---|---|")
    for label, who, dt in rows:
        print(f"| {label} | {who} | sim | {dt:.2f} s |")
    print(f"SYNC OK {len(rows)} ações, todas < {LIMIT:.0f} s, 0 erro de console, {n} clientes")


if __name__ == "__main__":
    base = sys.argv[1] if len(sys.argv) > 1 and sys.argv[1].startswith("http") else None
    shots = pathlib.Path(sys.argv[2]) if len(sys.argv) > 2 else None
    exe = sys.argv[3] if len(sys.argv) > 3 else None
    if base:
        run(base, shots, exe)
    else:
        import functools
        import http.server
        import threading
        root = pathlib.Path(__file__).resolve().parent.parent
        httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(root)))
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        run(f"http://127.0.0.1:{httpd.server_port}/index.html", shots, exe)
