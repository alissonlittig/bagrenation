"""S-1363: vários canais (texto e voz), volume por pessoa e qualidade da transmissão, com 3 navegadores + celular.

Prova: criar canal de texto e de voz pelo "+"; mensagem fica no canal dela; não lidas por canal (negrito + contador);
"digitando" só no canal certo; só quem criou renomeia (chave errada é recusada); quem está em cada canal de voz aparece
embaixo dele e a voz só conecta dentro do mesmo canal; volume por pessoa no botão direito (0-200%, acima de 100% com
ganho de verdade no Web Audio), silenciar só para mim, lembrado depois de recarregar, vale para a tela dela também;
qualidade 720p/1080p/fonte e 30/60 fps aplicada na captura e no codificador (maxBitrate, maxFramerate, redução de
resolução), aviso quando a internet não aguenta; apagar canal de texto e de voz tira quem estava nele; celular com
toque longo. Usa um servidor de teste (?servidor=teste-...), então não aparece no BAGRENATION de verdade.
Uso:  python tests/test_canais.py [url_base] [pasta_prints]
"""
import functools
import http.server
import pathlib
import re
import secrets
import sys
import threading

from playwright.sync_api import expect, sync_playwright

sys.path.insert(0, str(pathlib.Path(__file__).parent))
import test_e2e as T  # noqa: E402
from test_membros import LONG_PRESS, enter, say  # noqa: E402

SRV = f"teste-{secrets.token_hex(4)}"
CH = "() => BAGRENATION.chans()"


def chan(pg, name):
    return pg.locator(".chan[data-ch]", has=pg.locator(".chan-name", has_text=re.compile(rf"^{re.escape(name)}$")))


def in_list(pg, ch_name, who):
    """<li> de `who` embaixo do canal de voz `ch_name` na lateral."""
    cid = chan(pg, ch_name).get_attribute("data-ch")
    return pg.locator(f'ul.people-voice[data-ch="{cid}"] li', has=pg.locator(".nm", has_text=re.compile(rf"^{who}( \(você\))?$")))


def boost(pg, name):
    return next(x for x in pg.evaluate("BAGRENATION.boost()") if x["name"] == name)


def create(pg, kind, name):
    pg.click(f'.chan-add[data-kind="{kind}"]')
    expect(pg.locator("#chanDlg")).to_be_visible()
    pg.fill("#chanName", name)
    pg.click("#chanOk")
    expect(pg.locator("#chanDlg")).to_be_hidden()


