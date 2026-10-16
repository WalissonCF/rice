cmake_minimum_required(VERSION 3.20)
project(rice_native_win LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
# Runtime estático: o .exe não depende do VC++ Redistributable instalado.
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")

set(RICE_WEBRTC_DIR "" CACHE PATH "Prefixo do webrtc-audio-processing (include/ e lib/)")
# Se o prefixo de scripts/build-webrtc-apm.ps1 já existe, o AEC liga sozinho: o rice-audio.exe sai com AEC3 por padrão.
set(_rice_apm_default "${CMAKE_CURRENT_SOURCE_DIR}/../third_party/webrtc-apm-win")
if(NOT RICE_WEBRTC_DIR AND WIN32 AND IS_DIRECTORY "${_rice_apm_default}/lib")
  set(RICE_WEBRTC_DIR "${_rice_apm_default}" CACHE PATH "Prefixo do webrtc-audio-processing (include/ e lib/)" FORCE)
endif()
if(RICE_WEBRTC_DIR)
  set(_rice_aec_default ON)
else()
  set(_rice_aec_default OFF)
endif()
option(RICE_WITH_AEC "Inclui o WebRTC AEC3 (precisa de RICE_WEBRTC_DIR). Liga sozinho quando o prefixo do APM existe." ${_rice_aec_default})
option(RICE_REQUIRE_AEC "Erro de configuração se o AEC não puder ser incluído (o CI usa; evita publicar um .exe sem AEC por engano)." OFF)
if(RICE_REQUIRE_AEC AND NOT RICE_WITH_AEC)
  message(FATAL_ERROR "RICE_REQUIRE_AEC=ON, mas o AEC está desligado: rode scripts/build-webrtc-apm.ps1 ou passe -DRICE_WEBRTC_DIR")
endif()

if(MSVC)
  add_compile_options(/W4 /utf-8 /permissive- /EHsc)
  add_compile_definitions(UNICODE _UNICODE NOMINMAX WIN32_LEAN_AND_MEAN _WIN32_WINNT=0x0A00)
else()
  add_compile_options(-Wall -Wextra -Wno-unused-parameter)
endif()
find_package(Threads REQUIRED)

# --- núcleo portável ----------------------------------------------------------------------------
add_library(rice_common STATIC common/json.cpp common/events.cpp common/framing.cpp common/chunker.cpp common/resampler.cpp)

add_library(rice_audio_core STATIC
  audio/echo_canceller.cpp audio/recorder.cpp audio/selftests.cpp audio/sinks.cpp
  audio/simulated_platform.cpp audio/output_classify.cpp audio/mic_device.cpp)
target_link_libraries(rice_audio_core PUBLIC rice_common Threads::Threads)

add_library(rice_detector_core STATIC detector/app_matcher.cpp detector/mic_watcher.cpp detector/mic_monitor.cpp detector/window_list.cpp detector/discord_voice.cpp)
target_link_libraries(rice_detector_core PUBLIC rice_common Threads::Threads)

# --- AEC (opcional) -----------------------------------------------------------------------------
if(RICE_WITH_AEC)
  if(NOT RICE_WEBRTC_DIR)
    message(FATAL_ERROR "RICE_WITH_AEC=ON exige -DRICE_WEBRTC_DIR=<prefixo do webrtc-audio-processing>")
  endif()
  add_library(rice_apm STATIC ${CMAKE_CURRENT_SOURCE_DIR}/../rice-audio/Sources/RiceAPM/rice_apm.cpp)
  target_include_directories(rice_apm PUBLIC
    ${CMAKE_CURRENT_SOURCE_DIR}/../rice-audio/Sources/RiceAPM/include
    ${RICE_WEBRTC_DIR}/include/webrtc-audio-processing-2 ${RICE_WEBRTC_DIR}/include)
  target_compile_definitions(rice_apm PRIVATE WEBRTC_LIBRARY_IMPL WEBRTC_WIN _USE_MATH_DEFINES)
  find_library(RICE_WEBRTC_LIB NAMES webrtc-audio-processing-2 libwebrtc-audio-processing-2 PATHS ${RICE_WEBRTC_DIR}/lib REQUIRED)
  target_link_libraries(rice_apm PUBLIC ${RICE_WEBRTC_LIB})
  if(WIN32)
    target_link_libraries(rice_apm PUBLIC winmm)  # o WebRTC usa timeGetTime (rtc::SystemTimeNanos)
  endif()
  target_link_libraries(rice_audio_core PUBLIC rice_apm)
  target_compile_definitions(rice_audio_core PUBLIC RICE_HAS_AEC)
endif()

# --- executáveis --------------------------------------------------------------------------------
set(AUDIO_SOURCES audio/main.cpp)
set(DETECTOR_SOURCES detector/main.cpp)
if(WIN32)
  list(APPEND AUDIO_SOURCES audio/win/windows_platform.cpp)
  list(APPEND DETECTOR_SOURCES detector/win/registry_mic.cpp detector/win/windows_list.cpp detector/win/discord_uia.cpp)
endif()

add_executable(rice-audio ${AUDIO_SOURCES})
target_link_libraries(rice-audio PRIVATE rice_audio_core)
add_executable(rice-detector ${DETECTOR_SOURCES})
target_link_libraries(rice-detector PRIVATE rice_detector_core)
if(WIN32)
  target_link_libraries(rice-audio PRIVATE ole32 uuid propsys winmm)  # winmm: timeGetTime do WebRTC
  target_link_libraries(rice-detector PRIVATE advapi32 user32 dwmapi ole32 oleaut32 uuid)
endif()

# --- testes -------------------------------------------------------------------------------------
enable_testing()
add_executable(rice_tests tests/test_main.cpp tests/test_protocol.cpp)
target_link_libraries(rice_tests PRIVATE rice_audio_core rice_detector_core)
add_test(NAME portable COMMAND rice_tests ${CMAKE_CURRENT_SOURCE_DIR}/../../tests/fixtures)
