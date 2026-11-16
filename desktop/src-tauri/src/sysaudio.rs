// Som do PC para a tela compartilhada SEM a voz do BAGRENATION (S-1354).
// O som do sistema que o navegador captura leva tudo, inclusive a voz dos amigos que o app está tocando:
// quem assiste se escuta de volta. Aqui o Windows (10 2004+) captura o som de todos os processos
// MENOS a árvore do WebView2 deste app (process loopback, modo EXCLUDE_TARGET_PROCESS_TREE). O WebView2 toca o
// áudio no serviço de áudio dele (msedgewebview2 --utility-sub-type=audio), neto deste exe. Medido no S-1354: o
// Windows NÃO liga esse neto à árvore deste exe (excluindo o próprio app a voz vazava inteira), mas liga à árvore
// do processo principal do WebView2 (filho direto deste exe). Então o alvo é esse filho.
// Sai PCM 16 bits, 48 kHz, estéreo, em blocos de 20 ms pelo canal do Tauri; a página monta a faixa.
use std::sync::atomic::{AtomicU32, Ordering::SeqCst};

use tauri::ipc::{Channel, InvokeResponseBody};
use windows::core::{implement, Interface, Ref, Result};
use windows::Win32::Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0};
use windows::Win32::Media::Audio::*;
use windows::Win32::System::Com::StructuredStorage::{PROPVARIANT, PROPVARIANT_0, PROPVARIANT_0_0, PROPVARIANT_0_0_0};
use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, BLOB, COINIT_MULTITHREADED};
use windows::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS};
use windows::Win32::System::Threading::{CreateEventW, GetCurrentProcessId, SetEvent, WaitForSingleObject};
use windows::Win32::System::Variant::VT_BLOB;

static GEN: AtomicU32 = AtomicU32::new(0); // cada start/stop troca a geração; a captura antiga para sozinha

#[implement(IActivateAudioInterfaceCompletionHandler)]
struct Done(HANDLE);
impl IActivateAudioInterfaceCompletionHandler_Impl for Done_Impl {
    fn ActivateCompleted(&self, _op: Ref<'_, IActivateAudioInterfaceAsyncOperation>) -> Result<()> {
        unsafe { SetEvent(self.0) }
    }
}

const RATE: u32 = 48_000;
const CHUNK: usize = (RATE as usize / 50) * 4; // 20 ms de estéreo 16 bits

/// Processo principal do WebView2 deste app (msedgewebview2.exe filho direto deste exe).
unsafe fn webview_pid() -> Option<u32> {
    let me = GetCurrentProcessId();
    let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0).ok()?;
    let mut e = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
    let mut found = None;
    let mut more = Process32FirstW(snap, &mut e).is_ok();
    while more {
        let name = String::from_utf16_lossy(&e.szExeFile[..e.szExeFile.iter().position(|&c| c == 0).unwrap_or(e.szExeFile.len())]);
        if e.th32ParentProcessID == me && name.eq_ignore_ascii_case("msedgewebview2.exe") {
            found = Some(e.th32ProcessID);
            break;
        }
        more = Process32NextW(snap, &mut e).is_ok();
    }
    let _ = CloseHandle(snap);
    found
}

