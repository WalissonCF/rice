# Protocolo dos helpers nativos (rice-audio e rice-detector)

Contrato entre o main do Electron e os helpers. Extraído do Swift (`native/rice-audio`, `native/rice-detector`)
e dos clientes TS (`src/main/session/audio-capture.ts`, `detector-client.ts`, `src/shared/frames.ts`).
As versões Windows (`native/win`) falam exatamente isto; o main não muda. Fixtures gravados da saída do
Swift ficam em `tests/fixtures/protocol/` e os testes de `native/win/tests` comparam com eles.

Convenções válidas para os dois:

- Uma mensagem = uma linha JSON (`\n`), chaves em ordem alfabética (`JSONSerialization.sortedKeys`), sem espaços.
  Barras viram `\/` (como o Foundation faz); quem lê não depende disso, mas os fixtures sim.
- Texto de `message` é livre (pt-BR); o main só repassa. Linhas do stderr que não começam com `{` são ignoradas.
- Comandos entram pelo stdin, um objeto por linha: `{"cmd":"<nome>", ...}`.
  Linha que não é JSON de objeto com `cmd` string → erro `invalid command line`; `cmd` desconhecido →
  erro `unknown command: <cmd>`. Em ambos o processo segue vivo.

## rice-audio

Um processo = uma gravação. O main (`AudioCapture`) lança `rice-audio --exclude-pid <pid do Electron>` com
`stdio: pipe`, escreve `{"cmd":"start"}` e, no fim, `{"cmd":"stop"}` + fecha o stdin.

### Argumentos

| Argumento | Efeito |
| --- | --- |
| `--exclude-pid N` (repetível) | Processos cujo áudio não entra no `sys` (o Rice se exclui). Windows: aceito; ver nota em `native/win/README.md`. |
| `--no-aec` | Não cancela eco no microfone. Evento `aec {enabled:false, reason:"desligado por --no-aec"}`. |
| `--mic-device ID` (ou env `RICE_MIC_DEVICE`) | **Só Windows, opcional.** Abre o endpoint de captura `ID` (o `id` de `--list-inputs`) em vez do padrão do Windows. Sem o argumento: padrão (`eConsole`), seguindo as trocas. Se o endpoint sumir, volta ao padrão; se voltar, retoma (evento `mic-device`). O Mac não tem o argumento (usa a entrada padrão do sistema) e o ignora. |
| `--mic-device UID` (ou env `RICE_MIC_DEVICE`) — **Mac** | Abre a entrada do CoreAudio com esse UID (`kAudioOutputUnitProperty_CurrentDevice` no `inputNode`, antes de iniciar) em vez da padrão do macOS. Sem ele, segue a padrão como sempre. UID que sumiu (fone desconectado): cai no padrão e o evento `mic-device` diz `reason: "preferred-missing"`. Só o dispositivo da entrada muda; o resto da captura (AEC, sistema, chunkers) é o mesmo. |
| `--list-inputs` — **Mac** | `{"inputs":[{"id":UID,"isDefault","name","state":"active","transport"}]}` (`transport`: builtin, usb, bluetooth, aggregate, virtual, other). |
| `--probe-inputs UID,UID [--ms 1200]` — **Mac** | Modo à parte (processo curto, fora da gravação): mede ~1,2 s de cada entrada e imprime `{"levels":[{"id","rmsDb","voice"}]}` (`error:"not-found"` se o UID não existe). O chamador nunca passa Bluetooth que não esteja em uso. |
| `--list-inputs` | **Só Windows.** Imprime UMA linha JSON no stdout e sai com 0: `{"inputs":[{"id","isDefault","name","state"}]}` (entradas ativas; `name` é o nome amigável, ex. `Microfone (FIFINE K669)`; `state` é `active`). Fixture: `tests/fixtures/protocol/mic-device.json`. |
| `--system-source tap\|sck\|auto` | Só macOS (fonte do áudio do sistema). Windows aceita e ignora. |
| `--seconds N --out-dir DIR` | Modo manual: grava N s e escreve `mic.pcm`/`sys.pcm` (PCM cru) em DIR; stdout vazio. Erro de abertura → evento `error {source:"cli"}` e saída 1. |
| `--selftest-tone` | Ver "Selftests". |
| `--selftest-gap` | Ver "Selftests". |
| `--selftest-aec` | Ver "Selftests". |

