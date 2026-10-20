# Helpers nativos para Windows

`rice-audio.exe` e `rice-detector.exe` falam o **mesmo protocolo** dos helpers Swift do macOS
(ver [`../PROTOCOL.md`](../PROTOCOL.md)); o main do Electron não muda.

```
common/    portátil: JSON, eventos, frames, Chunker, Resampler (sem Win32)
audio/     portátil: Recorder, AEC (wrapper), sinks, selftests, plataforma simulada
audio/win/ Win32: WASAPI (mic por evento, loopback da saída padrão), IMMNotificationClient, PowerRequest
detector/  portátil: AppMatcher, MicWatcher, main
detector/win/ Win32: leitura do consent store do registro
tests/     testes de paridade contra tests/fixtures/protocol (gravados do Swift)
```

Tudo que é Win32 está atrás de `#ifdef _WIN32`. O resto compila no macOS/Linux com `native/win/run-tests.sh`
(clang/g++, sem CMake) e no Windows com CMake + MSVC:

```powershell
cmake -S native/win -B build/win -A x64
cmake --build build/win --config Release
ctest --test-dir build/win -C Release --output-on-failure
```

## Modo simulado

`rice-audio --simulate-capture` (ou `RICE_AUDIO_SIMULATE=1`) troca o hardware por tons sintéticos, mantendo o resto do protocolo.
`rice-detector --fake-mic-steps '[["chrome.exe"],[]]' [--fake-mic-interval-ms 200]` (ou `RICE_DETECTOR_FAKE_MIC_STEPS` /
`RICE_DETECTOR_FAKE_MIC_INTERVAL_MS`) simula os apps usando o mic. É o que o smoke test do CI usa.

## O que foi provado onde

| | macOS (clang) | CI Windows (MSVC) | PC Windows |
| --- | --- | --- | --- |
| JSON, frames, Chunker, Resampler, Recorder, AppMatcher, MicWatcher | testado, comparado com o Swift | idem | – |
| `--selftest-gap` bit a bit; `--selftest-tone` ≤ 1 LSB do Swift | testado | testado | – |
| Protocolo ponta a ponta (cliente TS real + modo simulado) | testado | testado | – |
| Lista de janelas: filtro, JSON, escolha da tela/janela, fallback (`--fake-windows`) | testado | testado | – |
| AEC3: eco sintético atrasado perde ≥ 15 dB e a voz fica (`rice_tests`, `--selftest-aec`) | testado com o APM do Mac (≈ 21 dB, voz –0,1 dB) | roda no `windows.yml` | qualidade real |
| Compila com MSVC (WASAPI, registro, EnumWindows/DWM, APM via meson) | **não** | **prova** (quando o CI rodar) | – |
| Captura real do mic/loopback, troca de dispositivo, suspensão, consent store | não | não | **prova** |
| Janelas reais, DPI e vários monitores | não | só o smoke (sem janelas de call) | **prova** |

Código só-Windows fica isolado em `audio/win/` e `detector/win/` (`windows_platform.cpp`, `registry_mic.cpp`, `windows_list.cpp`),
atrás de `#ifdef _WIN32`; o resto é portátil.

## AEC no Windows

O `rice-audio.exe` sai **com o WebRTC AEC3 por padrão**, com a mesma lógica do Mac: o áudio do sistema (loopback) é a referência
para limpar o microfone; com fone o AEC fica desligado (evento `aec {enabled:false, reason:"fone …"}`), em alto-falante liga.
Se o AEC não puder iniciar, o helper segue sem ele e emite `aec {enabled:false, reason:"falha ao iniciar o WebRTC AEC3"}`;
`--no-aec` desliga.

- Fonte: `native/vendor/webrtc-audio-processing-2.1.tar.xz` (tarball oficial, SHA-256 fixado em `scripts/build-webrtc-apm.ps1`; os servidores
  do freedesktop/GitLab bloqueiam os runners do GitHub, por isso o tarball vive no repositório).
- Build: `pip install meson==1.5.2 ninja==1.11.1.1` e `scripts/build-webrtc-apm.ps1` (meson + ninja + MSVC, estático, `/MT`) geram
  `native/third_party/webrtc-apm-win`. O resultado é **linkado dentro do `rice-audio.exe`**: não há DLL para distribuir
  (`stage-native-win.ps1` continua copiando só os dois `.exe`).
