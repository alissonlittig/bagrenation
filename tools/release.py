"""Publica a Release do BAGRENATION com os DOIS apps: Windows (instalador + .sig + latest.json do updater) e Android (APK).
Uso: python tools/release.py <versao> <commit> <notas.md> [--build]
  --build   compila antes: desktop (tools/build_desktop.sh) e Android (mobile/: montar + cap sync + gradle assembleRelease)
Assets de toda release:
  BAGRENATION_<ver>_x64-setup.exe (+ .sig)  instalador do Windows (o updater do app de PC lê latest.json)
  latest.json                                updater do desktop (mesmo formato das versões 1.7/1.8: não quebra o update)
  BAGRENATION_<ver>.apk e BAGRENATION.apk    Android; o link fixo .../releases/latest/download/BAGRENATION.apk baixa sempre o último
  SHA256SUMS.txt                             sha256 dos dois instaladores
Token: Git Credential Manager (nunca impresso). Chave do APK: C:\\SISTEMA\\chaves\\bagrenation\\android (fora do repo).
Release com a mesma tag já existente: reaproveita e troca os assets (rodar de novo não duplica)."""
import datetime, hashlib, json, os, pathlib, re, subprocess, sys, urllib.error, urllib.request

REPO = "alissonlittig/bagrenation"
ROOT = pathlib.Path(__file__).resolve().parents[1]
NSIS = ROOT / "desktop" / "src-tauri" / "target" / "release" / "bundle" / "nsis"
APK = ROOT / "mobile" / "android" / "app" / "build" / "outputs" / "apk" / "release" / "app-release.apk"
JAVA_HOME = r"C:\SISTEMA_ANTIGO\kit\android\jdk"
SDK = r"C:\SISTEMA_ANTIGO\kit\android\sdk"


def fim(ok, **kw):
    print("RESULTADO", json.dumps({"ok": ok, **kw}, ensure_ascii=False))
    sys.exit(0 if ok else 1)


def versoes():
    conf = json.loads((ROOT / "desktop" / "src-tauri" / "tauri.conf.json").read_text(encoding="utf-8"))["version"]
    gradle = (ROOT / "mobile" / "android" / "app" / "build.gradle").read_text(encoding="utf-8")
    apk = re.search(r"bagreVersionName'\) \?: '([^']+)'", gradle).group(1)
    return conf, apk


def build():
    r = subprocess.run(["bash", str(ROOT / "tools" / "build_desktop.sh")], cwd=ROOT)
    if r.returncode: fim(False, erro="build do desktop falhou", rc=r.returncode)
    mob = ROOT / "mobile"
    for cmd in (["node", "montar.mjs"], ["npx.cmd", "cap", "sync", "android"]):
        r = subprocess.run(cmd, cwd=mob)
        if r.returncode: fim(False, erro=f"{' '.join(cmd)} falhou", rc=r.returncode)
    (mob / "android" / "local.properties").write_text("sdk.dir=" + SDK.replace("\\", "/").replace(":", "\\:") + "\n")
    r = subprocess.run(["cmd", "/c", "gradlew.bat", "assembleRelease", "--no-daemon"], cwd=mob / "android", env=dict(os.environ, JAVA_HOME=JAVA_HOME))
    if r.returncode: fim(False, erro="gradle assembleRelease falhou", rc=r.returncode)


