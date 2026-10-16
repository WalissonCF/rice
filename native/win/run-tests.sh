#!/bin/bash
# Compila e roda os testes da parte portável com o compilador do sistema (clang no macOS, g++ no Linux).
# No Windows o CMake faz o mesmo (ctest). Uso: native/win/run-tests.sh [--keep]
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
out="${TMPDIR:-/tmp}/rice-win-tests"
mkdir -p "$out"
cxx="${CXX:-c++}"
# RICE_APM_DIR=<prefixo do webrtc-audio-processing> liga o AEC3 também aqui (no Mac, native/third_party/webrtc-apm); sem ele o teste do AEC só confere a falha limpa.
aec=()
if [ -n "${RICE_APM_DIR:-}" ]; then
  aec=(-DRICE_HAS_AEC -DWEBRTC_LIBRARY_IMPL -DWEBRTC_POSIX -I"$RICE_APM_DIR/include/webrtc-audio-processing-2" -I"$RICE_APM_DIR/include"
       -I"$here/../rice-audio/Sources/RiceAPM/include" "$here/../rice-audio/Sources/RiceAPM/rice_apm.cpp"
       -L"$RICE_APM_DIR/lib" -lwebrtc-audio-processing-2)
  [ "$(uname)" = Darwin ] && aec+=(-framework CoreFoundation -framework Foundation)
fi
"$cxx" -std=c++17 -O1 -Wall -Wextra -Wno-unused-parameter -pthread \
  "$here"/common/*.cpp "$here"/audio/{echo_canceller,recorder,selftests,sinks,simulated_platform,output_classify,mic_device}.cpp \
  "$here"/detector/{app_matcher,mic_watcher,mic_monitor,window_list,discord_voice}.cpp "$here"/tests/*.cpp ${aec[@]+"${aec[@]}"} -o "$out/rice_tests"
RICE_FIXTURES="$here/../../tests/fixtures" "$out/rice_tests"
