"""S-1382: sinalização WebRTC pelo Worker (sem 0.peerjs.com), 3 clientes: Ana e Bruno no PC, Caio no celular.

Prova: com o PeerJS bloqueado na rede dos 3 navegadores (e contado: 0 pedidos), todos se veem na malha, entram na voz
(áudio chega nos 2 outros), Ana transmite a tela e Bruno e Caio recebem vídeo e som; Caio sai da voz e volta;
os únicos WebSockets abertos são do Worker do BAGRENATION. Com ?ice=relay (só com TURN ligado) repete forçando o relay.
Uso:  python tests/test_sinal.py [url_base] [pasta_prints] [--relay]
"""
import functools
import http.server
import pathlib
import secrets
import sys
import threading

from playwright.sync_api import expect, sync_playwright

sys.path.insert(0, str(pathlib.Path(__file__).parent))
import test_e2e as T  # noqa: E402

SRV = f"teste-sinal-{secrets.token_hex(3)}"


def run(base, shots, relay):
    T.SHOTS = shots
    extra = "&ice=relay" if relay else ""
    url = f"{base}?servidor={SRV}{extra}"
    blocked, sockets = [], []
    with sync_playwright() as p:
        br = T.launch(p)

        def client(name, mobile=False):
            pg = T.page(br, name, viewport={"width": 390, "height": 844} if mobile else None)
            pg.context.route("**/*peerjs*/**", lambda r: (blocked.append(r.request.url), r.abort()))
            pg.context.route("**://*.peerjs.com/**", lambda r: (blocked.append(r.request.url), r.abort()))
            pg.on("websocket", lambda ws: sockets.append(ws.url))
            pg.on("request", lambda rq: "peerjs" in rq.url and blocked.append(rq.url))
            pg.goto(url)
            pg.fill("#homeName", name)
            pg.click("#nameForm [type=submit]")
            T.connected(pg)
            return pg

        a, b, c = client("Ana"), client("Bruno"), client("Caio", True)
        for pg in (a, b, c):
            T.join_voice(pg)
        for pg in (a, b):
            expect(pg.locator("#peopleCount")).to_have_text("3", timeout=45000)
        print("ok: 3 na malha e na voz, sem PeerJS", flush=True)
        for pg in (a, b, c):
            T.voice_ready(pg, 2)
        for pg, n in ((a, "Bruno"), (a, "Caio"), (b, "Ana"), (b, "Caio"), (c, "Ana"), (c, "Bruno")):
            T.hears(pg, n)
        print("ok: voz chega em todos (6 de 6 direções)", flush=True)
        import time
        a.click("#shareBtn")
        t0 = time.time()
        for pg, n in ((b, "Bruno"), (c, "Caio")):
            pg.wait_for_selector('.tile video', timeout=45000)
            print(f"tempo até a tela aparecer em {n}: {time.time() - t0:.2f} s", flush=True)
        T.playing(b)
        T.playing(c)
        assert b.locator(".tile video").evaluate("v => v.srcObject.getAudioTracks().length") == 1, "sem som da tela"
        print("ok: tela da Ana com vídeo e som no Bruno e no Caio", flush=True)
        c.click("#dockWrap #leaveBtn" if c.locator("#dockWrap #leaveBtn").count() else "#leaveBtn")
        expect(a.locator("#people li")).to_have_count(2, timeout=30000)
        T.join_voice(c)
        for pg in (a, b, c):
            expect(pg.locator("#people li")).to_have_count(3, timeout=45000)
        T.voice_ready(c, 2)
        c.wait_for_selector('.tile video', timeout=45000)
        T.playing(c)
        print("ok: Caio saiu da voz e voltou: voz e tela da Ana de volta", flush=True)
        T.shot(a, "100_sinal_3_clientes")
        route = a.evaluate("async () => (await window.BAGRENATION.voiceStats()).map((s) => s.route)")
        print("rotas da voz:", route, flush=True)
        a.click("#shareBtn")
        br.close()
    assert not blocked, f"pediu PeerJS: {blocked}"
    bad = [u for u in sockets if "bagrenation-chat.alissondelittig.workers.dev" not in u]
    assert not bad, f"WebSocket fora do Worker: {bad}"
    print(f"WebSockets: {len(sockets)} (todos do Worker, rotas {sorted({u.split('/')[-1] for u in sockets})}); pedidos ao PeerJS: 0")
    err = [e for e in T.errors if "peerjs" not in e.lower()]
    assert not err, err
    print("SINAL OK")


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    shots = pathlib.Path(args[1]) if len(args) > 1 else None
    if args and args[0].startswith("http"):
        run(args[0], shots, "--relay" in sys.argv)
    else:
        h = functools.partial(type("Q", (http.server.SimpleHTTPRequestHandler,), {"log_message": lambda *a: None}), directory=str(T.ROOT))
        srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), h)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        run(f"http://127.0.0.1:{srv.server_address[1]}/", shots, "--relay" in sys.argv)