Sem `--seconds`, o processo entra no modo controle: lê o stdin e **não captura nada** até o comando `start`.

### Comandos de stdin

- `{"cmd":"start"}`: inicia sleep-guard, AEC, microfone e áudio do sistema (nessa ordem). `start` repetido, ou depois de `stop`, é ignorado.
  Emite `started` ao final se nenhum `stop` chegou no meio.
- `{"cmd":"mic-device","id":UID}` (**Mac**): troca o microfone durante a gravação, reabrindo a entrada pelo mesmo caminho da troca de dispositivo (`id` vazio = padrão do macOS). Emite `mic-device` com `reason:"switched"`; o Chunker cobre o intervalo com silêncio (evento `gap`), a linha do tempo não tem buraco.
- `{"cmd":"list-inputs"}` (só Windows): responde o evento `inputs {inputs:[…]}` (mesma lista de `--list-inputs`).
- `{"cmd":"stop"}`: para tudo, escoa o stdout e sai com código 0.
- EOF do stdin equivale a `stop` (o pai fechou ou morreu).
- `stop` durante um `start` em andamento cancela o `start`: o que já tinha iniciado é desfeito.
- Watchdog: o processo sai em até 3 s depois de `stop`/EOF mesmo que a captura trave.

### stdout: frames binários (e nada mais)

```
offset  tamanho  campo
0       1        fonte: 0x01 = mic, 0x02 = sys
1       8        timestampMs, uint64 little-endian (ms desde o `start`; ver abaixo)
9       4        length, uint32 little-endian (bytes do payload)
13      length   PCM int16 little-endian, mono, 16 000 Hz
```

- Cada fonte é independente e tem seu próprio relógio de amostras.
- Frame completo = 1600 amostras = 100 ms = 3200 bytes. No fim da gravação cada fonte emite um último frame
  parcial (o que sobrou, se sobrou algo).
- O timestamp é contado **por amostras** a partir do primeiro bloco: `startOffsetMs + amostrasEmitidas/16`,
  portanto cresce exatamente 100 ms por frame completo. `startOffsetMs` é o instante de chegada do primeiro bloco menos a
  duração dele (ou 0).
- Lacunas: se o instante real de chegada de um bloco passa mais de 200 ms da posição esperada pelas amostras
  (captura travada, suspensão), o chunker insere silêncio (zeros) para cobrir a diferença e emite o evento `gap`.
  Detalhe do cálculo: `esperadoFim = startOffsetMs + (emitidas + pendentes)/16`; `esperadoNovoFim = esperadoFim + duraçãoDoBloco`;
  se `agora > esperadoNovoFim + 200`, `gapMs = agora - esperadoNovoFim` e `gapMs*16` zeros entram antes do bloco.
- O decodificador do main aceita payload de até 1 MiB; fonte desconhecida ou payload maior derruba o processo.
- Contrapressão: acima de ~1,92 MB (30 s de áudio) pendentes de escrita no stdout, frames novos são descartados
  e um único `error {source:"cli", message:"stdout backpressure"}` é emitido até a fila esvaziar.

### stderr: eventos

Campo `event` + campos extras. Eventos:

| event | campos | quando |
| --- | --- | --- |
| `started` | `mic: bool`, `sys: bool` | fim do `start`; cada booleano diz se a fonte abriu |
| `stopped` | (nenhum) | fim do `stop`, depois de escoar o resto dos chunkers. Só se havia gravação em andamento |
| `device-changed` | (nenhum) | o microfone foi reaberto depois de troca de dispositivo |
| `aec` | `enabled: bool`, `reason: string` | AEC ligado/desligado (no início e a cada troca da saída padrão) |
| `mic-device` | `id`, `name`, `isDefault: bool`, `chosen: bool`, `reason` | **Opcional e aditivo** (o app tem que funcionar sem ele). Windows e Mac. Emitido ao abrir o mic e a cada troca do dispositivo em uso. `isDefault`: é o padrão do sistema; `chosen`: é o microfone escolhido pelo usuário e está em uso. `reason` ∈ `open`, `switched` (troca por comando, Mac), `default-changed` (o padrão do sistema mudou), `preferred-missing` (o escolhido sumiu, voltou ao padrão), `preferred-returned` (o escolhido voltou e foi retomado) |
| `gap` | `source: "mic"\|"sys"`, `ms: int` | silêncio inserido (ver acima) |
| `warning` | `source`, `message` | problema não fatal (`power`, `aec`, `sys`) |
| `error` | `source`, `message`, `fatal?: true` | `source` ∈ `cli`, `mic`, `sys`, `resampler`; `fatal:true` = o main deve encerrar/reiniciar a captura |

Regras observáveis:

- AEC: ligado quando a saída padrão é alto-falante, desligado com fone (o mic passa sem alteração). Processa em quadros de 10 ms
  (160 amostras a 16 kHz); o que sobra (<10 ms) é descarregado no `stop` sem processar.
- Troca de dispositivo de entrada: o mic é reaberto até 3 vezes (500 ms entre elas), emitindo `device-changed`; se falhar,
  `error {source:"mic", fatal:true}`.
- A captura do sistema que para sozinha é reiniciada **uma vez** após 1 s (`error` sem `fatal` com "reiniciando");
  se falhar ou parar de novo, `error {source:"sys", fatal:true}`.
- Permissão de microfone negada → `error {source:"mic", message:"permissão de microfone negada"}` e `started.mic=false`.
- O resampler avisa **uma vez por formato de entrada** em caso de falha (`error {source:"resampler"}`).

### Códigos de saída

`0` em `stop`, EOF, watchdog e selftests; `1` só no modo `--seconds/--out-dir` quando o diretório não abre.

### Selftests (stdout/stderr determinísticos, exceto `--selftest-aec`)

- `--selftest-tone`: 1 s de seno por fonte, entregue como o sistema entregaria (48 kHz, estéreo, 10 blocos de 4800 amostras,
  amplitude 0,5): `mic` 440 Hz e depois `sys` 880 Hz, cada uma com `nowMs = 0`, depois `flush`. Sem stderr.
  Saída esperada (fixture `tests/fixtures/protocol/tone.bin`): 10 frames de `mic` (9 × 3200 bytes + 1 parcial), depois 10 de `sys`;
  timestamps 0, 100, …, 900 em cada fonte. A contagem exata de amostras depende do filtro do reamostrador (o Swift entrega
  15 338 por fonte); aceita-se de 9 a 10 frames por fonte e conteúdo equivalente (frequência, RMS ≈ 11 585, sem clipping).
- `--selftest-gap`: 2 s de seno 440 Hz só em `mic`, em 20 blocos de 100 ms já a 16 kHz, com um buraco de 1 s no relógio entre os blocos
  10 e 11. Esperado: 3 s de áudio (silêncio cobrindo 1,0–2,0 s), timestamps de 100 em 100 ms, e no stderr exatamente
  `{"event":"gap","ms":1000,"source":"mic"}` (fixtures `gap.bin`, `gap.stderr`; bit a bit idêntico, pois não há reamostragem).
- `--selftest-aec`: 6 s de ruído modulado como "sistema", chegando ao mic atrasado 40 ms, atenuado e com eco de sala, com voz local
  entre 3,5 s e 4,5 s. Imprime **uma linha no stdout**: `{"inDb":..,"outDb":..,"reductionDb":..,"voiceLossDb":..}`.
  Passa se `reductionDb >= 15`. Usa ruído aleatório (não determinístico). Sem AEC no build, imprime `{"error":"..."}`.

### Modo simulado (só nas versões Windows/portáveis)