- O CMake liga o AEC sozinho quando esse prefixo existe. `-DRICE_REQUIRE_AEC=ON` (usado no CI) faz o configure falhar em vez de
  gerar um `.exe` sem AEC por engano. `-DRICE_WITH_AEC=OFF` desliga de propósito.
- CI (`windows.yml`): o prefixo é compilado uma vez e guardado em cache (chave = script + tarball); depois rodam o `ctest`
  (inclui o teste do AEC com sinais sintéticos), `rice-audio.exe --selftest-aec` (queda ≥ 15 dB e voz perdendo < 6 dB) e o teste TS
  `rice-audio (C++): AEC` com `RICE_EXPECT_AEC=1`.
- `install.ps1` compila o prefixo na primeira vez (se houver python); se falhar, instala sem AEC e avisa.
- No Mac, `RICE_APM_DIR=native/third_party/webrtc-apm native/win/run-tests.sh` roda a mesma suíte com o AEC ligado.

## Lista de janelas (captura na janela da call)

`rice-detector.exe --list-windows [--app "Google Chrome"]… [--exe zoom.exe]… [--pid N]…` imprime uma linha JSON com as janelas visíveis,
da frente para trás (`EnumWindows`; ignora minimizadas, "cloaked" e janelas de ferramenta; retângulo da moldura visível pelo DWM; processo
em DPI por monitor, então os retângulos são pixels físicos). Cada item: `id` (HWND), `owner` (nome do app do detector, ou o `.exe`),
`pid`, `exe`, `title`, `x y w h`, `monitor` (HMONITOR) e `mx my mw mh` (retângulo do monitor). Sem filtro, devolve todas.
O mesmo pedido existe no stdin como `{"cmd":"list-windows","apps":[…],"exes":[…],"pids":[…]}` → `{"event":"windows-list","windows":[…]}`.
Os eventos existentes não mudam. `--fake-windows '<json>'` / `RICE_DETECTOR_FAKE_WINDOWS` substituem o EnumWindows nos testes.

No Rice (`src/main/screenshots/grab.ts`, só no Windows), a lista alimenta o mesmo `chooseTarget` do Mac: tela da janela da call
(retângulos convertidos para DIP com `screen.screenToDipRect`) e, quando outra pessoa fala, a própria janela via `desktopCapturer`
`window:<hwnd>:0` (fallback: título exato único; senão, a tela que a contém; sem janela, a tela do cursor).
Limite: janelas UWP hospedadas no `ApplicationFrameHost.exe` aparecem como esse processo (os apps de reunião acima são Win32/WebView2).

## Detecção de reunião (Windows)

Zoom, Teams novo (`ms-teams.exe`/`MSTeams_*`) e clássico (`teams.exe`), Chrome/Edge/Brave (inclusive os `*_proxy.exe` dos PWAs, como o Meet
instalado), Firefox, Slack (huddles), Discord (stable/canary/PTB), Webex e Whereby. Navegador só conta quando está usando o microfone
(o consent store só lista quem usa); `msedgewebview2.exe` não conta. O título da aba vem da lista de janelas e só desempata qual janela
capturar (o `chooseTarget` prefere a janela com "Meet", "Teams", "Zoom Meeting"… no título); ele não decide se há reunião.

## Microfone escolhido (Windows)

Sem nada, o `rice-audio.exe` grava o microfone padrão do Windows (`eConsole`) e segue as trocas, como sempre. Opcionalmente:

- `--mic-device <id do endpoint>` (ou a variável `RICE_MIC_DEVICE`, que o main do Electron define a partir de Configurações > Áudio > Microfone;
  o `AudioCapture` compartilhado com o Mac não muda, o filho só herda o ambiente) abre aquele endpoint. Se ele sumir (desplugou), o helper cai
  no padrão; se voltar, retoma. Isso é decidido pelo `MicDeviceTracker` (`audio/mic_device.cpp`, portátil e testado com a plataforma simulada),
  e o WASAPI reabre só quando a escolha efetiva muda (outro microfone entrando ou saindo não interrompe a gravação).
- `--list-inputs` imprime as entradas ativas: `{"inputs":[{"id","isDefault","name","state"}]}` (nome amigável, ex. `Microfone (FIFINE K669)`).
  Também como `{"cmd":"list-inputs"}` → evento `inputs`.
