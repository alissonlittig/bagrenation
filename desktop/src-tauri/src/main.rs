// BAGRENATION para PC: a mesma página do site (../dist, copiada de ../../) dentro do WebView2,
// mais o que o navegador não consegue fazer: tecla global (push-to-talk e mutar com o jogo em foco),
// ícone na bandeja, abrir com o Windows, aviso de quem entra e atualização pelo GitHub Releases.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering::Relaxed};
use std::sync::{mpsc, OnceLock};
use std::time::Duration;

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, WindowEvent, Wry};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt as _};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_updater::UpdaterExt;
use windows::Win32::Foundation::{HINSTANCE, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::WindowsAndMessaging::*;

// ---------- tecla global (gancho de baixo nível: vê a tecla com qualquer janela em foco, inclusive jogo
// em tela cheia, e NÃO a consome: o jogo continua recebendo a tecla, como no Discord) ----------
// Código interno: teclado = scan code | 0x100 se estendida (independe do layout, igual ao KeyboardEvent.code);
// mouse = 0x1000 | botão (3 meio, 4 e 5 laterais). 0 = nenhuma.
static PTT: AtomicU32 = AtomicU32::new(0);
static MUTE: AtomicU32 = AtomicU32::new(0);
static PTT_DOWN: AtomicBool = AtomicBool::new(false);
static MUTE_DOWN: AtomicBool = AtomicBool::new(false);
static HOOK_THREAD: AtomicU32 = AtomicU32::new(0);
static TX: OnceLock<mpsc::Sender<Hk>> = OnceLock::new();
const WM_SYNC: u32 = WM_APP + 1;

enum Hk {
    Ptt(bool),
    Mute,
}

fn code_of(code: &str) -> Option<u32> {
    if code.is_empty() {
        return Some(0);
    }
    const LETTERS: &str = "QWERTYUIOP";
    const ROW2: &str = "ASDFGHJKL";
    const ROW3: &str = "ZXCVBNM";
    if let Some(l) = code.strip_prefix("Key") {
        for (row, base) in [(LETTERS, 0x10), (ROW2, 0x1E), (ROW3, 0x2C)] {
            if let Some(i) = row.find(l).filter(|_| l.len() == 1) {
                return Some(base + i as u32);
            }
        }
        return None;
    }
    if let Some(d) = code.strip_prefix("Digit").and_then(|d| d.parse::<u32>().ok()) {
        return Some(if d == 0 { 0x0B } else { 0x01 + d });
    }
    if let Some(n) = code.strip_prefix('F').and_then(|n| n.parse::<u32>().ok()) {
        return match n {
            1..=10 => Some(0x3A + n),
            11 => Some(0x57),
            12 => Some(0x58),
            13..=23 => Some(0x64 + n - 13),
            24 => Some(0x76),
            _ => None,
        };
    }
    let e = 0x100; // tecla estendida (prefixo E0)
    Some(match code {
        "Escape" => 0x01, "Minus" => 0x0C, "Equal" => 0x0D, "Backspace" => 0x0E, "Tab" => 0x0F,
        "BracketLeft" => 0x1A, "BracketRight" => 0x1B, "Enter" => 0x1C, "ControlLeft" => 0x1D,
        "Semicolon" => 0x27, "Quote" => 0x28, "Backquote" => 0x29, "ShiftLeft" => 0x2A, "Backslash" => 0x2B,
        "Comma" => 0x33, "Period" => 0x34, "Slash" => 0x35, "ShiftRight" => 0x36, "NumpadMultiply" => 0x37,
        "AltLeft" => 0x38, "Space" => 0x39, "CapsLock" => 0x3A, "ScrollLock" => 0x46,
        "Numpad7" => 0x47, "Numpad8" => 0x48, "Numpad9" => 0x49, "NumpadSubtract" => 0x4A,
        "Numpad4" => 0x4B, "Numpad5" => 0x4C, "Numpad6" => 0x4D, "NumpadAdd" => 0x4E,
        "Numpad1" => 0x4F, "Numpad2" => 0x50, "Numpad3" => 0x51, "Numpad0" => 0x52, "NumpadDecimal" => 0x53,
        "IntlBackslash" => 0x56, "IntlRo" => 0x73,
        "NumpadEnter" => e | 0x1C, "ControlRight" => e | 0x1D, "NumpadDivide" => e | 0x35, "AltRight" => e | 0x38,
        "Home" => e | 0x47, "ArrowUp" => e | 0x48, "PageUp" => e | 0x49, "ArrowLeft" => e | 0x4B,
        "ArrowRight" => e | 0x4D, "End" => e | 0x4F, "ArrowDown" => e | 0x50, "PageDown" => e | 0x51,
        "Insert" => e | 0x52, "Delete" => e | 0x53, "MetaLeft" => e | 0x5B, "MetaRight" => e | 0x5C,
        "ContextMenu" => e | 0x5D,
        "Mouse3" => 0x1003, "Mouse4" => 0x1004, "Mouse5" => 0x1005,
        _ => return None,
    })
}

fn on_input(code: u32, down: bool) {
    let tx = TX.get().unwrap();
    if code == PTT.load(Relaxed) && PTT_DOWN.swap(down, Relaxed) != down {
        let _ = tx.send(Hk::Ptt(down));
    }
    if code == MUTE.load(Relaxed) && MUTE_DOWN.swap(down, Relaxed) != down && down {
        let _ = tx.send(Hk::Mute);
    }
}

unsafe extern "system" fn kb_proc(n: i32, w: WPARAM, l: LPARAM) -> LRESULT {
    if n >= 0 {
        let k = &*(l.0 as *const KBDLLHOOKSTRUCT);
        let ext = if k.flags.0 & LLKHF_EXTENDED.0 != 0 { 0x100 } else { 0 };
        on_input((k.scanCode & 0xFF) | ext, matches!(w.0 as u32, WM_KEYDOWN | WM_SYSKEYDOWN));
    }
    CallNextHookEx(None, n, w, l)
}

unsafe extern "system" fn mouse_proc(n: i32, w: WPARAM, l: LPARAM) -> LRESULT {
    if n >= 0 {
        let m = &*(l.0 as *const MSLLHOOKSTRUCT);
        let msg = w.0 as u32;
        let btn = match msg {
            WM_MBUTTONDOWN | WM_MBUTTONUP => 3,
            WM_XBUTTONDOWN | WM_XBUTTONUP => if (m.mouseData >> 16) & 0xFFFF == 1 { 4 } else { 5 },
            _ => 0,
        };
        if btn != 0 {
            on_input(0x1000 | btn, matches!(msg, WM_MBUTTONDOWN | WM_XBUTTONDOWN));
        }
    }
    CallNextHookEx(None, n, w, l)
}

// Os ganchos só existem enquanto há tecla configurada; o de mouse, só se a tecla for botão do mouse
// (gancho de mouse passa por todo movimento, e jogo mexe o mouse mil vezes por segundo).
fn hook_thread(app: AppHandle) {
    let (tx, rx) = mpsc::channel::<Hk>();
    TX.set(tx).ok();
    std::thread::spawn(move || {
        for ev in rx {
            let _ = match ev {
                Hk::Ptt(down) => app.emit("ptt", down),
                Hk::Mute => app.emit("hotkey-mute", ()),
            };
        }
    });
    std::thread::spawn(|| unsafe {
        HOOK_THREAD.store(GetCurrentThreadId(), Relaxed);
        let hmod = GetModuleHandleW(None).ok().map(|h| HINSTANCE(h.0));
        let (mut kb, mut mouse): (Option<HHOOK>, Option<HHOOK>) = (None, None);
        let mut msg = MSG::default();
        loop {
            let want = [PTT.load(Relaxed), MUTE.load(Relaxed)];
            let want_kb = want.iter().any(|&c| c != 0 && c < 0x1000);
            let want_mouse = want.iter().any(|&c| c >= 0x1000);
            if want_kb != kb.is_some() {
                kb = match kb.take() {
                    Some(h) => { let _ = UnhookWindowsHookEx(h); None }
                    None => SetWindowsHookExW(WH_KEYBOARD_LL, Some(kb_proc), hmod, 0).ok(),
                };
            }
            if want_mouse != mouse.is_some() {
                mouse = match mouse.take() {
                    Some(h) => { let _ = UnhookWindowsHookEx(h); None }
                    None => SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_proc), hmod, 0).ok(),
                };
            }
            // espera mensagens (os ganchos de baixo nível rodam dentro deste GetMessage)
            loop {
                if !GetMessageW(&mut msg, None, 0, 0).as_bool() {
                    return;
                }
                if msg.message == WM_SYNC {
                    break;
                }
            }
        }
    });
}