`--simulate-capture`: troca o hardware por tons sintéticos (mic 440 Hz, sys 880 Hz, 48 kHz estéreo, blocos de 10 ms em tempo real)
mantendo todo o resto do protocolo. Existe para o smoke test do CI e para testes sem áudio. O Swift não tem essa flag.

## rice-detector

O main (`DetectorClient`) lança `rice-detector` sem argumentos, lê **stdout** linha a linha (stderr é descartado), escreve comandos no stdin.
Se o processo morre, o main o relança (1 s, 3 s, 9 s). EOF do stdin → termina com código 0 depois dos comandos em andamento.

### Eventos de stdout (modo watch)

| event | campos | quando |
| --- | --- | --- |
| `calendar-access` | `status: "granted"\|"denied"\|"notDetermined"` | na partida e depois de `request-calendar-access` |
| `reminders-access` | `status` (idem) | na partida e depois de `request-reminders-access` |
| `mic-in-use` | `app`, `bundleId` | um app da lista começou a usar o microfone (uma vez por app, mesmo com vários processos) |
| `mic-released` | `app`, `bundleId` | parou. O main aplica o debounce (120 s) |
| `upcoming-event` | `id,title,start,end,url` | evento de calendário começando (janela de −120 s a +60 s), uma vez por id |
| `current-event` | evento (`id,title,start,end,url`) ou `{"id":null}` | resposta de `current-event` |
| `events-list` | `events: [{id,title,start,end,allDay,calendar,attendees,url?,color?}]` | resposta de `list-events` |
| `reminders-list` | `reminders: [{id,title,due,hasTime,overdue,list,color?}]` | resposta de `list-reminders` |
| `reminder-completed` | `id`, `ok: bool` | resposta de `complete-reminder` |
| `inputs` | `inputs: [{id, name, transport, isDefault, inUse}]` | **Opcional, aditivo, só o detector do Mac.** Resposta de `list-inputs`: as entradas do CoreAudio (`transport`: builtin, usb, bluetooth, aggregate, virtual, other). `inUse`: algum OUTRO processo usa a entrada agora (`kAudioProcessPropertyIsRunningInput` + `kAudioProcessPropertyDevices`, macOS 14.2+; mais preciso que `IsRunningSomewhere`, que também vale para a saída do mesmo dispositivo). Base da escolha automática do microfone ao gravar. Só consulta. |
| `default-input` | `id`, `name` (nulos se não há entrada) | **Opcional, aditivo, só o detector do Mac** (o do Windows não emite; o app funciona sem ele). Entrada de áudio padrão do sistema (CoreAudio, `kAudioHardwarePropertyDefaultInputDevice`): na partida, a cada troca e como resposta de `current-input`. É a entrada que o `rice-audio` do Mac grava (`AVAudioEngine.inputNode` sem dispositivo fixo). `id` = UID do dispositivo. O detector só consulta; não grava. Fixture: `tests/fixtures/protocol/default-input.json` |
| `calendar-changed`, `reminders-changed` | (nenhum) | o repositório mudou |
| `error` | `message` | `invalid command line` / `unknown command: X` |

O mic é consultado a cada 2 s; o calendário a cada 30 s. Datas em ISO 8601 com fuso (`2026-10-11T10:00:00-03:00`).
O `bundleId` de um app é o primeiro identificador visto para ele (`activeApps[app] ?? bundleId`).

### Comandos de stdin

`current-event`, `list-events` (`from`, `to` ISO 8601, com ou sem milissegundos), `request-calendar-access`, `list-reminders`,
`request-reminders-access`, `complete-reminder` (`id`), `current-input` (só Mac; repete `default-input`), `list-inputs` (só Mac; responde `inputs`). Cada um responde com o evento da tabela.

### Argumentos (modos de teste, sem watch)