- Evento aditivo `mic-device {id,name,isDefault,chosen,reason}` ao abrir e a cada troca (`open`, `default-changed`, `preferred-missing`,
  `preferred-returned`). Opcional: o helper do Mac não emite e o app funciona sem ele. Ver `../PROTOCOL.md`.

No Mac nada disso existe: o `rice-audio` grava a entrada padrão do sistema e o `rice-detector` (processo separado, só consulta o CoreAudio)
informa o nome dela pelo evento opcional `default-input`.

## Modo leve do transcritor (Windows)

O `whisper-server` do Windows roda só na CPU. O Rice escolhe sozinho o modelo e as threads pelo hardware (`src/main/asr/transcriber-plan.ts`):
RAM ≤ 8 GiB ou menos de 6 núcleos lógicos → `ggml-small-q5_1`; RAM ≤ 4 GiB ou menos de 4 núcleos → `ggml-base-q5_1`; senão o
`large-v3-turbo-q5_0` de sempre. Em Configurações > Áudio > Transcrição dá para forçar o grande ou o leve. Os modelos leves baixam sob demanda
com SHA-256 e tamanho fixos no código. 
Medidas (Mac M4, 10 núcleos [4P+6E], 16 GB, `whisper-cli -ng` = CPU pura sem Metal, 73 s de áudio em português sintético, uma rodada cada;
o Mac é bem mais rápido por núcleo que um notebook x86, então vale a proporção, não o valor absoluto):

| modelo | threads | tempo p/ 73 s | tempo real (×áudio) | CPU-s por min de áudio | pico de RAM |
| --- | --- | --- | --- | --- | --- |
| large-v3-turbo q5_0 | 4 / 6 / 8 | 41,7 / 36,2 / 37,9 s | 0,57 / 0,49 / 0,52 | 119 / 144 / 181 | 0,90 / 1,16 / 1,15 GB |
| small q5_1 (181 MB) | 4 / 6 / 8 | 15,5 / 15,6 / 29,2 s | 0,21 / 0,21 / 0,40 | 43 / 59 / 130 | 0,73 / 0,71 / 0,74 GB |
| base q5_1 (57 MB) | 4 / 6 / 8 | 7,3 / 7,6 / 12,2 s | 0,10 / 0,10 / 0,17 | 22 / 31 / 57 | 0,48 / 0,44 / 0,44 GB |

Leitura: o grande custa ~2,8× o small e ~5,5× o base em CPU; passar de 6 threads não ajuda (small e base pioram em 8, o large empata),
daí o teto de threads (grande 6, small 6, base 4, sempre deixando 2 núcleos livres). A transcrição acontece durante a reunião e precisa
ficar abaixo de 1× o tempo real: com o grande a 0,5× aqui, um notebook de 4 núcleos que seja 2 a 3× mais lento por núcleo fica perto
ou acima de 1× (a fala se acumula), enquanto o small (0,21×) tem folga. Por isso o corte em < 6 núcleos lógicos e RAM ≤ 8 GiB (o grande já
usa ~1,2 GB só do modelo e disputa memória com o Electron e a IA local). **Não medi qualidade**: o áudio é voz sintética e o WER saiu
sem sentido (os três modelos erram muito nela); precisa de áudio real no PC de teste. Também **não medi em Windows**.

## Limitações conhecidas

- `--exclude-pid`: loopback por processo em modo EXCLUDE (`ActivateAudioInterfaceAsync`, Windows 10 2004+), que aceita **uma** árvore
  de processos por fluxo. Vale o primeiro pid (o main põe o Spotify antes do Rice), subindo até o pai de mesmo executável. Com o
  Spotify aberto o próprio Rice volta a entrar no `sys` (ele quase não toca áudio). Se a ativação falhar (Windows antigo), uma linha
  não-JSON no stderr avisa e a captura cai no loopback da saída inteira. O áudio excluído também sai da referência do AEC: com
  alto-falante, a música que vaza para o microfone não é cancelada.
- O loopback abre também um fluxo de silêncio na saída padrão, para o Windows continuar entregando pacotes quando nada toca.
- Permissão de microfone: se "Permitir que aplicativos da área de trabalho acessem o microfone" estiver desligado, o Windows
  entrega silêncio sem erro; o helper lê a chave `ConsentStore\microphone` e avisa com `permissão de microfone negada`.
- Calendário e Lembretes respondem `unsupported` (ver PROTOCOL.md).