#[tauri::command]
fn set_keys(ptt: String, mute: String) -> Result<(), String> {
    let p = code_of(&ptt).ok_or_else(|| format!("tecla não suportada: {ptt}"))?;
    let m = code_of(&mute).ok_or_else(|| format!("tecla não suportada: {mute}"))?;
    if p != PTT.swap(p, Relaxed) {
        PTT_DOWN.store(false, Relaxed);
    }
    if m != MUTE.swap(m, Relaxed) {
        MUTE_DOWN.store(false, Relaxed);
    }
    let t = HOOK_THREAD.load(Relaxed);
    if t != 0 {
        unsafe { let _ = PostThreadMessageW(t, WM_SYNC, WPARAM(0), LPARAM(0)); }
    }
    Ok(())
}

// ---------- bandeja ----------
struct Tray {
    mute: CheckMenuItem<Wry>,
    deaf: CheckMenuItem<Wry>,
}

#[tauri::command]
fn tray_state(app: AppHandle, in_room: bool, muted: bool, deaf: bool) {
    let t = app.state::<Tray>();
    for (item, on) in [(&t.mute, muted), (&t.deaf, deaf)] {
        let _ = item.set_enabled(in_room);
        let _ = item.set_checked(in_room && on);
    }
    if let Some(tray) = app.tray_by_id("tray") {
        let tip = if !in_room { "BAGRENATION" } else if deaf { "BAGRENATION · som desligado" } else if muted { "BAGRENATION · microfone mudo" } else { "BAGRENATION · na voz" };
        let _ = tray.set_tooltip(Some(tip));
    }
}