| Argumento | Saída (uma linha JSON no stdout, sai com 0) |
| --- | --- |
| `--match <id>` | `{"app":"Google Chrome"}` ou `{"app":null}` |
| `--print-input` | `{"id":…,"name":…}` da entrada padrão atual (só Mac) |
| `--print-mic-processes` | lista dos ids de processos usando o mic (formato livre; só diagnóstico) |
| `--simulate-mic '<json>'` | `<json>` = `[["id",...],["id"],[]]`: cada passo é um snapshot; imprime os eventos `mic-in-use`/`mic-released` gerados, um por linha, na ordem do Swift (primeiro os `in-use` em ordem alfabética do app, depois os `released`) |
| `--simulate-upcoming '<json>'` | `{now,announced:[ids],events:[{id,title,start,end}]}` → array JSON dos ids que disparam |
| `--simulate-reminders '<json>'` | `{now,items:[{id,title,y,m,d,h?,min?}]}` → `[{"hasTime","id","overdue"}]` (depende do fuso local) |
| `--once` | `{"event":"snapshot","micInUse":[...],"calendarAccess":..,"upcoming":[...]}` |

Casamento de apps (`--match`): id exato ou prefixo `id + "."` (sub-processos), na ordem da lista:
Zoom, Microsoft Teams, Google Chrome, Arc, Safari, Firefox, Microsoft Edge, Brave, Slack, FaceTime, Discord, Webex.

### Windows

O detector Windows mantém os mesmos eventos e comandos. Diferenças deliberadas:

- Fonte do mic: registro `HKCU\Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone`
  (subchaves de apps empacotados e `NonPackaged\<caminho com # no lugar de \>`), em uso quando `LastUsedTimeStart > LastUsedTimeStop`.
  O `bundleId` do evento é o nome do `.exe` (ou o nome de família do pacote), e a lista de nomes de app ganha os equivalentes
  Windows (`zoom.exe`, `ms-teams.exe`, `chrome.exe`, `msedge.exe`, `slack.exe`, `discord.exe`, …).
- Calendário e Lembretes não existem: `calendar-access`/`reminders-access` respondem `status:"unsupported"` (o `DetectorClient`
  ignora status fora de `granted|denied|notDetermined`), `current-event` → `{"id":null}`, `events-list` e `reminders-list` vazios,
  `reminder-completed` → `ok:false`. Nunca há `upcoming-event`. `--simulate-upcoming` e `--simulate-reminders` não existem.
- Pedido extra, só Windows (não existe no Swift; o Mac nunca o envia): `{"cmd":"list-windows","apps":["Zoom"],"exes":["chrome.exe"],"pids":[123]}` → `{"event":"windows-list","windows":[{id,owner,pid,exe,title,x,y,w,h,monitor,mx,my,mw,mh}]}` (janelas visíveis, da frente para trás). Também como `--list-windows [--app|--exe|--pid]`. Os eventos acima não mudam.
- Quem fala no Discord, só Windows (o Mac nunca envia): `{"cmd":"watch-speakers","app":"Discord"}` começa a ler, a cada 250 ms, a árvore de
  UI Automation da janela do Discord desktop; `{"cmd":"stop-speakers"}` (ou EOF) para. Nenhum dos dois tem resposta. Enquanto lê, emite
  `{"event":"speaker-active","app":"Discord","name":"Ana","speaking":true|false}` a cada transição (fim antes de começo; ao parar ou sem
  janela, um `speaking:false` para cada um que ainda falava). Fonte: na lista do canal de voz da barra lateral do servidor, o nome de quem fala
  ganha a classe `usernameSpeaking__*` (as classes vêm com sufixo de hash: só o prefixo conta). A conta logada (painel `accountPopoutButtonWrapper__*`)
  nunca é emitida: a voz dela é o mic. Só nomes; nada é gravado. `--simulate-speakers '<json>'` (array de árvores `{cls,name,children}`) imprime os
  eventos gerados; `--print-discord-voice` imprime `{self, members:{nome: falando}}` da janela atual (diagnóstico).
  Fixture: `tests/fixtures/protocol/discord-voice.json` (árvore real reduzida, nomes trocados).
- `--fake-mic-steps '<json>' [--fake-mic-interval-ms N]` (só nas versões portáveis): o modo watch lê os snapshots do mic dessa lista
  (um por intervalo, padrão 2000 ms; o último se repete) em vez do registro. Para smoke tests.