def run(base, shots):
    T.SHOTS = shots
    url = f"{base}?servidor={SRV}"
    steps = []
    step = lambda s: (steps.append(s), print("ok:", s, flush=True))
    with sync_playwright() as p:
        br = T.launch(p)
        a = enter(br, url, "Ana")
        b = enter(br, url, "Bruno")
        c = enter(br, url, "Cris")
        for pg in (a, b, c):
            expect(pg.locator("#online li")).to_have_count(3, timeout=20000)
            expect(chan(pg, "chat")).to_have_attribute("aria-current", "page")
            expect(chan(pg, "Canal de voz")).to_be_visible()
        step("3 aparelhos no servidor de teste com #chat e Canal de voz")

        # 1. criar canal de texto pelo "+": nome no padrão do Discord, quem criou já entra nele
        a.click('.chan-add[data-kind="text"]')
        expect(a.locator("#chanDlg")).to_be_visible()
        a.locator("#chanName").press_sequentially("Memes Bons", delay=20)
        expect(a.locator("#chanName")).to_have_value("memes-bons")
        T.shot(a, "70_criar_canal")
        a.click("#chanOk")
        expect(a.locator("#chatTitle")).to_have_text("memes-bons", timeout=10000)
        expect(chan(a, "memes-bons")).to_have_attribute("aria-current", "page")
        expect(a.locator(".chat-start")).to_contain_text("começo do canal #memes-bons")
        for pg in (b, c):
            expect(chan(pg, "memes-bons")).to_be_visible(timeout=10000)
        step('"+" cria #memes-bons (nome em minúsculas com hífen), aparece para todos e quem criou entra nele')

        # 2. mensagem fica no canal dela; não lidas por canal (negrito + contador)
        say(a, "oi no memes")
        a.wait_for_timeout(400)  # o servidor aceita no máximo 4 mensagens por segundo
        say(a, "segunda no memes")
        expect(chan(b, "memes-bons")).to_have_class(re.compile(r"\bunread\b"), timeout=10000)
        expect(chan(b, "memes-bons").locator(".chan-badge")).to_have_text("2")
        expect(b.locator("#chatLog")).not_to_contain_text("oi no memes")
        expect(b.locator("#unreadTop")).to_have_text("2")
        T.shot(b, "71_nao_lidas_por_canal")
        chan(b, "memes-bons").click()
        expect(b.locator("#chatLog")).to_contain_text("segunda no memes", timeout=10000)
        expect(chan(b, "memes-bons")).not_to_have_class(re.compile(r"\bunread\b"))
        expect(chan(b, "memes-bons").locator(".chan-badge")).to_be_hidden()
        say(c, "geral no chat")
        expect(chan(a, "chat")).to_have_class(re.compile(r"\bunread\b"), timeout=10000)
        expect(a.locator("#chatLog")).not_to_contain_text("geral no chat")
        step("mensagem só no canal dela; outro canal fica em negrito com contador; abrir zera")

        # 3. "digitando" só no canal onde a pessoa escreve
        c.click("#chatInput")
        c.keyboard.type("digitando no chat", delay=40)
        b.wait_for_timeout(2500)
        expect(b.locator("#typing")).to_have_text("")  # B está no #memes-bons
        b.click("#chatInput")
        b.keyboard.type("aqui no memes", delay=40)
        expect(a.locator("#typing")).to_have_text(re.compile(r"Bruno está digitando"), timeout=8000)
        c.fill("#chatInput", "")
        b.fill("#chatInput", "")
        step('"digitando" aparece só para quem está no mesmo canal')

        # 4. só quem criou renomeia; chave de moderação errada é recusada; nome novo aparece para todos
        b.hover(".chan-row:has(.chan-name:text-is('memes-bons'))")
        b.locator(".chan-row:has(.chan-name:text-is('memes-bons')) .chan-gear").click()
        expect(b.locator("#chanAdmWrap")).to_be_visible()
        expect(b.locator("#chanDel")).to_be_visible()
        b.fill("#chanName", "roubado")
        b.fill("#chanAdm", "chave-errada")
        T.shot(b, "72_editar_canal_moderacao")
        b.click("#chanOk")
        expect(b.locator("#toasts")).to_contain_text("Chave de moderação errada", timeout=8000)
        expect(chan(a, "memes-bons")).to_be_visible()
        a.click(".chan-row:has(.chan-name:text-is('memes-bons')) .chan-gear", force=True)
        expect(a.locator("#chanAdmWrap")).to_be_hidden()
        a.fill("#chanName", "memes 2")
        a.click("#chanOk")
        for pg in (a, b, c):
            expect(chan(pg, "memes-2")).to_be_visible(timeout=8000)
        expect(b.locator("#chatTitle")).to_have_text("memes-2")
        step("renomear: chave errada recusada; quem criou renomeia e todos veem")

        # 5. canal de voz novo: cada um no seu canal; voz conecta só dentro do mesmo canal
        a.wait_for_timeout(900)  # o servidor aceita um comando de canal a cada 0,8 s por conexão
        create(a, "voice", "Sala do Jogo")
        expect(a.locator("#dockWrap")).to_be_visible(timeout=10000)
        expect(a.locator("#roomTitle")).to_have_text("Sala do Jogo")
        expect(chan(c, "Sala do Jogo")).to_be_visible(timeout=10000)
        chan(c, "Sala do Jogo").click()
        T.join_voice(b)  # canal de sempre
        for pg in (a, b, c):
            expect(in_list(pg, "Sala do Jogo", "Ana")).to_be_visible(timeout=20000)
            expect(in_list(pg, "Sala do Jogo", "Cris")).to_be_visible()
            expect(in_list(pg, "Canal de voz", "Bruno")).to_be_visible()
            expect(pg.locator("#voiceCount")).to_have_text("1")
            expect(chan(pg, "Sala do Jogo").locator(".chan-count")).to_have_text("2")
        T.voice_ready(a, 1)
        T.voice_ready(c, 1)
        assert [s["name"] for s in a.evaluate(T.STATS)] == ["Cris"]
        b.wait_for_timeout(1500)
        assert b.evaluate(T.STATS) == [], "Bruno (outro canal) conectou voz com a Sala"
        T.hears(a, "Cris")
        expect(a.locator("#voiceGrid li")).to_have_count(2)
        T.shot(a, "73_dois_canais_de_voz")
        step("canal de voz novo: cada pessoa aparece embaixo do seu canal; voz só entre quem está no mesmo canal")

        # 6. volume por pessoa: botão direito -> 0-200%, silenciar só para mim, lembrado
        in_list(a, "Sala do Jogo", "Cris").click(button="right")
        expect(a.locator("#userMenu")).to_be_visible()
        expect(a.locator("#umName")).to_have_text("Cris")
        a.locator("#umV").fill("1.5")
        expect(a.locator("#umVOut")).to_have_text("150%")
        x = boost(a, "Cris")
        assert x["voice"] == 1.5 and x["audioMuted"] and x["ac"] == "running", x
        expect(in_list(a, "Sala do Jogo", "Cris").locator(".sub")).to_contain_text("150%")
        T.shot(a, "74_volume_por_pessoa")
        a.locator("#umV").fill("0.4")
        x = boost(a, "Cris")
        assert x["voice"] is None and abs(x["audioVol"] - 0.4) < 0.01 and not x["audioMuted"], x
        a.click("#umMute + .switch")
        expect(a.locator("#umMute")).to_be_checked()
        assert boost(a, "Cris")["audioMuted"]
        expect(in_list(a, "Sala do Jogo", "Cris")).to_have_class(re.compile("is-hushed"))
        T.hears(c, "Ana")  # silenciar é só para mim: a Cris continua ouvindo a Ana
        a.click("#umMute + .switch")
        a.locator("#umV").fill("1.8")
        a.keyboard.press("Escape")
        expect(a.locator("#userMenu")).to_be_hidden()
        a.reload()
        T.connected(a)
        chan(a, "Sala do Jogo").click()
        T.voice_ready(a, 1)
        a.wait_for_function("() => BAGRENATION.boost().some(x => x.name === 'Cris' && Math.abs(x.voice - 1.8) < 0.001)", timeout=15000)
        step("volume por pessoa: 150% com ganho de verdade, 40%, silenciar só para mim, e 180% lembrado depois de recarregar")

        # 7. tela: qualidade padrão 720p30 aplicada no codificador; volume da tela da pessoa pelo mesmo menu
        c.click("#settingsBtn")
        expect(c.locator('#qRes [data-v="720"]')).to_have_attribute("aria-pressed", "true")
        expect(c.locator('#qFps [data-v="30"]')).to_have_attribute("aria-pressed", "true")
        c.keyboard.press("Escape")
        c.click("#shareBtn")
        T.playing(a)
        c.wait_for_function("() => BAGRENATION.sendParams().some(s => s.enc && s.enc.maxBitrate)", timeout=20000)
        sp = c.evaluate("BAGRENATION.sendParams()")[0]
        enc = sp["enc"]
        assert enc["maxFramerate"] == 30 and 2.0e6 < enc["maxBitrate"] < 3.0e6, enc
        h = sp["settings"]["height"]
        assert abs(h / enc.get("scaleResolutionDownBy", 1) - 720) < 2 or h <= 720, (sp, enc)
        expect(a.locator(".tile-stats")).to_contain_text("1280×720", timeout=20000)
        step(f"720p30 padrão: codificador com teto {enc['maxBitrate'] / 1e6:.1f} Mb/s, 30 fps e redução para 720p (quem assiste recebe 1280×720)")
        a.locator(".tile").click(button="right")
        expect(a.locator("#userMenu")).to_be_visible()
        a.locator("#umS").fill("1.6")
        x = boost(a, "Cris")
        assert abs(x["screen"] - 1.6) < 0.001 and x["screenMuted"], x  # AudioParam guarda float32
        expect(a.locator(".tile .js-vol")).to_have_value("1.6")
        a.keyboard.press("Escape")
        T.shot(a, "75_volume_da_tela")
        step("volume da tela da pessoa: 160% com ganho, no menu da pessoa e na barra da tela")

        # 8. trocar para 1080p60 e fonte ao vivo; aviso quando a internet não aguenta
        c.click("#settingsBtn")
        c.click('#qRes [data-v="1080"]')
        c.click('#qFps [data-v="60"]')
        c.wait_for_function("() => { const e = BAGRENATION.sendParams()[0].enc; return e.maxFramerate === 60 && e.maxBitrate > 9e6; }", timeout=10000)
        expect(c.locator("#qNote")).to_contain_text("1080p · 60 fps")
        expect(a.locator(".tile-stats")).to_contain_text("1920×1080", timeout=20000)
        c.click('#qRes [data-v="src"]')
        c.wait_for_function("() => (BAGRENATION.sendParams()[0].enc.scaleResolutionDownBy || 1) === 1", timeout=10000)
        for _ in range(3):
            c.evaluate("BAGRENATION.band(true, 2e6)")
        expect(c.locator("#qWarn")).to_be_visible()
        expect(c.locator("#qWarn")).to_contain_text("não está aguentando Fonte · 60 fps")
        expect(c.locator("#toasts")).to_contain_text("não está aguentando")
        T.shot(c, "76_qualidade_aviso")
        c.click('#qRes [data-v="720"]')
        c.click('#qFps [data-v="30"]')
        expect(c.locator("#qWarn")).to_be_hidden()
        c.keyboard.press("Escape")
        T.playing(a)
        step("1080p60 e fonte aplicados ao vivo no codificador; aviso de internet fraca; volta a 720p30 sem cair")

        # 9. celular: canais na gaveta e toque longo na pessoa abre o volume (folha de baixo)
        m = enter(br, url, "Celular", viewport={"width": 390, "height": 844})
        m.click("#panelBtn")
        expect(chan(m, "Sala do Jogo")).to_be_visible()
        chan(m, "Sala do Jogo").click()
        expect(m.locator("#dockWrap")).to_be_visible()
        m.click("#panelBtn")
        li = in_list(m, "Sala do Jogo", "Ana")
        expect(li).to_be_visible(timeout=20000)
        li.evaluate(LONG_PRESS)
        expect(m.locator("#userMenu")).to_be_visible()
        expect(m.locator("#userMenu")).to_have_class(re.compile("sheet"))
        T.shot(m, "77_celular_volume")
        m.keyboard.press("Escape")
        m.context.close()
        step("celular: canais na gaveta, entra no canal de voz e o toque longo abre o volume da pessoa")

        # 10. apagar canal: quem estava nele volta (texto: #chat; voz: sai do canal)
        a.click(".chan-row:has(.chan-name:text-is('memes-2')) .chan-gear", force=True)
        a.click("#chanDel")
        expect(a.locator("#chanDel")).to_have_text(re.compile("Confirmar"))
        a.click("#chanDel")
        expect(chan(b, "memes-2")).to_have_count(0, timeout=10000)
        expect(b.locator("#chatTitle")).to_have_text("chat")
        expect(b.locator("#toasts")).to_contain_text("foi apagado")
        a.wait_for_timeout(900)
        a.click(".chan-row:has(.chan-name:text-is('Sala do Jogo')) .chan-gear", force=True)
        a.click("#chanDel")
        a.click("#chanDel")
        for pg in (a, c):
            expect(pg.locator("#dockWrap")).to_be_hidden(timeout=10000)
        expect(c.locator("#toasts")).to_contain_text("canal de voz em que você estava foi apagado")
        expect(chan(b, "Sala do Jogo")).to_have_count(0)
        expect(b.locator("#dockWrap")).to_be_visible()  # Bruno, no canal de sempre, segue na voz
        T.shot(b, "78_depois_de_apagar")
        step("apagar #memes-2 leva quem estava nele para o #chat; apagar a Sala tira Ana e Cris da voz; Bruno segue")

        br.close()
    assert not T.errors, "erros de console:\n" + "\n".join(T.errors)
    print(f"CANAIS OK ({len(steps)} passos), 0 erro de console, servidor de teste {SRV}")


if __name__ == "__main__":
    shots = pathlib.Path(sys.argv[2]) if len(sys.argv) > 2 else None
    if len(sys.argv) > 1 and sys.argv[1].startswith("http"):
        run(sys.argv[1], shots)
    else:
        h = functools.partial(type("Q", (http.server.SimpleHTTPRequestHandler,), {"log_message": lambda *a: None}), directory=str(T.ROOT))
        srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), h)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        run(f"http://127.0.0.1:{srv.server_address[1]}/", shots)