def main():
    if len(sys.argv) < 4: fim(False, erro=__doc__)
    ver, commit, notes_file = sys.argv[1], sys.argv[2], sys.argv[3]
    if "--build" in sys.argv: build()
    vd, va = versoes()
    if vd != ver or va != ver: fim(False, erro=f"versão diferente: pedido {ver}, desktop {vd}, android {va}")
    exe = NSIS / f"BAGRENATION_{ver}_x64-setup.exe"
    sigf = NSIS / f"{exe.name}.sig"
    if not exe.exists() or not sigf.exists(): fim(False, erro=f"falta o instalador do Windows {exe.name} (+.sig): rode com --build")
    if not APK.exists(): fim(False, erro="falta o APK assinado: rode com --build")
    # S-0069: o APK da release busca a atualização só no GitHub (o build de teste aponta para 127.0.0.1 e nunca pode subir)
    import zipfile
    with zipfile.ZipFile(APK) as z:
        dex = b"".join(z.read(n) for n in z.namelist() if n.endswith(".dex"))
    if b"api.github.com/repos/alissonlittig/bagrenation/releases/latest" not in dex or b"127.0.0.1:8799" in dex:
        fim(False, erro="APK com endereço de atualização de teste: rode o build de novo sem -PbagreUpd*")
    if APK.stat().st_mtime < exe.stat().st_mtime - 6 * 3600: fim(False, erro="APK muito mais velho que o instalador do Windows: rode com --build")
    sig = sigf.read_text().strip()
    out = subprocess.run(["git", "credential", "fill"], input="protocol=https\nhost=github.com\n\n", capture_output=True, text=True,
                         timeout=30, env=dict(os.environ, GCM_INTERACTIVE="never")).stdout
    token = dict(l.split("=", 1) for l in out.splitlines() if "=" in l)["password"]

    def api(method, url, data=None, ctype="application/json"):
        body = json.dumps(data).encode() if isinstance(data, dict) else data
        r = urllib.request.Request(url, body, method=method, headers={
            "Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json", "Content-Type": ctype, "User-Agent": "bagrenation-release"})
        try:
            with urllib.request.urlopen(r, timeout=600) as resp:
                return resp.status, json.loads(resp.read() or b"{}")
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or b"{}")

    name = exe.name
    dl = f"https://github.com/{REPO}/releases/download/v{ver}/{name}"
    latest = {"version": ver, "notes": f"BAGRENATION {ver}", "pub_date": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
              "platforms": {"windows-x86_64": {"signature": sig, "url": dl}}}
    exe_b, apk_b = exe.read_bytes(), APK.read_bytes()
    sha_exe, sha_apk = hashlib.sha256(exe_b).hexdigest(), hashlib.sha256(apk_b).hexdigest()
    body = pathlib.Path(notes_file).read_text(encoding="utf-8").replace("{SHA}", sha_exe).replace("{SHA_APK}", sha_apk).replace("{VER}", ver)
    st, rel = api("GET", f"https://api.github.com/repos/{REPO}/releases/tags/v{ver}")
    if st == 404:
        st, rel = api("POST", f"https://api.github.com/repos/{REPO}/releases", {
            "tag_name": f"v{ver}", "target_commitish": commit, "name": f"BAGRENATION {ver} (Windows e Android)", "body": body, "make_latest": "true"})
    else:
        st, rel = api("PATCH", rel["url"], {"name": f"BAGRENATION {ver} (Windows e Android)", "body": body, "make_latest": "true"})
    if st not in (200, 201): fim(False, erro="GitHub recusou a release", st=st, resp=rel)
    up = rel["upload_url"].split("{")[0]
    assets = [(name, exe_b, "application/octet-stream"), (name + ".sig", sig.encode(), "text/plain"),
              ("latest.json", json.dumps(latest, indent=2).encode(), "application/json"),
              (f"BAGRENATION_{ver}.apk", apk_b, "application/vnd.android.package-archive"),
              ("BAGRENATION.apk", apk_b, "application/vnd.android.package-archive"),
              ("SHA256SUMS.txt", f"{sha_exe}  {name}\n{sha_apk}  BAGRENATION_{ver}.apk\n{sha_apk}  BAGRENATION.apk\n".encode(), "text/plain")]
    velhos = {a["name"]: a for a in rel.get("assets", [])}
    for fname, data, ct in assets:
        if fname in velhos: api("DELETE", velhos[fname]["url"])
        s2, a = api("POST", f"{up}?name={fname}", data, ct)
        if s2 not in (200, 201): fim(False, erro=f"upload {fname} falhou", st=s2, resp=a)
        print("asset", a["name"], a["size"])
    st, lat = api("GET", f"https://api.github.com/repos/{REPO}/releases/latest")
    fim(lat.get("tag_name") == f"v{ver}", release=rel["html_url"], latest=lat.get("tag_name"), exe=dl, sha_exe=sha_exe, sha_apk=sha_apk,
        apk_fixo=f"https://github.com/{REPO}/releases/latest/download/BAGRENATION.apk", assets=[x["name"] for x in lat.get("assets", [])])


if __name__ == "__main__":
    main()
