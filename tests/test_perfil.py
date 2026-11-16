"""S-1412: perfil da pessoa (cartão estilo Discord).

2 navegadores: A edita a bio e B, com o perfil de A aberto, vê a mudança na hora; B escreve uma nota privada em A e
ela não aparece em A nem sai pela rede; zoom da foto (Esc fecha); abrir pelo chat e pela voz; botão Mensagem;
volume na voz; celular (folha de baixo). Usa servidor de teste.
Uso:  python tests/test_perfil.py [url_base] [pasta_prints]
"""
import functools, http.server, pathlib, re, secrets, sys, threading

from playwright.sync_api import expect, sync_playwright

sys.path.insert(0, str(pathlib.Path(__file__).parent))
import test_e2e as T  # noqa: E402

T.SRV = f"teste-pf-{secrets.token_hex(3)}"
NOTA = "NOTA-SECRETA-" + secrets.token_hex(4)


def row(pg, name):
    return pg.locator("#online li, #idle li, #offline li", has=pg.locator(".nm", has_text=re.compile(rf"^{name}( \(você\))?$"))).first


def run(base, shots):
    with sync_playwright() as p:
        br = T.launch(p)
        pa, pb = T.page(br, "A"), T.page(br, "B")
        sent = []  # tudo o que B manda pela rede
        pb.on("websocket", lambda ws: ws.on("framesent", lambda f: sent.append(str(f))))
        for pg, n in ((pa, "Ana"), (pb, "Bia")):
            T.enter(pg, base, n, voice=False)
        expect(row(pb, "Ana")).to_be_visible()
        # 1) A abre o próprio perfil (sem nota, sem botão Mensagem), edita a bio
        row(pa, "Ana").click()
        expect(pa.locator("#profDlg")).to_be_visible()
        expect(pa.locator("#pfBioEdit")).to_be_visible()
        expect(pa.locator("#pfNoteSec")).to_be_hidden()
        expect(pa.locator("#pfMsg")).to_be_hidden()
        pa.fill("#pfBioIn", "Jogo à noite.\nMeu bagre é rápido.")
        pa.click("#pfBioSave")
        expect(pa.locator("#pfBioSave")).to_be_disabled()
        pa.keyboard.press("Escape")
        expect(pa.locator("#profDlg")).to_be_hidden()
        # 2) B abre o perfil de A e vê a bio; depois A muda e B vê sem reabrir
        row(pb, "Ana").click()
        expect(pb.locator("#pfName")).to_have_text("Ana")
        expect(pb.locator("#pfBio")).to_contain_text("Meu bagre é rápido.", timeout=10000)
        expect(pb.locator("#pfStTx")).to_have_text("Online")
        expect(pb.locator("#pfSince")).not_to_have_text("—")
        if shots: pb.screenshot(path=str(shots / "perfil_B_ve_A.png"))
        row(pa, "Ana").click()
        pa.fill("#pfBioIn", "Bio nova ao vivo")
        pa.click("#pfBioSave")
        expect(pb.locator("#pfBio")).to_have_text("Bio nova ao vivo", timeout=10000)
        pa.keyboard.press("Escape")
        print("BIO OK: B viu a bio de A na hora, sem recarregar")
        # 3) nota privada
        pb.fill("#pfNote", NOTA)
        pb.keyboard.press("Escape")
        pb.reload()
        T.connected(pb)
        row(pb, "Ana").click()
        expect(pb.locator("#pfNote")).to_have_value(NOTA)  # ficou salva no aparelho
        pb.keyboard.press("Escape")
        row(pa, "Bia").click()
        expect(pa.locator("#pfNote")).to_have_value("")  # A não vê a nota de B
        pa.keyboard.press("Escape")
        assert not any(NOTA in f for f in sent), "a nota saiu pela rede"
        assert NOTA not in pa.evaluate("JSON.stringify(Object.entries(localStorage))")
        print("NOTA OK: salva no aparelho de B, não vazou para A nem pela rede")
        # 4) zoom da foto + Esc
        row(pb, "Ana").click()
        pb.click("#pfAv")
        expect(pb.locator("#zoomDlg")).to_be_visible()
        if shots: pb.screenshot(path=str(shots / "perfil_zoom.png"))
        pb.keyboard.press("Escape")
        expect(pb.locator("#zoomDlg")).to_be_hidden()
        expect(pb.locator("#profDlg")).to_be_visible()
        pb.keyboard.press("Escape")
        expect(pb.locator("#profDlg")).to_be_hidden()
        # clique fora fecha
        row(pb, "Ana").click()
        pb.mouse.click(5, 5)
        expect(pb.locator("#profDlg")).to_be_hidden()
        print("ZOOM OK: foto ampliada, Esc e clique fora fecham")
        # foto enviada (GIF animado): B abre o perfil, a foto aparece e o zoom mostra o mesmo GIF
        from PIL import Image
        import tempfile
        gif = pathlib.Path(tempfile.mkdtemp()) / "anim.gif"
        fr = [Image.new("P", (64, 64), c) for c in (1, 2, 3)]
        for f in fr: f.putpalette([0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255] + [0] * 756)
        fr[0].save(gif, save_all=True, append_images=fr[1:], duration=100, loop=0)
        pa.click("#meAvatar")
        pa.set_input_files("#avFile", str(gif))
        pa.click("#cropOk")
        expect(pa.locator("#avatarDlg")).to_be_hidden()
        row(pb, "Ana").locator("img").wait_for(timeout=10000)
        row(pb, "Ana").click()
        expect(pb.locator("#pfAv img")).to_have_count(1)
        pb.click("#pfAv")
        expect(pb.locator("#zoomAv img")).to_have_count(1)
        assert pb.eval_on_selector("#zoomAv img", "i => i.src") == pb.eval_on_selector("#pfAv img", "i => i.src") and "/m/" in pb.eval_on_selector("#zoomAv img", "i => i.src")
        if shots: pb.screenshot(path=str(shots / "perfil_zoom_gif.png"))
        pb.keyboard.press("Escape"); pb.keyboard.press("Escape")
        print("FOTO OK: GIF enviado aparece no cartão e no zoom")
        # 5) pelo chat + botão Mensagem
        pa.fill("#chatInput", "oi gente")
        pa.press("#chatInput", "Enter")
        pb.locator("#chatLog .msg .msg-name", has_text="Ana").first.click()
        expect(pb.locator("#pfName")).to_have_text("Ana", timeout=10000)
        pb.click("#pfMsg")
        expect(pb.locator("#profDlg")).to_be_hidden()
        expect(pb.locator("#chatInput")).to_have_value("@Ana ")
        expect(pb.locator("#chatInput")).to_be_focused()
        print("CHAT OK: nome no chat abre o perfil e Mensagem menciona")
        # 7) voz: volume dessa pessoa no cartão
        T.join_voice(pa); T.join_voice(pb)
        T.voice_ready(pb, 1)
        pb.locator(".people-voice li", has_text="Ana").first.click()
        expect(pb.locator("#pfVol")).to_be_visible()
        pb.fill("#pfVolIn", "0.5")
        pb.dispatch_event("#pfVolIn", "input")
        expect(pb.locator("#pfVolOut")).to_have_text("50%")
        if shots: pb.screenshot(path=str(shots / "perfil_voz.png"))
        pb.keyboard.press("Escape")
        print("VOZ OK: volume da pessoa no cartão")
        # 8) celular: folha de baixo
        pm = T.page(br, "M", viewport={"width": 390, "height": 844})
        T.enter(pm, base, "Caio", voice=False)
        pm.click("#panelBtn")
        pm.locator("#online li, #idle li, #offline li", has=pm.locator(".nm", has_text=re.compile(r"^Ana$"))).first.click()
        expect(pm.locator("#profDlg")).to_be_visible()
        pm.wait_for_timeout(500)  # fim da animação da folha
        box = pm.locator("#profDlg").bounding_box()
        assert box["y"] + box["height"] >= 840 and box["width"] >= 388, box  # colada embaixo, largura toda
        expect(pm.locator("#pfBio")).to_contain_text("Bio nova ao vivo")
        mb = pm.locator("#pfMsg").bounding_box()
        assert mb["y"] + mb["height"] <= 844, mb  # botão Mensagem visível sem rolar
        if shots: pm.screenshot(path=str(shots / "perfil_celular.png"))
        br.close()
    errors = [e for e in T.errors if "status of 41" not in e]
    assert not errors, errors
    print("PERFIL OK")


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
