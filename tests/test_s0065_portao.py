"""S-0065: servidor fechado no site, com 3 navegadores num servidor de teste fechado (?servidor=teste-fech-...).
Dono (1º a entrar no teste vira dono) | Visitante sem convite: só a tela de entrar, sem canais, mensagens nem quem está
online | Dono abre Membros, gera convite | Visitante cola o link e entra, vê a mensagem e a imagem | Dono expulsa:
o visitante cai na hora com "Você saiu deste servidor" | convite novo: o antigo não entra mais (Cris) e o novo entra.
Uso:  python tests/test_s0065_portao.py [url_base] [pasta_prints]
"""
import pathlib
import secrets
import sys

from playwright.sync_api import expect, sync_playwright

sys.path.insert(0, str(pathlib.Path(__file__).parent))
import test_e2e as T  # noqa: E402
import test_s0065_dj as D  # noqa: E402

SRV = f"teste-fech-ui-{secrets.token_hex(3)}"
steps = []
PNG = bytes.fromhex("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082")


def step(t):
    steps.append(t)
    print(f"ok {len(steps):2d}: {t}", flush=True)


def first(pg, url, name):
    pg.goto(url)
    expect(pg.locator("#nameDlg")).to_be_visible()
    pg.fill("#homeName", name)
    pg.click("#nameForm [type=submit]")


def run(base, shots):
    url = f"{base}?servidor={SRV}"
    with sync_playwright() as p:
        br = T.launch(p)
        dono = D.page(br, "Dono", False)
        first(dono, url, "Dono")
        T.connected(dono)
        expect(dono.locator("#admBtn")).to_be_visible(timeout=15000)
        D.say(dono, "mensagem só para os amigos")
        dono.wait_for_timeout(1500)
        step("dono entra (1º do servidor de teste fechado), vê o botão Membros e manda mensagem")

        vis = D.page(br, "Visitante", False)
        vis.goto(url)
        expect(vis.locator("#lock")).to_be_visible(timeout=15000)
        expect(vis.locator("#nameDlg")).not_to_be_visible()
        vis.wait_for_timeout(1500)
        leak = vis.evaluate("() => ({ msgs: document.querySelectorAll('#chatLog .msg').length, txt: document.body.innerText.includes('mensagem só para os amigos'), members: BAGRENATION.members().length, chans: BAGRENATION.chans().list.map((c) => c.name) })")
        assert leak["msgs"] == 0 and not leak["txt"] and leak["members"] == 0, leak
        if shots: T.SHOTS = pathlib.Path(shots); T.shot(vis, "s65_03_sem_convite")
        step(f"visitante sem convite: só a tela de entrar (0 mensagens, 0 membros, canais só os nomes padrão {leak['chans']})")

        dono.click("#admBtn")
        expect(dono.locator("#admDlg")).to_be_visible()
        expect(dono.locator("#admList .adm-row", has_text="Dono")).to_be_visible(timeout=10000)
        dono.click("#admInvNew")
        dono.click("#admInvNew")
        expect(dono.locator("#admInvBox")).to_be_visible(timeout=10000)
        link = dono.input_value("#admInvLink")
        assert "#convite=" in link and len(link.split("#convite=")[1]) == 43, link
        if shots: T.shot(dono, "s65_04_membros_dono")
        step("dono: Membros lista o dono (você · Online); Gerar novo convite (2 toques) mostra o link")

        local_link = url + "#convite=" + link.split("#convite=")[1]
        vis.fill("#lockInput", link)  # cola o link inteiro (como no app de PC ou no Android)
        vis.click("#lockGo")
        expect(vis.locator("#nameDlg")).to_be_visible(timeout=10000)
        vis.fill("#homeName", "Visitante")
        vis.click("#nameForm [type=submit]")
        T.connected(vis)
        expect(vis.locator("#chatLog .msg", has_text="mensagem só para os amigos")).to_be_visible(timeout=15000)
        expect(vis.locator("#lock")).to_be_hidden()
        step("visitante cola o link do convite, escolhe o nome e entra: vê o histórico")

        dono.evaluate("() => document.getElementById('admDlg').close()")
        dono.click("#admBtn")
        row = dono.locator("#admList .adm-row", has_text="Visitante")
        expect(row).to_be_visible(timeout=10000)
        row.locator("button").click()
        row.locator("button").click()
        expect(vis.locator("#lock")).to_be_visible(timeout=10000)
        expect(vis.locator("#lockTitle")).to_have_text("Você saiu deste servidor")
        assert vis.evaluate("() => document.querySelectorAll('#chatLog .msg').length") == 0
        if shots: T.shot(vis, "s65_05_expulso")
        expect(dono.locator("#admList .adm-row.is-ban", has_text="Visitante")).to_be_visible(timeout=10000)
        step("dono expulsa (2 toques): o visitante cai na hora com 'Você saiu deste servidor', o chat some da tela; na lista ele fica Bloqueado")

        dono.locator("#admInvNew").click()
        dono.locator("#admInvNew").click()
        dono.wait_for_function("old => document.getElementById('admInvLink').value !== old", arg=link, timeout=10000)
        novo = dono.input_value("#admInvLink").split("#convite=")[1]
        cris = D.page(br, "Cris", False, viewport={"width": 390, "height": 844})
        cris.goto(local_link)
        expect(cris.locator("#nameDlg")).to_be_visible(timeout=10000)
        cris.fill("#homeName", "Cris")
        cris.click("#nameForm [type=submit]")
        expect(cris.locator("#lock")).to_be_visible(timeout=15000)
        expect(cris.locator("#lockText")).to_contain_text("não vale mais")
        cris.fill("#lockInput", novo)
        cris.click("#lockGo")
        T.connected(cris)
        expect(cris.locator("#chatLog .msg", has_text="mensagem só para os amigos")).to_be_visible(timeout=15000)
        step("convite novo: o link antigo não entra mais ('não vale mais'); o código novo colado entra (celular 390)")
        br.close()


if __name__ == "__main__":
    base = sys.argv[1] if len(sys.argv) > 1 and sys.argv[1] != "local" else None
    shots = sys.argv[2] if len(sys.argv) > 2 else None
    base = base or D.site_server()
    try:
        run(base, shots)
    except Exception as e:  # noqa: BLE001
        print(f"FALHOU no passo {len(steps) + 1}: {e}", flush=True)
        print("RESULTADO", {"rc": 1, "passos": len(steps), "erro": str(e)[:300]})
        sys.exit(1)
    bad = [e for e in D.errors if "ERR_BLOCKED_BY_CLIENT" not in e and "403" not in e]
    print("\n".join(bad[:10]))
    print(f"S0065 PORTAO OK ({len(steps)} passos), {len(bad)} erro(s) de console")
    print("RESULTADO", {"rc": 0, "passos": len(steps), "erros_console": len(bad)})