unsafe fn open() -> Result<(IAudioClient, IAudioCaptureClient, HANDLE)> {
    let target = webview_pid().ok_or_else(|| windows::core::Error::new(windows::core::HRESULT(0x8000_4005u32 as i32), "processo do WebView2 não encontrado"))?;
    let mut params = AUDIOCLIENT_ACTIVATION_PARAMS {
        ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
        Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
            ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
                TargetProcessId: target,
                ProcessLoopbackMode: PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE,
            },
        },
    };
    // ManuallyDrop: o Drop do PROPVARIANT do windows-rs chama PropVariantClear, que liberaria o blob (está na pilha)
    let prop = std::mem::ManuallyDrop::new(PROPVARIANT {
        Anonymous: PROPVARIANT_0 {
            Anonymous: std::mem::ManuallyDrop::new(PROPVARIANT_0_0 {
                vt: VT_BLOB,
                Anonymous: PROPVARIANT_0_0_0 {
                    blob: BLOB { cbSize: std::mem::size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>() as u32, pBlobData: &mut params as *mut _ as *mut u8 },
                },
                ..Default::default()
            }),
        },
    });
    let done = CreateEventW(None, false, false, None)?;
    let handler: IActivateAudioInterfaceCompletionHandler = Done(done).into();
    let op = ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, &IAudioClient::IID, Some(&*prop), &handler)?;
    let waited = WaitForSingleObject(done, 5000);
    let _ = CloseHandle(done);
    if waited != WAIT_OBJECT_0 {
        return Err(windows::core::Error::new(windows::core::HRESULT(0x8000_000Au32 as i32), "ativação do áudio demorou"));
    }
    let mut hr = windows::core::HRESULT(0);
    let mut iface = None;
    op.GetActivateResult(&mut hr, &mut iface)?;
    hr.ok()?;
    let client: IAudioClient = iface.unwrap().cast()?;
    // process loopback não tem GetMixFormat: pede o formato e o Windows converte
    let fmt = WAVEFORMATEX { wFormatTag: WAVE_FORMAT_PCM as u16, nChannels: 2, nSamplesPerSec: RATE, nAvgBytesPerSec: RATE * 4, nBlockAlign: 4, wBitsPerSample: 16, cbSize: 0 };
    client.Initialize(
        AUDCLNT_SHAREMODE_SHARED,
        AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
        200_000, // 20 ms (unidade de 100 ns)
        0,
        &fmt,
        None,
    )?;
    let ev = CreateEventW(None, false, false, None)?;
    client.SetEventHandle(ev)?;
    let cap: IAudioCaptureClient = client.GetService()?;
    Ok((client, cap, ev))
}

fn run(gen: u32, out: Channel<InvokeResponseBody>, ready: std::sync::mpsc::Sender<std::result::Result<(), String>>) {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let (client, cap, ev) = match open().and_then(|o| o.0.Start().map(|_| o)) {
            Ok(o) => o,
            Err(e) => { let _ = ready.send(Err(e.to_string())); CoUninitialize(); return; }
        };
        let _ = ready.send(Ok(()));
        let mut buf: Vec<u8> = Vec::with_capacity(CHUNK * 2);
        'outer: while GEN.load(SeqCst) == gen {
            WaitForSingleObject(ev, 100); // sem nada tocando o Windows não manda pacote: a página completa com silêncio
            loop {
                match cap.GetNextPacketSize() { Ok(0) => break, Ok(_) => {}, Err(_) => break 'outer }
                let (mut data, mut frames, mut flags) = (std::ptr::null_mut(), 0u32, 0u32);
                if cap.GetBuffer(&mut data, &mut frames, &mut flags, None, None).is_err() { break 'outer; }
                let n = frames as usize * 4;
                if flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0 || data.is_null() {
                    buf.resize(buf.len() + n, 0);
                } else {
                    buf.extend_from_slice(std::slice::from_raw_parts(data, n));
                }
                let _ = cap.ReleaseBuffer(frames);
            }
            while buf.len() >= CHUNK {
                let rest = buf.split_off(CHUNK);
                if out.send(InvokeResponseBody::Raw(std::mem::replace(&mut buf, rest))).is_err() { break 'outer; } // página fechou
            }
        }
        let _ = client.Stop();
        let _ = CloseHandle(ev);
        CoUninitialize();
    }
}

/// Liga a captura do som do PC (sem o BAGRENATION). Responde só depois de abrir, para a página saber se deu.
#[tauri::command]
pub async fn sys_audio_start(on_chunk: Channel<InvokeResponseBody>) -> std::result::Result<(), String> {
    let gen = GEN.fetch_add(1, SeqCst) + 1;
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || run(gen, on_chunk, tx));
    rx.recv().map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn sys_audio_stop() {
    GEN.fetch_add(1, SeqCst);
}