#[tauri::command]
fn notify(app: AppHandle, body: String) {
    let _ = app.notification().builder().title("BAGRENATION").body(body).show();
}

#[tauri::command]
fn autostart(app: AppHandle, on: Option<bool>) -> Result<bool, String> {
    let a = app.autolaunch();
    match on {
        Some(true) => a.enable().map_err(|e| e.to_string())?,
        Some(false) => a.disable().map_err(|e| e.to_string())?,
        None => {}
    }
    a.is_enabled().map_err(|e| e.to_string())
}

#[tauri::command]
fn quit_now(app: AppHandle) {
    app.exit(0);
}

static VISIBLE: AtomicBool = AtomicBool::new(true);
#[tauri::command]
fn is_visible() -> bool {
    VISIBLE.load(Relaxed)
}
fn set_visible(app: &AppHandle, on: bool) {
    if VISIBLE.swap(on, Relaxed) != on {
        let _ = app.emit("visible", on); // a página pausa as animações quando ninguém está vendo
    }
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        set_visible(app, true);
    }
}

// Sair: a página avisa a sala ("bye") e chama quit_now; se travar, fecha assim mesmo.
fn quit(app: &AppHandle) {
    let _ = app.emit("quit", ());
    let a = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(1500));
        a.exit(0);
    });
}

fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Abrir BAGRENATION", true, None::<&str>)?;
    let mute = CheckMenuItem::with_id(app, "mute", "Microfone mudo", false, false, None::<&str>)?;
    let deaf = CheckMenuItem::with_id(app, "deaf", "Som desligado (ensurdecer)", false, false, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "Sair", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[
        &show,
        &PredefinedMenuItem::separator(app)?,
        &mute,
        &deaf,
        &PredefinedMenuItem::separator(app)?,
        &quit_item,
    ])?;
    TrayIconBuilder::with_id("tray")
        .icon(app.default_window_icon().unwrap().clone())
        .tooltip("BAGRENATION")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, ev| match ev.id().as_ref() {
            "show" => show_main(app),
            "quit" => quit(app),
            id @ ("mute" | "deaf") => { let _ = app.emit("tray", id); }
            _ => {}
        })
        .on_tray_icon_event(|tray, ev| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = ev {
                show_main(tray.app_handle());
            }
        })
        .build(app)?;
    app.manage(Tray { mute, deaf });
    Ok(())
}

// ---------- WebView2: microfone liberado sem pergunta (só esta página roda aqui) ----------
fn allow_mic(w: &tauri::WebviewWindow) {
    let _ = w.with_webview(|wv| unsafe {
        use webview2_com::Microsoft::Web::WebView2::Win32::*;
        use webview2_com::PermissionRequestedEventHandler;
        let Ok(core) = wv.controller().CoreWebView2() else { return };
        let mut token = Default::default();
        let _ = core.add_PermissionRequested(
            &PermissionRequestedEventHandler::create(Box::new(|_, args| {
                if let Some(args) = args {
                    let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
                    args.PermissionKind(&mut kind)?;
                    if kind == COREWEBVIEW2_PERMISSION_KIND_MICROPHONE {
                        args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW)?;
                    }
                }
                Ok(())
            })),
            &mut token,
        );
    });
}

// ---------- atualização: confere o GitHub Releases ao abrir ----------
async fn check_update(app: AppHandle) {
    let Ok(updater) = app.updater() else { return };
    let update = match updater.check().await {
        Ok(Some(u)) => u,
        Ok(None) => return,
        Err(e) => { eprintln!("BAGRENATION: atualização não conferida: {e}"); return; }
    };
    let a = app.clone();
    app.dialog()
        .message(format!("Saiu a versão {} do BAGRENATION (você está na {}). Atualizar agora? Leva uns segundos e o app abre de novo.", update.version, update.current_version))
        .title("Atualização")
        .buttons(MessageDialogButtons::OkCancelCustom("Atualizar".into(), "Depois".into()))
        .show(move |ok| {
            if !ok { return; }
            tauri::async_runtime::spawn(async move {
                match update.download_and_install(|_, _| {}, || {}).await {
                    Ok(()) => a.restart(),
                    Err(e) => { let _ = a.notification().builder().title("BAGRENATION").body(format!("A atualização falhou: {e}")).show(); }
                }
            });
        });
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| show_main(app)))
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec!["--minimized"])))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![set_keys, tray_state, notify, autostart, quit_now, is_visible])
        .setup(|app| {
            build_tray(app)?;
            hook_thread(app.handle().clone());
            let w = app.get_webview_window("main").unwrap();
            allow_mic(&w);
            if std::env::args().any(|a| a == "--minimized") {
                VISIBLE.store(false, Relaxed); // aberto com o Windows: fica só na bandeja
            } else {
                w.show()?;
            }
            tauri::async_runtime::spawn(check_update(app.handle().clone()));
            Ok(())
        })
        .on_window_event(|w, ev| match ev {
            WindowEvent::CloseRequested { api, .. } => {
                // o X manda para a bandeja (a voz continua); sair de vez é pelo menu da bandeja
                api.prevent_close();
                let _ = w.hide();
                set_visible(w.app_handle(), false);
                static TOLD: AtomicBool = AtomicBool::new(false);
                if !TOLD.swap(true, Relaxed) {
                    notify(w.app_handle().clone(), "Continuo aberto na bandeja, perto do relógio. Para fechar de vez: botão direito no ícone > Sair.".into());
                }
            }
            WindowEvent::Resized(_) => {
                let on = w.is_visible().unwrap_or(true) && !w.is_minimized().unwrap_or(false);
                set_visible(w.app_handle(), on);
            }
            _ => {}
        })
        .run(tauri::generate_context!())
        .expect("BAGRENATION não abriu");
}
