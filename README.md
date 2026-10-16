<p align="center">
  <img src="assets/icon/icon.png" width="128" height="128" alt="Rice">
</p>

<h1 align="center">Rice</h1>

<p align="center"><b>English</b> · <a href="README.pt-BR.md">Português</a> · <a href="https://ricenotes.app">ricenotes.app</a></p>

Rice is a Mac app that records your meetings, transcribes them on your machine and writes the notes for you.

![Rice: meeting notes next to the chat](docs/images/en/02-chat.webp)

- **Local transcription.** Records your microphone and the system audio (the other participants) and transcribes with [whisper.cpp](https://github.com/ggml-org/whisper.cpp). The audio never leaves your Mac.
- **Notes written by an AI, from templates.** When the recording ends, Rice fills in the sections of a template (Summary, Decisions, Next actions…). You choose the AI: Claude, ChatGPT, Gemini or OpenCode.
- **Ask about the meeting.** A chat panel answers questions about what was said.
- **Folders.** Group your meetings in the sidebar, like folders in a notes app.
- **Search everything.** Find a word in the titles, notes, annotations and transcripts of all your meetings.
- **Ask across meetings.** One question, answered from the notes of the meetings that matter, with links to them.
- **Share.** Copy the notes formatted, write a follow-up email draft or export a PDF.
- **Mini Rice.** A small floating pill shows that you are recording, with **Ask** and **Stop** one hover away.

## Contents

- [Requirements](#requirements)
- [Install](#install)
- [First steps](#first-steps)
- [Connect an AI](#connect-an-ai) (including [Local model](#local-model-no-internet))
- [Everyday use](#everyday-use)
- [Where your files live](#where-your-files-live)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Troubleshooting](#troubleshooting)
- [Privacy](#privacy)
- [License](#license)

## Requirements

- A Mac with **Apple Silicon** (M1 or newer). Intel Macs are not supported yet.
- **macOS 14 (Sonoma) or newer**. Rice uses the system audio capture that arrived in that version.
- **Xcode Command Line Tools** (`xcode-select --install`), to compile the small native audio helpers.
- [**Homebrew**](https://brew.sh), used to install `whisper.cpp` and the build tools.
- **Node.js 22** or newer.
- About **0.6 GB** of free disk space for the transcription model (it is downloaded the first time).
- An account or API key for at least one AI provider (see [Connect an AI](#connect-an-ai)). Transcription works without one; notes and chat need it.

## Install

Requires a Mac with Apple Silicon (arm64) and macOS 14 or newer. Transcription uses `whisper-server` from Homebrew (`brew install whisper.cpp`).

### Option 1 — recommended: install from Terminal

One line. It downloads the source into `~/rice-src`, builds it and puts **Rice.app** in `/Applications`. Because the app is built on your Mac, macOS does not block it (no `xattr` or "Open Anyway"). Running it again updates Rice.

```bash
curl -fsSL https://ricenotes.app/install | bash
```

Or directly from GitHub: `curl -fsSL https://raw.githubusercontent.com/WalissonCF/rice/main/get.sh | bash`

Or, step by step:

```bash
git clone https://github.com/WalissonCF/rice.git rice-src
cd rice-src
./install.sh
```

`install.sh` checks macOS/arm64, the Xcode Command Line Tools, Homebrew and Node 22+, installs what is missing with Homebrew (`whisper.cpp meson ninja pkg-config`), runs `npm ci` and `npm run dist`, copies **Rice.app** to `/Applications` (replacing the previous one) and removes the quarantine flag. It is safe to run again, stops with a clear message (in Portuguese and English) when something is missing, and does not use `sudo` (only Homebrew may ask for it). `./install.sh --check` only checks the environment.

### Option 2 — download the .dmg

Download `Rice-<version>-arm64.dmg` from the **Releases** page, open it and drag **Rice** to **Applications**.

Rice is signed ad hoc and is **not** signed or notarized by Apple, so on the first launch macOS shows "Rice Not Opened". To allow it, run in Terminal:

```bash
xattr -dr com.apple.quarantine /Applications/Rice.app
```

Or, without Terminal: click **OK** on the warning, open **System Settings › Privacy & Security**, scroll to the bottom and click **Open Anyway** next to "Rice was blocked". (On macOS 15 and later, right-click > Open no longer lets the app through.)

Because it is not signed by Apple, macOS may ask for the permissions again (microphone, system audio, Calendar) after you update.

You still need `brew install whisper.cpp` for the transcription server; the transcription model itself is downloaded on first launch.

### Updating

**Installed with `git clone` + `./install.sh`:** run, in the clone folder:

```bash
cd rice-src   # or ~/rice if you installed before 0.5.1
./update.sh
```

If your clone is older and has no `update.sh` yet, update once by hand (quit Rice first): `git pull && ./install.sh`. From then on, use `./update.sh`.

or click **Update** in **Settings > Updates** when Rice shows "New version available" (a small dot appears on Settings in the sidebar; the button opens Terminal already running `./update.sh` in your clone). `update.sh` checks that the folder is a git clone with a remote, shows what changed (up to 20 lines), runs `git pull --ff-only`, quits Rice, rebuilds with `./install.sh` and opens Rice again. It stops with an explanation, without changing or discarding anything, when: there are local changes (use `git stash`, and `git stash pop` afterwards), the update is not a fast-forward, or Rice is **recording** (stop the recording first). If the build fails, the old Rice stays in `/Applications` and is reopened. `./update.sh --force` rebuilds even when already up to date, and `./install.sh --update` is a shortcut for `./update.sh`. Your meetings, settings and keys stay where they are.

**The update changed nothing on screen?** `update.sh` (and `install.sh`) now say so instead of failing silently. `update.sh` quits **any** Rice that is open, at any path, and lists where each one was; after installing it prints `Rice updated: version X, commit Y` and compares it with your clone's commit (a mismatch is an error), registers the app with Launch Services, opens `/Applications/Rice.app` (an explicit path, never `open -a Rice`) and checks that the Rice now running is the one in `/Applications`. If there are other copies of Rice (a `.dmg` in Downloads, an old copy), it warns "There are other copies of Rice in: …" so you can delete them or always open `/Applications/Rice.app`; it never deletes anything by itself. In **Settings › Updates**, a line shows `Version 0.4.0 · commit abc1234 · /Applications/Rice.app`, so you can see which copy is open. If your `update.sh` is older than this, run `./update.sh --force` once more after the first update.

**Update notice:** once a day Rice makes one anonymous request to the public GitHub API (`repos/WalissonCF/rice/commits/main`: no token, nothing about you or your meetings) to see whether the `main` branch is ahead of your build. Turn it off with **Settings > Updates > Check for updates**. It only notifies: nothing updates by itself, and test instances never check. If this copy of Rice did not come from a clone (for example the .dmg), the button becomes **Download from GitHub** and opens the releases page. The build records the commit and the clone folder in `out/build-info.json` inside the app; that path stays on your Mac and is never sent anywhere.

**Installed from the .dmg:** download the newest `.dmg` from **Releases**, drag **Rice** to **Applications** replacing the old one and run the `xattr` command above again.

**Windows:** automatic: **Settings › Updates** shows "New version available" › **Download and install** › **Restart and update** (see the Windows section below). You can also run the newest installer from **Releases** over the old one; it replaces the previous version.

After updating, macOS may ask for the permissions again (microphone, system audio, Screen Recording, Calendar), because the app is not signed by Apple.

### Windows (x64, Windows 10 22H2 or 11) — ready for testing

The Windows port is built and tested in CI (and its UI is checked in the simulated-Windows test instance), but **it has not been tried on a real PC yet**: treat it as a release candidate and report what you find.

**Install (recommended): the `.exe` from the latest release.** Download `Rice-Setup-<version>-x64.exe` from **Releases** and run it. It installs per user (no administrator) and is unsigned: SmartScreen may show "Windows protected your PC"; choose "More info" and "Run anyway".

**Install in one line (PowerShell).** It downloads the installer of the latest release from GitHub, checks its hash against the release's `latest.yml` (a mismatch deletes the file and installs nothing) and runs it:

```powershell
irm https://raw.githubusercontent.com/WalissonCF/rice/main/install-win.ps1 | iex
```

(Once the site publishes it, `irm https://ricenotes.app/install.ps1 | iex` will do the same.)

**Updates are automatic.** In **Settings › Updates** Rice shows "New version X available" › **Download and install** (with progress) › **Restart and update**; the installer runs and Rice opens again. It never updates in the middle of a recording (it waits for it to end), it respects **Check for updates** (off means nothing is queried or downloaded) and Fully local mode blocks the check. It only works in the app installed by the `.exe`, and needs the release to carry `latest.yml` and the `.blockmap` (the `release-windows` workflow attaches them).

**Start with Windows** (Settings › Startup, off by default) opens Rice in the tray, without a window, so the shortcut and the meeting alerts are ready. **Microphone** (Settings › Audio): "Windows default (recommended)" or a specific input; use the same microphone you picked in Teams or Zoom. A chip near **Stop** shows which microphone is being recorded. With 8 GB of RAM or less Rice picks the **light** transcription model (Settings › Audio shows which one is in use and why, and lets you force it) and keeps live ideas and the war room more contained.

**Calendar without the system calendar:** in **Settings › Calendar** use **Subscribe by link (ICS)** (Outlook/Microsoft 365: Publish a calendar; Google: "Secret address in iCal format"; iCloud and Fastmail also work) or connect Google directly.

**Differences from the Mac:** no Antigravity, no Reminders, no system Calendar; system audio is captured by WASAPI loopback (echo cancellation is the part still being finished); native notifications have no action buttons (clicking the notice does the main action); the keys are protected by Windows (DPAPI) and shortcuts use Ctrl.

**For developers only:** `install.ps1` builds Rice from the source (it needs Node 22, CMake and the Visual Studio C++ tools):

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1 -Check   # checks Windows, Node 22, CMake and the Visual Studio C++ tools
powershell -ExecutionPolicy Bypass -File install.ps1           # builds the helpers and the installer (dist\Rice-Setup-*.exe) and opens it
```

## First steps

Open **How to use Rice** in the sidebar. It is a checklist that updates live.

![The "How to use Rice" guide](docs/images/en/11-guide.webp)

![The How to use Rice guide, at the Calendar step](docs/images/en/48-guide.webp)

### 1. Choose where meetings are saved

Each meeting becomes a folder with the transcript, notes and chat. Pick the place under **Settings › Meetings folder** or in the guide (**Change folder…**). The files are plain Markdown, so you can open them with any app.

![Meetings folder](docs/images/en/13-meetings-folder.webp)

![Settings in sections: General, AI, Meetings and Privacy](docs/images/en/29-settings-sections.webp)

### 2. Allow the macOS permissions

On your first recording macOS asks for two things:

| Permission | Why | Where to allow it |
| --- | --- | --- |
| **Microphone** | So Rice hears you. | System Settings › Privacy & Security › Microphone |
| **System audio recording** | So Rice hears the other participants. | System Settings › Privacy & Security › Screen & System Audio Recording |

The guide has an **Open Privacy Settings** button. Enable **Rice** (while you run it from source it may be listed as **Electron**), then reopen the app if macOS asks you to.

![macOS permissions step](docs/images/en/12-permissions.webp)

### 3. Let the model download

The guide shows the progress of the transcription model. When it says **Model loaded**, you can record.

## Connect an AI

Open **Settings › Artificial intelligence** (the same list appears in the **How to use Rice** guide). Each provider is one line (Claude, ChatGPT, Gemini, OpenCode, Antigravity and **Local model**), with the active AI on top; click a line to open its steps. You can connect more than one provider and switch at any time with **Use this one**.

![AI providers](docs/images/en/10-ai-providers.webp)

![Recording model and cycle limit in Artificial intelligence](docs/images/en/30-light-model.webp)

| Provider | Option | What you need |
| --- | --- | --- |
| Claude | Subscription | Run `claude setup-token` in Terminal, sign in on the browser, paste the token (starts with `sk-ant-oat`). |
| Claude | API key | Create a key at [console.anthropic.com](https://console.anthropic.com) › API Keys (starts with `sk-ant-api`). |
| ChatGPT | Subscription | Install the Codex CLI (`npm i -g @openai/codex` or `brew install codex`), run `codex login` and sign in with your ChatGPT account. Nothing to paste. |
| ChatGPT | API key | Create a key at [platform.openai.com](https://platform.openai.com) › API keys (starts with `sk-`). |
| Gemini | API key | Create a key at [aistudio.google.com](https://aistudio.google.com) › Get API key (starts with `AIza`). Google discontinued the Gemini terminal sign-in (CLI) for personal accounts in June 2026, so Gemini is API key only; if you had it set up by login, Rice switches you to a key (or to another verified AI) and tells you once. |
| OpenCode | Sign-in | Install the [OpenCode](https://opencode.ai) CLI, run `opencode auth login` and pick your subscription. Nothing to paste. See below. |
| Antigravity | Sign-in | Install the Antigravity CLI (`agy`) and run `agy` in Terminal to sign in with your account. Nothing to paste. See below. |

Then click **Test connection**.

- API keys and tokens are stored encrypted in the **macOS Keychain** (Electron `safeStorage`). They are never shown again and never sent anywhere except to the provider you chose.
- API usage is billed by the provider, separately from any subscription.

### OpenCode

Rice uses the OpenCode CLI you are already signed in to, just like Claude and ChatGPT. Install it with `curl -fsSL https://opencode.ai/install | bash` and run `opencode auth login` in Terminal, picking your subscription provider (Claude Pro/Max, ChatGPT Plus/Pro, GitHub Copilot, OpenCode Zen…). Then in Rice open Connect AI > OpenCode, choose a model (the list only shows providers you signed in to) and click Test connection. OpenCode runs only to generate text: every permission is denied (no file edits, commands, web access, MCP or plugins), in an empty folder, without inheriting other providers' keys. Automatic mode only uses models you signed in to; with none, Rice asks you to sign in. The free model (OpenCode Zen) is used only if you pick it from the list, and it may use your transcripts to improve models, so prefer your subscription for sensitive meetings.

### Antigravity (agy)

You can use your Antigravity subscription as the AI (Settings > Artificial intelligence > Antigravity). Because `agy` is an agent with file and terminal access, Rice runs it inside a macOS sandbox: it only generates text, can't write anywhere except an empty temporary folder, can't run commands and can't read your home folder. The conversation created on each use is deleted from the agy state. The prompt goes in through stdin, so it does not show up in the process list. In Rice, click Test connection and pick a model (the list comes from `agy models`; in Automatic mode the light model for simple steps is the smallest Flash). The agent still has web access, so Antigravity is not available for War room or for chat with tools. Responses take a few seconds longer than other providers (the agy takes ~4 s to start).

### Local model (no internet)

For law, health, government and banking, where meetings cannot go to the cloud: the transcription is already local, and with the **Local model** provider the AI is too, so Rice works offline from end to end.

1. Install [Ollama](https://ollama.com) and open the app (Rice never installs anything by itself).
2. Download a model: `ollama pull qwen3:8b` (5.2 GB, a good choice for Portuguese on Macs with **16 GB**) or a smaller one for **8 GB**: `ollama pull qwen3:4b` (2.5 GB) or `ollama pull llama3.2:3b` (2.0 GB).
3. In **Settings › Artificial intelligence › Local model** pick the **Server**: **Automatic** (Rice tests all the default ports at once, with a short timeout, and shows what it found, for example "Found: LM Studio at :1234") or one of the list. Any local server works, not just Ollama. The **Server address** field is editable, but **only 127.0.0.1, localhost or ::1** are accepted: anything else is refused, so "local" really is local. Pick the model (sizes are shown) or type its name in **Model name** (for servers that do not list models), click **Test connection** (a tiny generation) and **Use this one**.

| Server | Default port | API | How to start it |
| --- | --- | --- | --- |
| Ollama | 11434 | Ollama (`/api/chat`) | open the app and `ollama pull qwen3:8b` |
| LM Studio | 1234 | OpenAI-compatible | load a model and turn on the Local Server (or `lms server start`) |
| llama.cpp (`llama-server`) | 9931 (older versions: 8080) | OpenAI-compatible | `llama-server -m model.gguf --port 9931` |
| MLX (`mlx_lm.server`) | 8080 | OpenAI-compatible | `mlx_lm.server --model mlx-community/Qwen3-8B-4bit` |
| Jan | 1337 | OpenAI-compatible | Settings › Local API Server › Start Server |
| Other | any, on localhost | OpenAI-compatible (`/v1/chat/completions`) | vLLM, KoboldCpp, text-generation-webui… |

Each option fills in the default port above (checked in each project's official documentation) and shows its own short steps, with a copy button on the commands.

**Context size** (8k / 16k / 32k, default 16k) is how much text the model reads at once; it is sent to Ollama as `num_ctx`, and Rice sizes the long-meeting extraction and the chat context from it. More context fits longer meetings but uses more RAM and is slower. The **light model** (Automatic) is the smallest installed model. Images only go to vision models (for example `llava` or `qwen2.5vl`). Web search, tools and MCPs are not available with the local model.

**Limits:** notes come out somewhat simpler than with the big models, and generation is slower.

**Fully local mode** (Settings › Privacy, off by default) is the trust seal: it only accepts the Local model provider and blocks everything that uses the network: web search, tools and MCPs, the war room with the internet, Google Calendar sync (the macOS Calendar keeps working), update checks and downloads of transcription models (the model must already be downloaded). Blocked controls stay on screen, disabled, with the reason, and a discreet **100% local** badge appears at the bottom of the sidebar. Underneath, the app's network layer itself refuses any destination that is not localhost while the mode is on.

![Local model card with the server found](docs/images/en/37-local-model.webp)

## Everyday use

### Record, stop and continue

Click **New meeting**, then **Record**. When you stop, Rice writes the notes. If the meeting is not over, open it later and click **Continue recording**: the new audio and transcript are added to the same meeting.

**Which microphone?** While recording, a chip near **Stop** shows the microphone being captured (hover for the full name and whether it is the system default or the one you chose); if it changes mid-meeting, Rice says "Microphone switched to X". The name is saved in the meeting (shown in its details and in the privacy receipt). On the Mac Rice records the macOS default input (System Settings › Sound › Input); on Windows you can choose the microphone in **Settings › Audio**.

Rice also notices meetings (Zoom, Meet, Teams) and calendar events and offers to record.

![Home with the meeting happening now and Record now](docs/images/en/31-record-now.webp)

![The notice when a call app starts using the microphone: Record?](docs/images/en/46-record-prompt.webp)

### Pause recording

For a side conversation that should not be recorded, use **Pause** (next to **Stop**, the **Pause** item in the tray or the Mini Rice button). While paused, Rice releases the microphone: audio is neither recorded nor transcribed, the clock stops, the button becomes **Resume · 00:42** (the paused time, in discreet amber) and the recording dot in the sidebar, the meeting item and the tray turns amber and still. Live ideas, the War room and screenshots stop too. **Resume** continues in the same meeting, and the transcript gets a discreet marker, for example “recording paused from 14:03 to 14:07”; times after the pause stay correct. While paused, Rice does not ask “still recording?” and does not stop by itself; after 30 minutes it only asks whether you want to stop. If the app crashes during a pause, “Recover meeting” works as usual.

![Paused recording: Resume · 00:12 and the marker in the transcript](docs/images/en/32-pause.webp)

### Notes versions

Generating the notes again (another template, or a new transcript) no longer loses the previous ones: the old notes are kept in `notas-versoes/` (up to 20, the oldest go first). A discreet **Versions (3)** chip next to the template chip lists them ("Brainstorm · today 4:40 PM · current"); picking one shows it read-only with a thin bar (**Back to current** / **Restore this one**). Search, chat, copy and PDF always use the current notes.

### Calendar

**Home** shows your next 7 days grouped by day (Today, Tomorrow, "Fri, Oct 17"). All-day events sit in one discreet line per day; timed events show their range ("09:00–09:30") and **Join** / **Take notes** only when they are meetings (a call link or attendees). Connect the **macOS Calendar** (recommended: add your Google account in System Settings › Internet Accounts) or Google directly in **Settings › Calendar**. Event titles stay on your Mac: only the title of a meeting you record is used, and all-day events never trigger a recording prompt.

**Subscribe by link (ICS)** (Mac and Windows): in **Settings › Calendar** paste the private link of your calendar (Outlook/Microsoft 365: Settings › Calendar › Shared calendars › Publish a calendar; Google: Settings › your calendar › Integrate calendar › "Secret address in iCal format"; iCloud and Fastmail work too; `webcal://` is fine). Rice reads only that link, every 10 minutes, over https, with a size limit, and handles repeating events (with exceptions), time zones, all-day and cancelled events. The link is a secret: it is stored encrypted (DPAPI on Windows, Keychain on the Mac), never shown back and never sent to the interface in full. Fully local mode blocks it.

![Home with the calendar](docs/images/en/24-calendar.webp)

![Home with today's reminders above the calendar](docs/images/en/25-home.webp)

![The “meeting is about to start” notice: Join and record, or just record](docs/images/en/45-meeting-alert.webp)

![Settings › Calendar: macOS Calendar (recommended) and connecting directly to Google](docs/images/en/47-calendar-connect.webp)

### Live transcript

The transcript appears while you talk. Grey text is still being refined and becomes final in a moment. Your voice is shown as **Me** and the other participants as **Others** (in the transcript file they are saved as `Eu` and `Outros`, and the app translates them when showing). You can write your own notes in **Annotations** at any time.

![Transcript of a meeting](docs/images/en/03-transcript.webp)

### Generate notes and change the template

Notes are written as soon as you stop. If they are missing or failed (for example, no AI connected yet), a **Generate notes** button appears. The chip above the notes (for example **General meeting**) switches the template, and the right side previews its sections.

![Template picker](docs/images/en/04-template-picker.webp)

### Notes with your own jottings

What you type in **Annotations** during the meeting becomes a key point in the notes: Rice stores the time of each line, expands every note in the right section using the transcript, and highlights your text (what the AI added appears in a softer tone). Nothing you wrote is dropped: whatever fits no section goes to "Other notes".

![Notes with the user's annotations highlighted](docs/images/en/21-notes-annotations.webp)

![Attachments on a meeting: images and files](docs/images/en/28-attachments.webp)

### Vocabulary

In **Settings › Vocabulary**, add names, clients and acronyms as chips: type one and press **Enter** (or a comma); **×** removes it, **Backspace** on the empty field removes the last one, and pasting several lines adds several chips (repeats are ignored). They help the transcript (they go in the whisper prompt) and the notes get the spelling right. Calendar event attendees are added automatically (you can turn this off).

![Vocabulary and participants in Settings](docs/images/en/22-vocabulary-participants.webp)

### Long meetings

Meetings of 1 to 2 hours are summarized in ~15-minute parts and then combined into the chosen template; you see "Generating notes… part 2 of 6". The meeting chat uses the per-part summary and the passages most relevant to your question.

### Identify participants (beta)

In **Settings › Participants**, Rice tells the voices on the computer audio apart as Person 1, Person 2… Click the label to name them (applies to the whole meeting; calendar attendees show up as shortcuts and the AI can suggest from context, always as a suggestion). Everything runs on your Mac: it downloads a 27 MB model the first time and uses about 100 MB of memory while recording. The names are used in the notes, the chat, the search and the exported PDF; the transcript file keeps "Person N". On Windows, during a Discord desktop call in a server voice channel, Rice reads who is speaking from Discord's accessibility tree (UI Automation) and names Person N with that Discord name automatically (you can still rename it). Only names are read, only while recording a Discord call, and they are kept only in the meeting's names list.

![Naming a participant](docs/images/en/23-speakers.webp)

### Screenshots (optional)

Off by default. Turn it on in **Settings › Screenshots**, after a notice. While you record, Rice follows the conversation and, when it notices someone is about to show something (“let me share my screen”, “look at this chart”, “here’s the dashboard”), it takes a screenshot about 2 seconds later, to let the screen change. The screenshot stays in the meeting folder (`capturas/`), linked to the sentence that triggered it: the thumbnail appears right after that sentence in the transcript, with a short caption, and the AI can cite it in the notes. Click the thumbnail to enlarge; ⋯ removes it. When the AI misses the moment, use the camera button in the bar (or **⌘⇧S**).

How it works: a local filter, in Portuguese and English, picks the sentences worth a question; only then does Rice send the last ~60 s of the transcript (text) to the AI you configured to confirm. This works with any provider, including CLI subscriptions. With an API key (Claude, OpenAI or Gemini) the image also goes to the AI, only to refine the caption; with CLI subscriptions images stay on your computer. At most one question every ~15 s and one screenshot every ~10 s; screenshots equal to the previous one are dropped. Which screen: Rice uses the app the detector saw using the microphone (Zoom, Teams, Meet in a browser…) and captures the screen where its window is; when someone else is speaking (computer audio), it captures only the call window. If it cannot find the app, it uses the screen under the cursor (on Windows, always that one). Needs the macOS Screen Recording permission. You can turn it off at any time, even while recording.

![Transcript with the screenshot right after the trigger sentence](docs/images/en/35-screenshots.webp)

### Memory across meetings

Instead of every meeting being an island, Rice remembers what each person and company **asked for, promised and decided**, and what is still pending. When a meeting’s notes are ready, one call to the AI’s **light model** (one per meeting, with only the text of the notes, annotations and participants) extracts those facts. Everything stays **on this Mac**, in `<meetings folder>/.rice/memory.jsonl`; people come from the calendar participants and the names you gave, and the company comes from the email domain (ignoring Gmail, Outlook, iCloud and similar, and your own domain).

- **Before the call:** in the **Notes** tab of a calendar event’s meeting a collapsible **What to remember** card shows 3 to 6 points (open follow-ups first, overdue ones in amber), each with a link to the meeting it came from. On **Home**, an event starting within 15 minutes gets a line with the first point and “see more”. With no facts, nothing shows.
- **Follow-ups that close themselves:** if in the next meeting someone says “I sent the proposal”, the AI marks the follow-up as done, with the source (“completed in …”). It never deletes: you can reopen it with one click.
- **In chat:** the meeting chat and the all-meetings chat get the facts of the people and companies involved as extra context (“what did Acme ask for before?”).
- **Memory page (sidebar, right below Follow-ups):** People and Companies tabs with search; each one opens a detail with open follow-ups first, then decisions, context and the latest meetings (with links), plus edit, mark as resolved, delete and “Forget this person/company”. The person/company name in the “What to remember” card and on Home links straight to that detail. An empty memory explains what will show up.
- **Settings › Memory:** the on/off option (on by default), a link to the page, **Erase memory** (with confirmation, hidden while empty) and **Build memory from older meetings** runs in the background, one meeting at a time, with progress and a cancel button, and only after your click (it uses the AI once per meeting). Deleting a meeting removes its facts.

![Memory page with people and companies](docs/images/en/42-memory.webp)

![What to remember card in the Notes tab](docs/images/en/43-what-to-remember.webp)

### Follow-ups

The **Follow-ups** item in the sidebar (with a counter of your overdue ones) gathers what you promised and what others promised you, from all meetings, in Overdue, Today, This week, Later, No due date and Done, with **Mine**, **From others** and **All** filters. Each row has a checkbox, text, owner, due date (one click to change) and a link to the source meeting; the **Add a follow-up** field creates your own, linked to a meeting or not. Relative dates (“until Friday”, “next week”) are converted to a date by the AI using the meeting’s date; with no clear date, the field stays empty. Checking a follow-up checks the matching `- [ ]` in the notes, and checking the task in the notes checks the follow-up. A **local notification** reminds you at 9 am on the due date (or when the app opens), grouping the day’s items into one; you can turn it off in Settings › Follow-ups. With the Reminders integration on, **Send to Reminders** takes one follow-up (or all of yours) to the macOS Reminders app.

![Follow-ups page with groups](docs/images/en/44-follow-ups.webp)

### Edit and create templates

Open **Templates** in the sidebar. Built-in templates can be edited (and restored later); **Duplicate** creates your own. A template is just a title, a short description and the list of sections Rice should fill in.

![Templates](docs/images/en/05-templates.webp)
![Editing a template](docs/images/en/06-template-editor.webp)

### Ask the AI

Click **Ask Rice** (top right) and ask anything about the open meeting: decisions, who does what, what was said about a topic. Questions and answers are saved in the meeting. **Saved questions:** the light-bulb button inside the question field (left of Send, always visible) opens a menu above the field with ready-made questions ("Summary for someone who missed it", "Next steps per person", "Risks and open items"; in the all-meetings chat, "What is still pending this week?" and others) and your own: one click sends the question. In the same menu, **Save last question** and **Add saved question…** keep your own (up to 8) and **Remove saved question** deletes one; **⋯ > Save to saved questions** on a question you already sent does the same. Answers that used *Search the web* keep their sources, and they show again when you reopen the meeting. **Search the web** (globe button next to the chips, off by default and per conversation) lets Rice look things up on the internet for the questions you ask while it is on; it works in the meeting chat and in the all-meetings chat, and the sources appear as links under the answer (title and domain, opened in your browser). The question goes to the AI provider's own search; the meeting notes still go only to the AI. Claude CLI uses only WebSearch and WebFetch (never Bash, Edit or file reading), Codex uses its live search with the read-only sandbox and no shell, and the Anthropic, OpenAI and Gemini APIs use their own search tools. Not available with OpenCode or Antigravity (they cannot be restricted to search without giving them a shell), where the button is disabled with the reason.


**Switching the AI and model in the chat.** In the chat header, the chip with the AI name (for example "Claude · Sonnet") opens a menu with the providers you have already set up and each one's models; the current one shows a ✓. The choice applies to the whole app (it is the same as Settings > AI): the next question and the next notes already use the chosen model. Providers not set up yet appear at the end, with "Set up…". The chip is disabled while an answer is being written. In OpenCode, the free model is an explicit option and warns that it may use your transcripts to improve models.

![Saved questions menu in the chat](docs/images/en/33-saved-questions.webp)

![Chat with web search on and the sources of the answer](docs/images/en/34-web-search.webp)

### Ask across your meetings

Open **Home** (first item of the sidebar): the **Ask about your meetings** field sits at the top of the page. You can also press **⌘J** from anywhere. Rice opens the chat panel in **All meetings** mode: it picks the most relevant meetings from your question (its words, a period such as "last month" or "last week", a folder or client name), sends their notes and the matching transcript passages to your AI and answers citing the meetings. The small numbers in the answer, and the **Sources** line, open the meeting at that passage.

The chip at the top of the panel switches between **This meeting**, **All meetings** and a single folder (with its subfolders). The conversation is saved in `.rice/chat-global.jsonl`; **New conversation** starts over.

![Chat across all meetings, with sources](docs/images/en/17-global-chat.webp)

### Record and stop from anywhere

Press **⌥⌘R** (Ctrl+Alt+R on Windows) in any app, with Rice in the background: it starts a meeting, using the note of the calendar meeting that is happening or starts within 10 minutes (like **Record now** on Home), and stops when pressed again. A discreet notification says "Recording" or "Recording stopped". Change the keys or choose **None** in **Settings > Shortcuts**; if another app already uses them, Settings shows a warning so you can pick another.

![Settings › Shortcuts](docs/images/en/36-shortcuts.webp)

### Mini Rice

While recording, a small pill floats on your screen, so you can leave the Rice window. Move the mouse over it and **Ask** and **Stop** appear. Click the logo to bring Rice back, and drag the pill by the logo column to move it.

![Mini Rice at rest](docs/images/en/15-mini-rice-rest.webp)
![Mini Rice on hover](docs/images/en/16-mini-rice-hover.webp)

*These two images are the real Mini Rice window rendered on a neutral background, with the hover state forced.*

### Folders

Click the folder icon next to **Folders** in the sidebar to create one. Folders can hold other folders, up to 4 levels: use **⋯ › New subfolder**, or drag a folder onto another to move it inside (drop it on the top or bottom edge of a folder to reorder instead). Move a meeting with **⋯ › Move to folder**, where the list shows the tree, or drag it onto a folder. Thin guide lines connect each folder to what is inside it, the count includes the subfolders, and open or closed is remembered per folder.

Folders are only labels: the meeting stays where it is on disk. Deleting a folder deletes nothing: its subfolders and meetings move up to the parent folder.

![Nested folders](docs/images/en/20-nested-folders.webp)

### Search

Press **⌘K** and type. Rice searches inside your meetings: titles, notes, annotations and transcripts, ignoring accents and capitals, and also folder names. Each result shows the date, a one-line snippet with your words in bold and where it was found (in notes, in transcript…). Use **↑ ↓** and **Enter** to move through the results, or click one: the meeting opens already scrolled to the passage, which flashes for a moment. **Esc** clears the search.

![Search](docs/images/en/08-search.webp)

### Share

The **⋯** menu of a meeting has **Share**:

- **Copy notes** puts the notes on the clipboard formatted (headings, lists, to-dos) and as Markdown, so pasting into Slack, Gmail, Notion or Google Docs keeps the formatting. A small "Notes copied" appears.
- **Copy as Markdown** copies only the Markdown.
- **Follow-up email draft**: the AI writes a subject and a body (thanks, short summary, decisions, next steps with owners) in the language of the meeting. You edit it in a clean dialog and **Copy** it or **Open in Mail**. If the meeting came from a calendar event, the recipients are filled with the attendees, never with your own address. Drafts too long for a `mailto:` link only offer Copy.
- **Export PDF…** makes a clean page (title, date, participants, notes and, if you tick it, the transcript) and asks where to save it.

There is no Notion integration, so no extra credentials: use **Copy notes** and paste into Notion, which converts it by itself.

![Share menu](docs/images/en/18-share-menu.webp)
![Follow-up email draft](docs/images/en/19-email-draft.webp)

### Languages

The **globe chip** (PT/EN) at the top of every screen opens a small tree: **App language ▸** and **Meetings language ▸** (inside a meeting it has two sections, **This meeting** and **Default**). The same two choices are in **Settings › Language**:

- **App language**: the texts of Rice (Português or English).
- **Meetings language**: the language spoken in your meetings (Portuguese, English or Automatic). A fixed language gives the best quality. You can also change it for a single meeting with the chip at the top of the meeting. It cannot be changed while recording. Notes are written in the language of the meeting.

![Settings](docs/images/en/09-settings.webp)

### Delete a meeting

**⋯ › Delete meeting** asks for confirmation, then moves the whole meeting folder to the **macOS Trash**, so you can recover it from there.

![Delete confirmation](docs/images/en/14-delete.webp)

### Live ideas and War room
**Idea types.** On the Ideas tab, *Type: General ▾* chooses what the AI suggests: General (ideas, questions and risks), Brainstorm, Questions to ask now, Risks and objections, Sales, Interview or Technical. Each is an editable template (instruction + optional categories) and you can create your own in **Templates > Ideas** (stored in `.rice/idea-templates/`). The choice is per meeting (the last one chosen is the default for new ones), and switching mid-meeting applies from the next cycle.

**New war room** (sidebar or Home) creates a meeting already in War room mode and opens the Investigation tab; any meeting can be turned into one from that tab, and a small **War room** badge next to the date turns it back. The Ideas and Investigation tabs sit on the meeting page next to Notes and Transcript, each with a short explanation. While recording, the Ideas tab suggests 1 to 3 ideas, questions or risks every 2, 5, 10 or 15 minutes (your choice), only when there is new speech. Pin the good ones to your notes. In War room meetings, the Investigation tab runs cycles (with its own interval, independent of the ideas) and lists **Findings** as they arrive, newest first, each with its source (a clickable URL, or a file inside the work folder revealed in Finder) and time. **Pin** the ones that matter (they go to the top and always stay in the context of later cycles; the most recent ones follow) and **Dismiss** the rest (with a few seconds to **Undo**). The tab counter shows findings that are new since you last looked. *Stop* aborts the running cycle and *Investigation on* pauses the investigation without losing the sources. Optional sources, each with a warning and off by default: Internet (search and page reading), MCPs, and a read-only work folder. Works with Claude and Codex subscriptions. Notes and e-mails never use tools.

![Ideas tab with the AI suggestions](docs/images/en/26-ideas.webp)

![Investigation tab with findings and sources](docs/images/en/27-warroom.webp)

**Continue in your own Claude/Codex.** On the Investigation tab, *Continue in terminal* opens your own CLI (Claude Code, Codex, Gemini CLI, Antigravity or OpenCode — only the ones found on your Mac) in Terminal, in the work folder (you pick it first; home, `/` and credential folders are refused), with a prompt to follow the live `transcricao.md` and investigate. The prompt carries only file paths and the findings you confirmed, never the transcript itself. *Copy prompt* is there for any other harness or IDE. Rice keeps recording and updating the file; the other harness uses its own permissions and account, and Rice does not control what it does.

## Where your files live

Everything is in the meetings folder you chose (for example `~/Rice`):

```text
Rice/
├── .rice/
│   ├── folders.json            # your sidebar folders (and which one is inside which)
│   ├── chat-global.jsonl       # the chat across meetings
│   └── templates/              # your templates, one .json each
└── 2026-10-09 1000 - Quarterly planning/
    ├── meta.json               # title, time, language, template, folder…
    ├── transcricao.md          # the transcript
    ├── anotacoes.md            # what you wrote in "Annotations"
    ├── anotacoes.json          # the time of each line you typed during the recording
    ├── falantes.json           # which voice is which person (if "Identify participants" is on)
    ├── extracoes.json          # per-part summaries of long meetings
    ├── notas.md                # the notes written by the AI
    ├── notas-versoes/          # earlier versions of the notes (up to 20) + index.json
    ├── chat.md                 # the chat, readable
    ├── chat.jsonl              # the chat, for the app
    └── audio.m4a               # the audio (if "Keep meeting audio" is on)
```

The file names are in Portuguese for now. App settings, secrets and the transcription model are in `~/Library/Application Support/Rice`.

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| **⌘K** | Focus the search box |
| **⌘J** | Ask across all your meetings |
| **↑ ↓ Enter** (in search) | Move through the results and open one |
| **Esc** | Clear the search / close a menu or dialog |
| **⌘⌫** | Delete the open meeting (asks first) |
| **⌘,** | Open Settings |
| **⌥⌘R** (global, works with Rice in the background; **Ctrl+Alt+R** on Windows) | Start recording, or stop if already recording. Change it or choose *None* in Settings > Shortcuts |
| **⌘⇧S** | Take a screenshot now (only while recording, with screenshots on) |
| **↑ ↓ → ← Enter** | Move through menus and submenus |

## Troubleshooting

**Disk full or folder unavailable.** Rice warns before recording if less than 1 GB is free. If the disk fills up during a meeting, a red alert appears, audio stops being saved and the transcript keeps being stored (in memory and in a local copy) until there is space. If the meetings folder disappears (ejected volume, deleted folder), Rice recreates it or saves to a safe place and tells you where. Free up space or reconnect the volume: the alert goes away by itself and the stretch without audio is marked in the transcript.

**Rice closed in the middle of a recording.** When you open it again, the meeting shows as "Recording interrupted". Open it and click "Recover meeting": Rice finishes the audio, transcribes what had no text yet and generates the notes. You can also click "Continue recording".

**The Mac went to sleep during the meeting.** Recording continues in the same meeting; the sleeping stretch appears as "recording paused from … to …" and system audio is reconnected.

**"Possible audio drop" or "the microphone lost its permission".** Rice tries to reconnect by itself a few times. If it does not come back, use "Open permissions" in the alert and enable the microphone (or system audio capture) for Rice in System Settings > Privacy & Security.

**"Still recording?"** After 15 minutes without speech Rice asks; with no answer in 2 minutes it stops the recording and offers "Resume". In `settings.json`, `inactivityMinutes` changes the time (0 turns it off). Recordings longer than 3 hours get a reminder every hour.

**Notes that do not come out.** If the app closed during generation, the meeting shows "Generate notes". Network failures get one automatic retry; login or usage-limit errors need your action (the message says which).

**"Needs repair".** If a meeting's `meta.json` is unreadable, it stays in the list with that badge; "Repair meeting" rebuilds title, date and state from the folder name and keeps the bad file as `meta.json.corrompido`.

**No system audio (only my voice is transcribed).**
Allow *System audio recording* for Rice (or Electron) in System Settings › Privacy & Security, then quit and reopen the app. Use headphones to avoid echo.

**The AI does not connect.**
Open **Test connection** for that provider. For subscriptions the login may have expired: run `claude setup-token` again (and paste the new token), or `codex login`. For API keys, check that the key is active and has credit.

**Transcription is slow or the Mac gets hot.**
Close heavy apps while recording. The default quantized model is the lightest one; make sure you did not set `RICE_WHISPER_MODEL=f16`.

**`npm run app` says Electron failed to install.**
Run `node node_modules/electron/install.js`.

**`scripts/build-native.sh` fails.**
Check that `xcode-select -p` prints a path and that `brew install meson ninja pkg-config` finished. The first build also needs internet.

**Rice says `whisper-server` is missing.**
Run `brew install whisper.cpp`, or point `RICE_WHISPER_SERVER` to the binary.

**Updating in development mode (`npm run app`).** For the installed app, see [Updating](#updating).
```bash
cd rice-src
git pull
npm install
scripts/build-native.sh
npm run app
```

### Tools and MCPs (advanced, at your own risk)
In Settings > Tools and MCPs in chat you can let the chat use the MCPs you already set up in Claude Code (`claude mcp add …`) or Codex, e.g. to create Notion or ClickUp tasks from a meeting. Off by default and chat only; never notes, e-mails or extractions. Note: meeting text comes from third parties and may carry malicious instructions; tool actions may be irreversible. Each use shows as "Tool used: server · tool". Claude and Codex subscriptions only.

## Privacy

What stays, what leaves, and how to check it:

- **Audio never leaves your Mac.** It is recorded and transcribed locally. Only text can leave: the transcript and your questions go to the AI provider **you** chose, and only when Rice writes notes or answers. Rice has no servers, account, telemetry or error reporting. The code is open (MIT).
- **Receipt per meeting.** In the meeting **⋯ › What left this computer** you see, line by line, what was sent to the AI, how many times, when and to which provider ("Notes: Claude (subscription) · 1 send · 14:31", "Screenshots: 0 sent", "Web search: not used"), or "Nothing from this meeting left your computer". It is built from a metadata-only log kept in the meeting folder (`.rice-egress.jsonl`: time, kind, provider, sizes; never the content) and can be copied as text or saved as PDF for compliance. Every call to the AI is recorded in one central place, so no feature can forget it; the Local model counts as "did not leave".
- **Consent notice.** When recording starts (button, Record now, meeting alert or the ⌥⌘R shortcut) a discreet toast, which never blocks the recording, suggests telling the participants, with a **Copy notice** button and a ready-made sentence in the meeting's language ("Notice: I am using Rice to transcribe this meeting locally on my computer, for my own notes…"). Edit the text or turn the reminder off in **Settings › Privacy**. The time the notice was copied appears in the receipt. Recording laws vary: in many places you must tell participants.
- **Your voice is never saved.** In participant identification (beta) the voices are compared **only in memory** while recording and discarded at the end: no voice signature (embedding) is written to disk, to the meeting or to the network. Earlier versions kept the speaker clusters in `falantes.json` per meeting; Rice now deletes that file and never writes it again (a test records a simulated meeting and checks that no file contains voice vectors).
- **Hide personal data.** With **Settings › Privacy › Hide personal data when sending to the AI**, or in a folder marked **Sensitive** (folder ⋯; subfolders inherit it), CPF, CNPJ, card numbers (Luhn-checked), email, phone numbers (BR/international), RG and CEP are replaced by markers such as `[CPF 1]` and `[EMAIL 2]` before the text leaves your Mac, and the answer is restored locally before it is saved or shown. The marker map lives only in memory, per call, and is never written. Common false positives (order numbers, dates, amounts) are left alone. Images cannot be redacted, so they are not sent while hiding is on. The receipt shows "12 personal data items hidden". It makes no difference with the Local model.
- **Retention per folder.** Folder ⋯ › **Retention…** sets two independent rules: **audio** (keep forever, or delete after 7, 30 or 90 days) and **whole meeting** (keep forever, or after 6 months or 1 year); subfolders inherit from the parent folder, and **Settings › Privacy** has a default. A daily sweep (at start and every 24 h) moves only what expired to the system **Trash** (never a permanent delete), never touches a meeting that is recording or finishing, and tells you once ("3 old audio files were moved to the Trash by the Legal folder rule").
- **Fully local mode** (Settings › Privacy, off by default): only the Local model provider; web search, tools and MCPs, the war room with the internet, Google Calendar, update checks and transcription model downloads are blocked, and the app's network layer refuses anything that is not localhost (see [Local model](#local-model-no-internet)).
- Questions across meetings and follow-up drafts send, to the provider **you** chose, only the notes and a few transcript passages of the meetings they need (at most 8, with a size limit). Search runs entirely on your Mac.
- Everything Rice creates (audio, transcripts, notes, chats, settings) lives in folders and files only your user can read (permissions 0700/0600). Keys and tokens are kept in the macOS Keychain.
- The AI CLIs run without tools that touch your files (Claude with no tools; Codex with shell, browser, computer and plugins turned off; OpenCode with every permission denied; Antigravity inside a macOS sandbox that only allows writing to an empty temporary folder).
- Memory across meetings (on by default, can be turned off): facts stay only on this Mac, in `.rice/memory.jsonl`; what leaves is each meeting’s notes text to the AI provider you chose, one light-model call per meeting, plus the relevant facts alongside chat questions and “What to remember”. These calls show up in the per-meeting receipt (kind “memory”) and respect personal-data redaction, sensitive folders and Fully local mode (with the Local model provider nothing leaves your computer).
- The transcription and voice models are downloaded once and checked by SHA-256. Google Calendar (optional) is read-only; you can use the macOS Calendar instead.
- The app only loads its own local pages: it does not navigate to websites, open windows or request page permissions.
- Screenshots (optional, off by default): they stay in the meeting folder. To decide when to take one, recent parts of the transcript (text) go to the AI you chose; the image only goes if it is an API key.
- Deleting a meeting moves it to the Trash; nothing is kept elsewhere.

![What left this computer: the receipt of a meeting](docs/images/en/39-privacy-receipt.webp)

![Consent notice toast](docs/images/en/40-consent.webp)

![Fully local mode in Settings › Privacy, with the badge in the sidebar](docs/images/en/38-fully-local.webp)

![Folder retention](docs/images/en/41-retention.webp)

## License

MIT — see [LICENSE](LICENSE).
