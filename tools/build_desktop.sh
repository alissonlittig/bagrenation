# Toolchain sem Visual Studio: Rust + CRT/SDK (xwin em C:\xwin) + clang-cl (C:\llvm). (copiado do S-1412)
export PATH="$HOME/.cargo/bin:/c/llvm/bin:$PATH"
K='C:/xwin/Windows Kits/10'; V='C:/xwin/VC/Tools/MSVC/14.44.17.14'; S=10.0.26100
export INCLUDE="$V/include;$K/Include/$S/ucrt;$K/Include/$S/um;$K/Include/$S/shared;$K/Include/$S/winrt;$K/Include/$S/cppwinrt"
export LIB="$V/lib/x86_64;$K/Lib/$S/ucrt/x86_64;$K/Lib/$S/um/x86_64"
export CC=clang-cl CXX=clang-cl AR=llvm-lib RC=llvm-rc
export CC_x86_64_pc_windows_msvc=clang-cl CXX_x86_64_pc_windows_msvc=clang-cl
export CFLAGS="--target=x86_64-pc-windows-msvc" CXXFLAGS="--target=x86_64-pc-windows-msvc"
export TAURI_SIGNING_PRIVATE_KEY="$(cat C:/SISTEMA/chaves/bagrenation-updater.key)" TAURI_SIGNING_PRIVATE_KEY_PASSWORD=''
cd /c/gerente/02_PROJETOS_PESSOAIS/compartilhar-tela/desktop && npx tauri build
echo "BUILD_RC=$?"
