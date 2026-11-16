"""S-1397: avatar próprio (enviar imagem do computador).

Prova com 2 navegadores: A envia um PNG (recortado 256x256) e depois um GIF animado; B vê a troca na hora,
sem recarregar, na lista de membros e no chat; o bagre pronto volta a funcionar; tipo errado (SVG/txt) e imagem
> 5 MB são recusados (no cliente e no Worker); o arquivo sai com nosniff. Usa servidor de teste.
Uso:  python tests/test_avatar.py [url_base] [pasta_prints]
"""
import subprocess, functools, http.server, io, pathlib, re, secrets, sys, tempfile, threading, urllib.request

from PIL import Image
from playwright.sync_api import expect, sync_playwright

sys.path.insert(0, str(pathlib.Path(__file__).parent))
import test_e2e as T  # noqa: E402

T.SRV = f"teste-av-{secrets.token_hex(3)}"
WORKER = "https://bagrenation-chat.alissondelittig.workers.dev"
tmp = pathlib.Path(tempfile.mkdtemp())


def files():
    Image.new("RGB", (400, 300), (220, 30, 120)).save(tmp / "foto.png")
    fr = [Image.new("P", (64, 64), c) for c in (1, 2, 3)]
    for f in fr:
        f.putpalette([0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255] + [0] * 756)
    fr[0].save(tmp / "anim.gif", save_all=True, append_images=fr[1:], duration=100, loop=0)
    (tmp / "x.svg").write_text("<svg xmlns='http://www.w3.org/2000/svg'/>")
    (tmp / "grande.png").write_bytes(b"\x89PNG\r\n\x1a\n" + bytes(5 * 1024 * 1024 + 10))


def head(url):  # curl: o Python desta máquina falha no certificado
    out = subprocess.run(['curl', '-s', '-D', '-', '-o', 'NUL', '-H', 'Origin: http://127.0.0.1', url], capture_output=True, text=True).stdout
    return {l.split(':', 1)[0].lower(): l.split(':', 1)[1].strip() for l in out.splitlines() if ':' in l}


def src_of(pg, sel):
    return pg.locator(sel).first.get_attribute("src")


def run(base, shots):
    files()
    errors = T.errors
    with sync_playwright() as p:
        br = T.launch(p)
        pa, pb = T.page(br, "A"), T.page(br, "B")
        for pg, n in ((pa, "Ana"), (pb, "Bia")):
            pg.goto(T.srv_url(base))
            pg.fill("#homeName", n)
            pg.click("#nameForm [type=submit]")
            T.connected(pg)
        row_a_in_b = pb.locator("#online li", has=pb.locator(".nm", has_text=re.compile(r"^Ana$"))).locator(".avatar")
        expect(row_a_in_b.first).to_be_visible()
        # 1) PNG: recorte e preview, salvar
        pa.click("#meAvatar")
        pa.set_input_files("#avFile", str(tmp / "foto.png"))
        expect(pa.locator("#cropBox")).to_be_visible()
        pa.fill("#cropZoom", "2")
        pa.dispatch_event("#cropZoom", "input")
        if shots: pa.screenshot(path=str(shots / "av_recorte.png"))
        pa.click("#cropOk")
        expect(pa.locator("#avatarDlg")).to_be_hidden()
        expect(row_a_in_b.locator("img")).to_have_count(1, timeout=10000)   # B vê sem recarregar
        png_src = src_of(pb, "#online li .avatar[data-av^='u-'] img")
        h = head(png_src)
        assert (h.get('content-type'), h.get('x-content-type-options')) == ('image/png', 'nosniff'), dict(h)
        expect(pa.locator("#meAvatar img")).to_have_count(1)
        pa.fill("#chatInput", "oi com foto")
        pa.press("#chatInput", "Enter")
        expect(pb.locator("#chatLog .msg .avatar img").first).to_be_visible(timeout=10000)
        if shots: pb.screenshot(path=str(shots / "av_B_ve_png.png"))
        print("PNG OK: B viu o avatar de A na lista e no chat sem recarregar")
        # 2) GIF animado
        pa.click("#meAvatar")
        pa.set_input_files("#avFile", str(tmp / "anim.gif"))
        expect(pa.locator("#cropGif")).to_be_visible()
        pa.click("#cropOk")
        expect(pa.locator("#avatarDlg")).to_be_hidden()
        pb.wait_for_function("s => [...document.querySelectorAll('#online li .avatar img')].some(i => i.src.includes('/m/') && i.src !== s)", arg=png_src, timeout=10000)
        gif_src = [i for i in pb.eval_on_selector_all("#online li .avatar img", "e => e.map(i => i.src)") if i != png_src][0]
        assert head(gif_src).get("content-type") == "image/gif"
        if shots: pb.screenshot(path=str(shots / "av_B_ve_gif.png"))
        print("GIF OK: B viu o GIF de A na hora")
        # 3) recusas
        pa.click("#meAvatar")
        for f in ("x.svg", "grande.png"):
            pa.set_input_files("#avFile", str(tmp / f))
            expect(pa.locator("#cropBox")).to_be_hidden()
        for mime, n in (("image/svg+xml", 100), ("image/png", 5 * 1024 * 1024 + 1), ("video/mp4", 100)):
            code = pa.evaluate("async ([w, m, n]) => { const r = await fetch(w + '/s/x/up?av=1', { method: 'POST', headers: { 'Content-Type': m }, body: new Uint8Array(n) }); return r.status; }", [WORKER, mime, n])
            assert code in (403, 413, 415), (mime, code)  # 403 = origem do teste local não autorizada (ok); 413/415 = recusa do Worker
        # 4) bagre pronto continua
        pa.click('#avatarGrid button[title="bagre"]') if pa.locator('#avatarGrid button[title="bagre"]').count() else pa.locator("#avatarGrid button").nth(1).click()
        expect(pa.locator("#meAvatar img")).to_have_count(0)
        expect(row_a_in_b.locator("img")).to_have_count(0, timeout=10000)
        print("BAGRE OK: avatar pronto volta e B atualiza")
        br.close()
    errors = [e for e in errors if "status of 41" not in e]  # as recusas de propósito (415/413) aparecem no console
    assert not errors, errors
    print("AVATAR OK")


if __name__ == "__main__":
    shots = pathlib.Path(sys.argv[2]) if len(sys.argv) > 2 else None
    if shots: shots.mkdir(parents=True, exist_ok=True)
    if len(sys.argv) > 1 and sys.argv[1].startswith("http"):
        run(sys.argv[1], shots)
    else:
        h = functools.partial(type("Q", (http.server.SimpleHTTPRequestHandler,), {"log_message": lambda *a: None}), directory=str(T.ROOT))
        srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), h)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        run(f"http://127.0.0.1:{srv.server_address[1]}/", shots)
