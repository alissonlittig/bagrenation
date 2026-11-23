"""S-1357: membros (online/ausente/offline), status, "digitando", ações na mensagem e editar, com 3 navegadores.

Prova: cada aparelho tem identidade fixa; a lista de membros separa Online / Ausente / Offline (quem fecha vai para
Offline e continua lá); status manual (ausente, invisível) e automático (ausente sem mexer); bolinha de status nos
avatares; "A está digitando" e "A e C estão digitando"; responder (citação leva à original), reagir (contador e
quem reagiu), copiar, editar (botão e seta para cima, marca "(editada)"), apagar a própria (outro não consegue);
tudo em tempo real e continua depois de recarregar; mensagem antiga sem autor aparece normal; celular com toque longo.
Usa um servidor de teste (?servidor=teste-...), então não aparece no BAGRENATION de verdade.
Uso:  python tests/test_membros.py [url_base] [pasta_prints]
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

SRV = f"teste-{secrets.token_hex(4)}"


def member(pg, box, name):
    return pg.locator(f"#{box} li", has=pg.locator(".nm", has_text=re.compile(rf"^{name}( \(você\))?$")))


def msg(pg, text):
    return pg.locator("#chatLog .msg", has=pg.locator(".msg-text", has_text=text))


def enter(br, url, name, **kw):
    pg = T.page(br, name, **kw)
    pg.goto(url)
    pg.fill("#homeName", name)
    pg.click("#nameForm [type=submit]")
    T.connected(pg)
    return pg


def hover_tools(pg, text):
    m = msg(pg, text)
    m.scroll_into_view_if_needed()
    m.hover()
    expect(m.locator(".msg-tools")).to_be_visible()
    return m


def say(pg, text):
    pg.fill("#chatInput", text)
    pg.press("#chatInput", "Enter")


# mensagem sem autor, como as de antes desta versão (WebSocket cru, sem se identificar)
OLD_MSG = """async ([url, text]) => {
  const ws = new WebSocket(url);
  await new Promise((r) => ws.addEventListener('open', r));
  ws.send(JSON.stringify({ t: 'msg', name: 'Velho', av: '', text }));
  await new Promise((r) => setTimeout(r, 600));
  ws.close();
}"""

LONG_PRESS = """(el) => {
  const r = el.getBoundingClientRect();
  const o = { pointerType: 'touch', bubbles: true, clientX: r.left + 60, clientY: r.top + r.height / 2 };
  el.dispatchEvent(new PointerEvent('pointerdown', o));
  return new Promise((ok) => setTimeout(() => { el.dispatchEvent(new PointerEvent('pointerup', o)); ok(); }, 650));
}"""


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
            expect(pg.locator("#peopleCountSide")).to_have_text("3")
            expect(pg.locator("#offHead")).to_be_hidden()
        expect(member(a, "online", "Bruno").locator(".avatar")).to_have_attribute("data-st", "on")
        expect(a.locator("#meAvatar")).to_have_attribute("data-st", "on")
        uids = {pg.evaluate("BAGRENATION.me().uid") for pg in (a, b, c)}
        assert len(uids) == 3 and all(re.fullmatch(r"[0-9a-f]{16}", u) for u in uids), uids
        T.shot(a, "50_membros_online")
        step("3 aparelhos com identidade própria, todos na lista Online com a bolinha verde")

        # 1. digitando: um e dois ao mesmo tempo
        a.click("#chatInput")
        a.keyboard.type("oi gente", delay=40)
        expect(b.locator("#typing")).to_have_text(re.compile(r"Ana está digitando"), timeout=8000)
        c.click("#chatInput")
        c.keyboard.type("eae", delay=40)
        expect(b.locator("#typing")).to_have_text(re.compile(r"(Ana e Cris|Cris e Ana) estão digitando"), timeout=8000)
        expect(a.locator("#typing")).to_have_text(re.compile(r"^Cris está digitando"))  # eu não apareço para mim
        T.shot(b, "51_digitando_dois")
        a.press("#chatInput", "Enter")
        expect(b.locator("#typing")).to_have_text(re.compile(r"^Cris está digitando"), timeout=8000)  # mandou: some
        c.fill("#chatInput", "")
        expect(b.locator("#typing")).to_have_text("", timeout=10000)
        step('"Ana está digitando…", "Ana e Cris estão digitando…" e some ao enviar/parar')

        # 2. status manual: ausente e invisível; automático: ausente sem mexer
        b.click("#statusBtn")
        expect(b.locator("#statusPop")).to_be_visible()
        T.shot(b, "52_escolher_status")
        b.click("#statusPop [data-st=idle]")
        expect(member(a, "idle", "Bruno")).to_have_count(1, timeout=10000)
        expect(a.locator("#idleHead")).to_be_visible()
        expect(member(a, "idle", "Bruno").locator(".avatar")).to_have_attribute("data-st", "idle")
        assert "255, 230, 0" in member(a, "idle", "Bruno").locator(".avatar").evaluate("(el) => getComputedStyle(el, '::before').backgroundColor"), "bolinha de ausente não é amarela"
        expect(b.locator("#statusLabel")).to_have_text("Ausente")
        T.shot(a, "53_bruno_ausente")
        b.click("#statusBtn")
        b.click("#statusPop [data-st=off]")
        expect(member(a, "offline", "Bruno")).to_have_count(1, timeout=10000)
        expect(member(b, "offline", "Bruno")).to_have_count(1)  # ele se vê em Offline, como no Discord
        expect(b.locator("#statusLabel")).to_have_text("Invisível")
        b.click("#statusBtn")
        b.click("#statusPop [data-st=auto]")
        expect(member(a, "online", "Bruno")).to_have_count(1, timeout=10000)
        a.evaluate("BAGRENATION.idleAfter(1500)")
        a.wait_for_timeout(1800)
        a.evaluate("BAGRENATION.idleAfter(1500)")  # mesma conta, sem esperar os 15 s do relógio
        expect(member(b, "idle", "Ana")).to_have_count(1, timeout=10000)
        expect(a.locator("#statusLabel")).to_have_text("Ausente")
        a.mouse.move(400, 300)
        a.mouse.move(420, 320)
        expect(member(b, "online", "Ana")).to_have_count(1, timeout=10000)
        a.evaluate("BAGRENATION.idleAfter(600000)")
        step("status: ausente e invisível manuais, ausente automático sem mexer e volta ao mexer, em tempo real")

        # 3. responder: citação clicável que leva à mensagem original
        say(a, "mensagem alvo do teste")
        for i in range(4):
            say(c, f"enchendo o chat {i}")
            c.wait_for_timeout(300)
        hover_tools(b, "mensagem alvo do teste")
        T.shot(b, "54_acoes_hover")
        msg(b, "mensagem alvo do teste").locator(".msg-tools [data-act=reply]").click()
        expect(b.locator("#replyBar")).to_be_visible()
        expect(b.locator("#replyName")).to_have_text("Ana")
        T.shot(b, "55_respondendo")
        say(b, "concordo com isso")
        rep = a.locator("#chatLog .msg", has=a.locator(".msg-text", has_text="concordo com isso"))
        expect(rep.locator(".msg-reply .rp-name")).to_have_text("Ana", timeout=10000)
        expect(rep.locator(".msg-reply .rp-text")).to_have_text("mensagem alvo do teste")
        expect(b.locator("#replyBar")).to_be_hidden()
        a.locator("#chatScroll").evaluate("(el) => { el.scrollTop = el.scrollHeight; }")
        rep.locator(".msg-reply").click()
        expect(msg(a, "mensagem alvo do teste")).to_have_class(re.compile(r"\bflash\b"))
        T.shot(a, "56_resposta_e_salto")
        step("responder: barra Respondendo a Ana, citação na mensagem, clique leva e destaca a original")

        # 4. reagir: contador e quem reagiu
        hover_tools(b, "mensagem alvo do teste").locator("[data-act=react]").click()
        expect(b.locator("#reactPop")).to_be_visible()
        T.shot(b, "57_escolher_reacao")
        b.locator("#reactPop .emo-btn", has_text="🔥").click()
        chip = msg(a, "mensagem alvo do teste").locator(".react", has_text="🔥")
        expect(chip.locator("b")).to_have_text("1", timeout=10000)
        expect(chip).to_have_attribute("title", "Bruno reagiu com 🔥")
        expect(chip).to_have_attribute("aria-pressed", "false")
        chip.click()
        expect(msg(c, "mensagem alvo do teste").locator(".react", has_text="🔥").locator("b")).to_have_text("2", timeout=10000)
        expect(msg(c, "mensagem alvo do teste").locator(".react", has_text="🔥")).to_have_attribute("title", re.compile(r"^(Bruno e Ana|Ana e Bruno) reagiram com 🔥$"))
        expect(chip).to_have_attribute("aria-pressed", "true")
        msg(c, "mensagem alvo do teste").locator(".react", has_text="🔥").hover()
        T.shot(c, "58_reacoes")
        chip.click()  # Ana tira a dela
        expect(msg(c, "mensagem alvo do teste").locator(".react", has_text="🔥").locator("b")).to_have_text("1", timeout=10000)
        step("reagir: emoji com contador, quem reagiu no hover, clicar no contador soma e tira")

        # 5. copiar o texto
        hover_tools(a, "mensagem alvo do teste").locator("[data-act=copy]").click()
        assert a.evaluate("navigator.clipboard.readText()") == "mensagem alvo do teste"
        step("copiar texto vai para a área de transferência")

        # 6. editar: botão e seta para cima; só a dona vê editar/apagar
        m_b = hover_tools(b, "mensagem alvo do teste")
        expect(m_b.locator(".msg-tools [data-act=edit]")).to_be_hidden()
        expect(m_b.locator(".msg-tools [data-act=del]")).to_be_hidden()
        hover_tools(a, "mensagem alvo do teste").locator("[data-act=edit]").click()
        box = a.locator(".msg.editing .msg-edit input")
        expect(box).to_be_focused()
        T.shot(a, "59_editando")
        box.fill("mensagem alvo editada")
        box.press("Enter")
        expect(msg(b, "mensagem alvo editada").locator(".msg-edited")).to_have_text("(editada)", timeout=10000)
        expect(b.locator(".msg-reply .rp-text", has_text="mensagem alvo editada")).to_have_count(1)  # citação acompanha
        say(a, "ultima da ana")
        expect(msg(b, "ultima da ana")).to_have_count(1, timeout=10000)
        a.click("#chatInput")
        a.press("#chatInput", "ArrowUp")
        box = a.locator(".msg.editing .msg-edit input")
        expect(box).to_have_value("ultima da ana")
        box.press("Escape")  # cancelar não muda nada
        expect(a.locator(".msg.editing")).to_have_count(0)
        a.press("#chatInput", "ArrowUp")
        a.locator(".msg.editing .msg-edit input").fill("ultima da ana, corrigida")
        a.locator(".msg.editing .msg-edit input").press("Enter")
        expect(msg(c, "ultima da ana, corrigida").locator(".msg-edited")).to_have_count(1, timeout=10000)
        T.shot(c, "60_editada")
        step("editar: botão e seta para cima no campo vazio, Esc cancela, (editada) chega para todos, citação acompanha")

        # 7. apagar a própria (com confirmação); outro não consegue nem pelo servidor
        say(b, "vou apagar essa")
        expect(msg(a, "vou apagar essa")).to_have_count(1, timeout=10000)
        hover_tools(b, "vou apagar essa").locator("[data-act=del]").click()
        expect(b.locator("#delDlg")).to_be_visible()
        T.shot(b, "61_apagar_confirmar")
        b.click("#delOk")
        expect(msg(a, "vou apagar essa")).to_have_count(0, timeout=10000)
        expect(msg(c, "vou apagar essa")).to_have_count(0, timeout=10000)
        step("apagar a própria com confirmação: some para todos")

        # 8. menu no botão direito
        msg(c, "concordo com isso").click(button="right")
        expect(c.locator("#msgMenu")).to_be_visible()
        expect(c.locator("#msgMenu [data-act=edit]")).to_be_hidden()  # não é dela
        T.shot(c, "62_menu_botao_direito")
        c.locator("#msgMenu .emo-btn").first.click()
        expect(msg(b, "concordo com isso").locator(".react")).to_have_count(1, timeout=10000)
        c.fill("#nameInput", "Cristina")
        c.press("#nameInput", "Enter")
        c.locator("#chatInput").focus()
        expect(a.locator("#chatLog .msg-name", has_text="Cristina").first).to_be_visible(timeout=10000)  # nome novo nas mensagens antigas dela
        expect(a.locator("#chatLog .msg-name", has_text=re.compile(r"^Cris$"))).to_have_count(0)
        expect(member(a, "online", "Cristina")).to_have_count(1)
        c.fill("#nameInput", "Cris")
        c.press("#nameInput", "Enter")
        expect(member(a, "online", "Cris")).to_have_count(1, timeout=10000)
        step("botão direito abre o menu (reagir rápido, responder, copiar; editar/apagar só para a dona); trocar o nome atualiza lista e mensagens")

        # 9. mensagem antiga, sem autor: aparece normal e ninguém edita
        a.evaluate(OLD_MSG, [f"wss://bagrenation-chat.alissondelittig.workers.dev/s/{SRV}/ws", "mensagem de versao antiga"])
        expect(msg(b, "mensagem de versao antiga")).to_have_count(1, timeout=10000)
        old = hover_tools(b, "mensagem de versao antiga")
        expect(old.locator(".msg-tools [data-act=edit]")).to_be_hidden()
        expect(old.locator(".avatar")).not_to_have_attribute("data-st", re.compile("."))
        step("mensagem sem autor (versão antiga) aparece normal, sem editar/apagar")

        # 10. quem fecha vai para Offline e fica lá; recarregar mantém tudo
        c.context.close()
        for pg in (a, b):
            expect(member(pg, "offline", "Cris")).to_have_count(1, timeout=15000)
            expect(pg.locator("#offHead")).to_be_visible()
            expect(msg(pg, "enchendo o chat 0").locator(".avatar")).to_have_attribute("data-st", "off")  # bolinha no #chat também
        dot = "(el) => getComputedStyle(el, '::before').backgroundColor"
        assert msg(a, "enchendo o chat 0").locator(".avatar").evaluate(dot) != "rgb(57, 255, 136)", "bolinha offline pintada de verde"
        assert member(a, "online", "Bruno").locator(".avatar").evaluate(dot) == "rgb(57, 255, 136)"
        T.shot(a, "63_cris_offline")
        b.reload()
        T.connected(b)
        expect(member(b, "offline", "Cris")).to_have_count(1, timeout=15000)
        expect(msg(b, "mensagem alvo editada").locator(".msg-edited")).to_have_count(1)
        expect(msg(b, "mensagem alvo editada").locator(".react b")).to_have_text("1")
        expect(b.locator(".msg-reply .rp-name", has_text="Ana")).to_have_count(1)
        assert b.evaluate("BAGRENATION.me().uid") in uids, "recarregar trocou a identidade"
        hover_tools(b, "concordo com isso")
        step("Cris fechou: vai para Offline e continua na lista; recarregar mantém identidade, edição, reação e resposta")

        # 11. celular: lista de membros na gaveta e toque longo
        m = enter(br, url, "Cel", viewport={"width": 390, "height": 844})
        expect(msg(m, "mensagem alvo editada")).to_have_count(1, timeout=20000)
        m.evaluate(LONG_PRESS, msg(m, "concordo com isso").element_handle())
        expect(m.locator("#msgMenu")).to_be_visible()
        expect(m.locator("#msgMenu")).to_have_class(re.compile(r"\bsheet\b"))
        T.shot(m, "64_celular_toque_longo")
        m.locator("#msgMenu [data-act=reply]").click()
        expect(m.locator("#replyBar")).to_be_visible()
        m.click("#replyX")
        m.locator("#chatInput").focus()
        m.keyboard.type("digitando no cel", delay=40)
        expect(a.locator("#typing")).to_have_text(re.compile(r"Cel está digitando"), timeout=8000)
        T.shot(m, "65_celular_chat")
        m.click("#chanBtn")
        expect(m.locator("#panel")).to_be_visible()
        expect(member(m, "offline", "Cris")).to_have_count(1)
        T.shot(m, "66_celular_membros")
        assert m.evaluate("document.documentElement.scrollWidth <= innerWidth"), "rolagem para o lado no celular"
        step("celular: toque longo abre o menu em folha, responder, digitando chega no PC, membros na gaveta")
        br.close()
    assert not T.errors, "erros de console:\n" + "\n".join(T.errors)
    print(f"MEMBROS OK ({len(steps)} passos), 0 erro de console, servidor de teste {SRV}")


if __name__ == "__main__":
    shots = pathlib.Path(sys.argv[2]) if len(sys.argv) > 2 else None
    if len(sys.argv) > 1 and sys.argv[1].startswith("http"):
        run(sys.argv[1], shots)
    else:
        h = functools.partial(type("Q", (http.server.SimpleHTTPRequestHandler,), {"log_message": lambda *a: None}), directory=str(T.ROOT))
        srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), h)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        run(f"http://127.0.0.1:{srv.server_address[1]}/", shots)
