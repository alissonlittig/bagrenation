// Bagre DJ no app (S-1580): acha o endereço do áudio de um vídeo com o yt-dlp e devolve para a página tocar
// num <audio> (sem player de vídeo). O yt-dlp não vem junto do app: no 1º uso o app baixa a release oficial
// (github.com/yt-dlp/yt-dlp, yt-dlp_win.zip, a versão em pasta, que abre bem mais rápido que o .exe único) para a
// pasta de dados do app, confere o SHA-256 contra o SHA2-256SUMS da mesma release e extrai com o tar.exe do Windows.
// Se falhar (o YouTube mudou), baixa a release mais nova 1 vez e tenta de novo; se ainda falhar, a página cai no
// player oficial. O endereço é preso ao IP deste PC: cada um resolve o seu; o servidor só guarda o id do vídeo.
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering::Relaxed};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};

const NO_WINDOW: u32 = 0x0800_0000; // CREATE_NO_WINDOW: nada de janela de console piscando
const REL: &str = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/";
const ZIP: &str = "yt-dlp_win.zip";
static SETUP: Mutex<()> = Mutex::new(());
static UPDATED: AtomicBool = AtomicBool::new(false);

fn run(cmd: &mut Command, secs: u64) -> Result<String, String> {
    let mut child = cmd.creation_flags(NO_WINDOW).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped())
        .spawn().map_err(|e| e.to_string())?;
    let end = Instant::now() + Duration::from_secs(secs);
    while child.try_wait().map_err(|e| e.to_string())?.is_none() {
        if Instant::now() > end {
            let _ = child.kill();
            let _ = child.wait();
            return Err("demorou demais".into());
        }
        std::thread::sleep(Duration::from_millis(30));
    }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        let err = String::from_utf8_lossy(&out.stderr);
        Err(err.lines().filter(|l| l.contains("ERROR")).last().unwrap_or(err.trim()).chars().take(300).collect())
    }
}

fn curl(url: &str, to: &Path) -> Result<(), String> { // curl.exe vem no Windows 10/11
    run(Command::new("curl.exe").args(["-sSfL", "--max-time", "180", "-o"]).arg(to).arg(url), 190).map(|_| ())
}

// Baixa a release mais nova se ainda não tem (ou se `fresh` e a do GitHub é outra). Cada versão fica na própria pasta
// (<sha>/), e `atual` diz qual vale: uma busca em andamento nunca perde o programa no meio da troca.
fn ensure(root: &Path, fresh: bool) -> Result<PathBuf, String> {
    let _one = SETUP.lock().unwrap_or_else(|e| e.into_inner()); // dois pedidos no 1º uso não baixam duas vezes
    let cur = std::fs::read_to_string(root.join("atual")).unwrap_or_default().trim().to_owned();
    let exe_of = |h: &str| root.join(h).join("yt-dlp.exe");
    if !fresh && !cur.is_empty() && exe_of(&cur).exists() {
        return Ok(exe_of(&cur));
    }
    std::fs::create_dir_all(root).map_err(|e| e.to_string())?;
    let (zip, sums) = (root.join("baixando.zip"), root.join("SHA2-256SUMS"));
    curl(&format!("{REL}SHA2-256SUMS"), &sums)?;
    let want = std::fs::read_to_string(&sums).map_err(|e| e.to_string())?.lines()
        .find_map(|l| l.strip_suffix(&format!(" {ZIP}")).map(|h| h.trim().to_lowercase()))
        .ok_or("SHA2-256SUMS sem yt-dlp_win.zip")?;
    let h = want.get(..16).ok_or("SHA-256 curto")?.to_owned();
    if exe_of(&h).exists() {
        if h == cur && fresh {
            return Err("o yt-dlp já é o mais novo".into());
        }
    } else {
        curl(&format!("{REL}{ZIP}"), &zip)?;
        let got = format!("{:x}", Sha256::digest(std::fs::read(&zip).map_err(|e| e.to_string())?));
        if got != want {
            let _ = std::fs::remove_file(&zip);
            return Err("yt-dlp baixado não confere com o SHA-256 da release".into());
        }
        let tmp = root.join(format!("{h}.part"));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
        run(Command::new("tar.exe").arg("-xf").arg(&zip).arg("-C").arg(&tmp), 120)?;
        let _ = std::fs::remove_file(&zip);
        if !tmp.join("yt-dlp.exe").exists() {
            return Err("o zip do yt-dlp veio sem yt-dlp.exe".into());
        }
        std::fs::rename(&tmp, root.join(&h)).map_err(|e| e.to_string())?;
    }
    std::fs::write(root.join("atual"), &h).map_err(|e| e.to_string())?;
    if !cur.is_empty() && cur != h {
        let _ = std::fs::remove_dir_all(root.join(&cur)); // versão velha; se estiver em uso, fica para a próxima troca
    }
    Ok(exe_of(&h))
}

fn resolve(exe: &Path, id: &str) -> Result<String, String> {
    let out = run(Command::new(exe).args(["-f", "bestaudio", "-g", "--no-playlist", "--no-warnings", "--no-progress", "--"])
        .arg(format!("https://www.youtube.com/watch?v={id}")), 40)?;
    out.lines().find(|l| l.starts_with("https://")).map(str::to_owned).ok_or_else(|| "sem endereço de áudio".into())
}

#[tauri::command]
pub async fn dj_audio(app: AppHandle, id: String) -> Result<String, String> {
    if id.len() != 11 || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') {
        return Err("id inválido".into());
    }
    let root = app.path().app_local_data_dir().map_err(|e| e.to_string())?.join("yt-dlp");
    tauri::async_runtime::spawn_blocking(move || {
        let exe = ensure(&root, false)?;
        match resolve(&exe, &id) {
            Ok(u) => Ok(u),
            Err(e) if e.contains("Video unavailable") || e.contains("Private video") => Err(e), // o vídeo é que não existe: atualizar não ajuda
            Err(e) => {
                if UPDATED.swap(true, Relaxed) {
                    return Err(e);
                }
                match ensure(&root, true) {
                    Ok(new) => resolve(&new, &id),
                    Err(_) => Err(e),
                }
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?
}
