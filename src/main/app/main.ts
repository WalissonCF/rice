import { access, appendFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { availableParallelism, homedir, totalmem } from 'node:os';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { app, BrowserWindow, clipboard, ClipboardItem, dialog, globalShortcut, ipcMain, Menu, session as electronSession, nativeImage, nativeTheme, Notification, powerMonitor, safeStorage, screen, shell, systemPreferences, Tray } from 'electron';
import { IcsSubscription, ICS_REFRESH_MS, type IcsResponse } from '../calendar/ics-feed';
import { CalendarFeed } from '../calendar/calendar-feed';
import { fromEventKit } from '../calendar/google-events';
import { GoogleAuth } from '../calendar/google-auth';
import { buildChatPrompt, chatSystemPrompt } from '../claude/prompts';
import { modelCatalog } from '../ai/catalog';
import { cachedAgyModels } from '../ai/agy-cli';
import { createActiveRunner, createLightRunner, lightModelFor, isModelFor, resolveAiSettings, type AiSettings, type RunnerDeps } from '../ai/factory';
import { clearSecret, loadSecret, migrateLegacyToken, saveSecret, validateKey, type TokenCrypto } from '../ai/secrets';
import { aiStatus, invalidateAiStatus, listModels, testProvider } from '../ai/service';
import { AiError, hasKeyField, isProvider, PROVIDER_LABEL, type AiRunner, type WebSource } from '../ai/types';
import { toLocalIso } from '../../shared/naming';
import { isTranscriptionLanguage, type FolderRetention, type MeetingMeta, type NoteTemplateInput, type TranscriptionLanguage } from '../../shared/types';
import { canDeleteMeeting, deleteMeetingDir } from './delete-meeting';
import { AsrService } from '../session/asr-service';
import { AudioCapture } from '../session/audio-capture';
import { DetectorClient } from '../session/detector-client';
import { MeetingSession, type SessionState } from '../session/meeting-session';
import { listVersions, readVersion, restoreVersion } from '../store/notes-versions';
import { generateNotes, onNotesDone, regenerateNotes, type LanguageResolver, type TemplateResolver } from '../session/notes';
import { registerMemory } from '../memory/ipc';
import { MemoryService } from '../memory/service';
import { logError, logWarn } from '../log';
import { tightenAppData } from '../store/permissions';
import { probeClaudeMcpServers } from '../claude/runner';
import { registerAttachments } from '../attachments/ipc';
import { ScreenshotCapture, clockOfSegmentText, nearestSegmentClock } from '../screenshots/capture';
import { grabFromFolder, grabScreen, screenPermission } from '../screenshots/grab';
import { registerScreenshots } from '../screenshots/ipc';
import { decideCapture, judgeShot, providerSeesImages } from '../screenshots/relevance';
import { attachmentImages, attachmentsContext } from '../attachments/store';
import { createWarRoom } from '../warroom/ipc';
import { planGeminiMigration } from '../ai/migrate';
import { deleteIdeaTemplate, listIdeaTemplates, localizeIdeaTemplate, restoreBuiltinIdeaTemplate, saveIdeaTemplate } from '../warroom/idea-templates';
import { contextFacts, readConfig as readWarRoomConfig, writeConfig as writeWarRoomConfig } from '../warroom/store';
import { discardEmptyDraft, findEmptyDraft, reuseDraft } from '../store/drafts';
import { normalizeMaxCycles } from '../warroom/engine';
import { checkWorkFolder } from '../warroom/folder';
import { runChat } from '../ai/chat-run';
import { applyMic, cleanInputs, isMicSwitch, normalizeMic, shortMicName } from '../audio/mic-info';
import { asrChoiceOf, machineProfile, type AsrChoice } from '../platform/profile';
import { setLightFactor, getLightFactor } from '../platform/light';
import { loginItemApplicable, loginItemOptions, startedAtLogin } from './login-item';
import { notificationOptions } from './notification-options';
import { appAbout } from '../update/about';
import { createWinUpdater, nsisInstall, type UpdaterLike, type WinUpdateState } from '../update/win-updater';
import { readBuildInfo, type BuildInfo } from '../update/build-info';
import { createUpdateChecker, lastCheckOf, RELEASES_URL, type UpdateState } from '../update/check';
import { createCheckNow } from '../update/check-now';
import { shouldNotify } from '../update/notice';
import { openUpdateInTerminal } from '../update/terminal';
import { consentOffer, normalizeConsentText } from '../privacy/consent';
import { isSensitiveFolder } from '../privacy/folder-rules';
import { planSweep, sweepNotice, type SweepAction, type SweepMeeting } from '../privacy/retention';
import { appendEgress, buildReceipt, readEgress, receiptText, withEgressContext } from '../privacy/egress';
import { receiptHtml } from '../privacy/receipt-html';
import { installNetworkGuard, isLocalMode, setLocalMode } from '../privacy/local-mode';
import { isLocalServerId, isNumCtx, isVisionModel, type LocalServerId, parseLocalUrl, smallestLocalModel, DEFAULT_NUM_CTX } from '../ai/local-model';
import { localBudget, type ContextBudget } from '../ai/context-budget';
import { cachedLocalServer } from '../ai/service';
import { installedLocalModels } from '../ai/factory';
import { createShortcutManager, toggleRecording, SHORTCUT_NONE } from './record-shortcut';
import { normalizeSavedPrompts } from '../../shared/saved-prompts';
import { webSearchSupported } from '../ai/web-search';
import { guardedIpc, lockdownWebContents } from './hardening';
import { decideMeetingEnd } from '../session/stop-policy';
import { endKey, PromptTracker, shouldOfferRecording, shouldPromptEnd, shouldPromptStart, titleFor } from '../session/prompt-policy';
import { recoverInterrupted } from '../session/recovery';
import { damagedEntry, readMetaIfUsable, repairMeta } from '../store/meta-repair';
import { recoverMeeting } from '../session/recover-meeting';
import { alertPosition, AlertScheduler, ALERT_HEIGHT, ALERT_WIDTH, isHttpsUrl } from './meeting-alert';
import { type AlertPlan } from '../calendar/google-events';
import { LevelThrottle, NubController, NUB_BAR_WIDTH, NUB_HEIGHT, type Point } from './nub';
import { findAppIcon, findTrayIcons, findWinIcon, findWinTrayIcon } from './app-icon';
import { isMac, isWindows, remindersSupported, systemCalendarSupported } from '../platform';
import { applyMicDevice, listMicInputs } from '../platform/mic-input';
import { alternatives, isVirtual, parseInputs, pickMic, probeInputs, probeable, type MacInput, type MicPick } from '../platform/mic-pick';
import { MicMuteMonitor } from '../session/mic-mute';
import { currentPlan, normalizeMode, setTranscriberMode, type TranscriberMode } from '../asr/transcriber-plan';
import { systemPanelUrl, titleBarOverlay } from '../platform/system';
import { fromSystemLocale, locale, setLanguage, t, tn, type UiLanguage } from '../i18n';
import { copyNotes, draftEmail, exportInfo, exportPdf, openMail, type ShareDeps } from '../share/actions';
import { pdfFileName, renderPdf, uniquePath } from '../share/pdf';
import { createNubIpc, lastTranscriptLines } from './nub-ipc';
import { parseStartInput } from './start-input';
import { SearchIndex } from '../search/index';
import { handleSearch } from '../search/handler';
import { askAcrossMeetings } from '../search/global-chat';
import { readGlobalConversation, startNewGlobalConversation } from '../store/global-chat';
import { createFolder, deleteFolder, folderExists, folderPaths, moveFolder, parseRetention, readFolders, renameFolder, reorderFolders, setFolderPrivacy, setMeetingFolder } from '../store/folders';
import { localizeTemplate } from '../templates/builtin';
import { deleteTemplate, getTemplate, listTemplates, resolveTemplate, restoreBuiltinTemplate, saveTemplate } from '../templates/store';
import { agyBinary, claudeBinary, codexBinary, opencodeBinary, isInsideRoot, tildify, riceAudioBinary, riceDetectorBinary } from './paths';
import {
  appendChat,
  createMeeting,
  listMeetingDirs,
  readChat,
  readMeetingText,
  readMeta,
  renameMeeting,
  updateMeta,
  setSpeakerName,
} from '../store/meeting-files';
import { modelsDir } from '../asr/config';
import { ensureModel, SPEAKER_MODEL } from '../asr/model-download';
import { OnlineSpeakerClusterer } from '../asr/speaker-cluster';
import { OnnxSpeakerEmbedder } from '../asr/speaker-embedder';
import { createClusteringIdentifier, removeLegacyVoiceFiles, type SpeakerIdentifier } from '../asr/speaker-identifier';
import { mergeVocabulary, parseVocabulary, whisperVocabularyPrompt } from '../asr/vocabulary';
import { applySpeakerNames, cleanSpeakerName } from '../../shared/speakers';
import { suggestSpeakerNames } from '../session/speaker-names';
import { chatTranscript } from '../session/chat-context';
import { configureLongNotes, type NotesProgress } from '../session/long-notes';
import type { AlertActionKind } from '../session/alerts';
import { saveAnnotations } from '../store/annotations';

type Settings = { /** Última pasta onde um PDF foi salvo (padrão: Downloads). */ exportDir?: string; ai?: unknown; transcriptionLanguage?: TranscriptionLanguage; uiLanguage?: UiLanguage; root: string; keepAudio?: boolean; calendarAsked?: boolean; onboardingDone?: boolean; nubPosition?: Point; defaultTemplateId?: string; vocabulary?: string; vocabularyAttendees?: boolean; /** Acima disso (em caracteres) as notas usam extração por partes; padrão 60000. */ notesDirectMaxChars?: number; /** Beta: separa "Outros" em Pessoa 1, 2… (modelo de voz local de 27 MB, baixado na primeira vez). */ identifySpeakers?: boolean; /** Opt-in "por sua conta e risco": ferramentas MCP só no chat (desligado por padrão). */ chatTools?: boolean; /** "Procurar atualizações": uma consulta anônima por dia ao GitHub (padrão: ligado). */ savedPrompts?: string[]; /** Ocultar dados pessoais ao enviar para a IA (as pastas sensíveis ligam por conta própria). */ redactPii?: boolean; /** Guarda padrão (as pastas podem definir a própria). */ retentionDefault?: FolderRetention; /** Aviso de consentimento ao gravar (padrão: ligado) e o texto próprio (vazio = o padrão no idioma da reunião). */ consentRemind?: boolean; consentText?: string; /** Modo 100% local: nada usa a rede (só localhost); só o provedor Modelo local. */ fullyLocal?: boolean; /** Atalho global de gravar/parar (padrão ⌥⌘R; "none" = nenhum). */ recordShortcut?: string; checkUpdates?: boolean; /** Mac: escolher o microfone sozinho ao gravar (padrão: ligado). */ micAuto?: boolean; /** Windows: abrir com o Windows, só na bandeja (padrão: desligado). */ launchAtLogin?: boolean; /** Windows: id do microfone escolhido (ausente = padrão do Windows). */ micDevice?: string; /** Modelo de transcrição: automático (pela memória), leve ou completo. */ asrModel?: AsrChoice; /** Última consulta de versão (data e último commit do `main`). */ updateCheck?: UpdateState; /** Último template de ideias escolhido (padrão das reuniões novas). */ lastIdeaTemplate?: string; /** Avisos de uma vez só na tela de IA (ex.: o Gemini por assinatura foi descontinuado). */ aiNotices?: { geminiSub?: boolean }; /** Limite de ciclos de cada trilha da War room por reunião (0 = sem limite; padrão 120). */ warroomMaxCycles?: number; /** Minutos sem fala até o "ainda gravando?" (padrão 15; 0 desliga). */ inactivityMinutes?: number; /** Apps para os quais o usuário disse "não perguntar mais". */ mutedApps?: string[]; /** Mostrar os lembretes de hoje no Início (padrão: ligado, se o macOS permitir). */ showReminders?: boolean; /** Capturas de tela durante a gravação (desligado por padrão; só liga depois do aviso). */ screenshots?: boolean; /** Memória entre reuniões (padrão: ligada). */ memory?: boolean; /** Domínios do próprio usuário (do participante `self` da agenda), para a memória não tratar a própria empresa como cliente. */ memoryOwnDomains?: string[]; /** Aviso local quando uma pendência minha vence (padrão: ligado). */ followupNotify?: boolean; };

// Modo 100% local: o fetch global só fala com localhost enquanto o modo estiver ligado (rede de segurança por baixo dos bloqueios de cada recurso)
installNetworkGuard();

const tokenCrypto: TokenCrypto = {
  encrypt: (plain) => safeStorage.encryptString(plain),
  decrypt: (data) => safeStorage.decryptString(data),
};
const googleAuth = new GoogleAuth({
  dir: app.getPath('userData'),
  crypto: tokenCrypto,
  fetch: (url, init) => fetch(url, init),
  openExternal: (url) => shell.openExternal(url),
});
// Modo 100% local: a agenda do Google fica "desconectada" (as credenciais ficam como estão); o Calendário do macOS segue valendo
const calendarFeed = new CalendarFeed({ accessToken: () => googleAuth.accessToken(), status: async () => (isLocalMode() ? { connected: false } : googleAuth.status()) }, (url, init) => fetch(url, init));
// Agenda por link (ICS): a URL é segredo, guardada cifrada (DPAPI no Windows, Keychain no Mac); o Modo 100% local bloqueia a leitura
const icsSub = new IcsSubscription({
  dir: app.getPath('userData'),
  crypto: tokenCrypto,
  fetch: (url, init) => fetch(url, init) as unknown as Promise<IcsResponse>,
  blocked: () => (isLocalMode() ? t('local.mode.blocked.ics') : null),
});
async function refreshIcs(): Promise<void> {
  if (isLocalMode() || !(await icsSub.status()).configured) return calendarFeed.setIcs([]);
  const events = await icsSub.refresh();
  if (events) calendarFeed.setIcs(events); // em erro, a lista anterior fica
}
const getSecret: RunnerDeps['getSecret'] = (provider) =>
  safeStorage.isEncryptionAvailable() ? loadSecret(app.getPath('userData'), provider, tokenCrypto) : Promise.resolve(null);
const aiDeps = (): RunnerDeps => ({
  getSecret,
  binaries: { claude: claudeBinary(), codex: codexBinary(), opencode: opencodeBinary(), agy: agyBinary() },
  workDir: app.getPath('userData'),
  local: async () => (await currentAiSettings()).local ?? {},
  // ocultar dados pessoais: opção global, ou a reunião (qualquer uma, no chat entre reuniões) está numa pasta sensível
  shouldRedact: async (ctx) => {
    const settings = await loadSettings();
    if (settings.redactPii === true) return true;
    const dirs = ctx?.dirs ?? (ctx?.dir ? [ctx.dir] : []);
    if (dirs.length === 0) return false;
    const folders = await readFolders(settings.root);
    if (!folders.some((f) => f.sensitive)) return false;
    for (const dir of dirs) if (isSensitiveFolder(folders, (await readMeta(dir).catch(() => null))?.folderId)) return true;
    return false;
  },
  // recibo de privacidade: cada chamada à IA vira uma linha de metadados na reunião (sem conteúdo); sem reunião, num arquivo do app
  egress: async (dirs, record) => {
    if (dirs.length === 0) await appendFile(join(app.getPath('userData'), 'egress-unattributed.jsonl'), `${JSON.stringify(record)}\n`, { mode: 0o600 });
    for (const dir of dirs) await appendEgress(dir, record).catch(() => {});
  },
  ...(process.env.RICE_TEST_MCP_CONFIG ? { testMcpConfig: process.env.RICE_TEST_MCP_CONFIG } : {}),
  // SÓ INSTÂNCIAS DE TESTE: as APIs de IA falam com um servidor local falso (RICE_TEST_AI_BASE_URL) em vez da internet
  ...(TEST_INSTANCE && process.env.RICE_TEST_AI_BASE_URL ? { fetch: (url: string, init: RequestInit) => fetch(url.replace(/^https:\/\/[^/]+/, process.env.RICE_TEST_AI_BASE_URL ?? ''), init) } : {}),
});
let memoryRef: MemoryService | null = null; // memória entre reuniões (criada em registerIpc)
let lightRunner: AiRunner | null = null; // modelo leve do provedor ativo: etapas simples (extrações, sugestões, ideias)
const supportsWarRoom = (p: string) => p === 'claude-sub' || p === 'chatgpt-sub';
let aiMigrated = false;
/** Gemini por assinatura foi descontinuado: troca o provedor salvo uma vez e deixa um aviso para a tela de IA (`aiNotices.geminiSub`). */
async function migrateAiProvider(): Promise<void> {
  if (aiMigrated) return;
  aiMigrated = true;
  const settings = await loadSettings();
  const plan = planGeminiMigration(settings.ai, Boolean(await getSecret('gemini-api')));
  if (plan) await saveSettings({ ...settings, ai: plan.ai, aiNotices: { ...(settings.aiNotices ?? {}), geminiSub: true } });
}
const currentAiSettings = async (): Promise<AiSettings> => {
  await migrateAiProvider();
  return resolveAiSettings((await loadSettings()).ai);
};
async function updateAiSettings(change: (ai: AiSettings) => AiSettings): Promise<AiSettings> {
  const settings = await loadSettings();
  const ai = change(resolveAiSettings(settings.ai));
  await saveSettings({ ...settings, ai });
  return ai;
}

const settingsPath = () => join(app.getPath('userData'), 'settings.json');

let cachedSettings: Settings = { root: join(homedir(), 'Rice'), keepAudio: true };

async function loadSettings(): Promise<Settings> {
  try {
    cachedSettings = { keepAudio: true, ...(JSON.parse(await readFile(settingsPath(), 'utf8')) as Settings) };
  } catch {
    cachedSettings = { root: join(homedir(), 'Rice'), keepAudio: true };
  }
  setLocalMode(cachedSettings.fullyLocal === true); // o Modo 100% local vale desde a primeira leitura
  if (isWindows()) applyMicDevice(process.env, cachedSettings.micDevice); // o rice-audio.exe herda RICE_MIC_DEVICE
  setTranscriberMode(cachedSettings.asrModel); // só o Windows usa (o Mac ignora o modo)
  return cachedSettings;
}

/** Template da reunião; sem `templateId` (ou se ele sumiu) vale o padrão das configurações, depois "Reunião geral". */
const resolveMeetingTemplate: TemplateResolver = async (templateId) => {
  const { root, defaultTemplateId } = await loadSettings();
  const wanted = templateId ? await getTemplate(root, templateId) : null;
  return wanted ?? (await resolveTemplate(root, defaultTemplateId));
};

// tudo o que o app cria (reuniões, áudio, transcrições, configurações, segredos, cópias) nasce só para o usuário: 0700/0600
process.umask(0o077);

/** Páginas locais do app; é a única origem que o IPC e a navegação aceitam (ver hardening.ts). */
const RENDERER_DIR = join(__dirname, '..', 'src', 'renderer');
const { handle, on } = guardedIpc(ipcMain, RENDERER_DIR);
/** Ferramentas de desenvolvimento só com `RICE_DEBUG=1`. */
const DEV_TOOLS = process.env.RICE_DEBUG === '1';

/** Idioma do app: o escolhido nas configurações ou, na primeira vez, o do sistema. */
let uiLanguageNow: UiLanguage = 'pt-BR';
// os preloads leem o idioma de forma síncrona, antes da primeira renderização
on('i18n:language', (event) => {
  event.returnValue = uiLanguageNow;
});

/**
 * Semáforos acompanham o zoom da página (⌘+/⌘−): a faixa do topo tem 48px CSS, então o centro dela fica em 24·zoom px
 * de tela; os semáforos (≈12px) são reposicionados para esse centro. Sem zoom: y 18, como no trafficLightPosition.
 */
on('ui:titlebar-zoom', (event, raw: unknown) => {
  const zoom = typeof raw === 'number' && Number.isFinite(raw) && raw >= 0.25 && raw <= 5 ? raw : 1;
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win !== window) return;
  if (isWindows()) win.setTitleBarOverlay(titleBarOverlay(nativeTheme.shouldUseDarkColors, zoom)); // botões do Windows na altura da faixa
  else if (isMac()) win.setWindowButtonPosition({ x: 16, y: Math.max(4, Math.round(24 * zoom - 6)) });
});

async function currentUiLanguage(): Promise<UiLanguage> {
  return (await loadSettings()).uiLanguage ?? fromSystemLocale(app.getLocale());
}

/** Idioma das notas e do chat de uma reunião: `meta.language`, senão o padrão das configurações. */
/** Beta "Identificar participantes": baixa o modelo (uma vez) e sobe o processo de voz; qualquer falha grava sem identificar. */
async function createSpeakerIdentifier(dir: string): Promise<SpeakerIdentifier | null> {
  if (!(await loadSettings()).identifySpeakers) return null;
  try {
    const model = await ensureModel(SPEAKER_MODEL, modelsDir(), { onProgress: (p) => send('asr:download-progress', p) });
    const embedder = await OnnxSpeakerEmbedder.create(model);
    return createClusteringIdentifier(embedder); // só em memória: a assinatura de voz nunca vai para o disco
  } catch (err) {
    send('session:session-warning', { message: t('speakers.unavailable', { error: (err as Error).message }) });
    return null;
  }
}

/** Progresso da geração de notas por reunião (para a UI que abre no meio). */
const notesProgress = new Map<string, NotesProgress>();

/** Termos da reunião: os do usuário (Configurações) e, se ligado, os participantes do evento da agenda. */
async function meetingTerms(meta: MeetingMeta): Promise<string[]> {
  const settings = await loadSettings();
  return mergeVocabulary(parseVocabulary(settings.vocabulary), settings.vocabularyAttendees === false ? [] : meta.participants ?? []);
}

/** Ao começar a gravar: guarda no meta os participantes do evento (o evento sai da agenda depois) e devolve o prompt do whisper. */
async function whisperVocabularyFor(dir: string): Promise<string> {
  let meta = await readMeta(dir);
  const names = meta.calendarEventId ? calendarFeed.events().find((e) => e.id === meta.calendarEventId)?.attendeeNames : undefined;
  if (names?.length && !meta.participants) meta = await updateMeta(dir, (m) => ({ ...m, participants: names.slice(0, 50) }));
  return whisperVocabularyPrompt(await meetingTerms(meta));
}

const notesLanguageOf: LanguageResolver = async (meta) => {
  const settings = await loadSettings();
  const language = meta.language ?? settings.transcriptionLanguage ?? 'pt';
  const headings = language === 'en' ? 'en' : language === 'pt' ? 'pt-BR' : await currentUiLanguage();
  return { language, headings };
};

async function saveSettings(settings: Settings): Promise<void> {
  await mkdir(app.getPath('userData'), { recursive: true });
  await writeFile(settingsPath(), JSON.stringify(settings, null, 2));
  cachedSettings = settings;
}

/** O rice-audio herda as permissões do app: o próprio Electron precisa pedir o microfone. */
async function ensureMicAccess(): Promise<void> {
  const status = systemPreferences.getMediaAccessStatus('microphone');
  if (status === 'granted') return;
  // Windows: não há diálogo do app; o acesso é do usuário em Configurações > Privacidade > Microfone (só 'denied' bloqueia)
  if (isWindows()) {
    if (status === 'denied') throw new Error(t('err.mic-permission'));
    return;
  }
  const granted = await systemPreferences.askForMediaAccess('microphone');
  if (!granted) {
    throw new Error(t('err.mic-permission'));
  }
}

const appIconPath = findAppIcon(__dirname);
let window: BrowserWindow | null = null;
let nubWindow: BrowserWindow | null = null;
let nub: NubController | null = null;
let tray: Tray | null = null;
let session: MeetingSession | null = null;
let detector: DetectorClient | null = null;
let quitting = false;
let recoveredCount = 0;
let asrStatus: { state: 'idle' | 'loading' | 'ready' | 'failed'; error?: string; downloadPercent?: number } = { state: 'idle' };
const chats = new Map<number, AbortController>();
const searchIndex = new SearchIndex();

const END_PROMPT_TIMEOUT_MS = 60_000;
const pendingPrompts = new PromptTracker();
/** Apps de reunião usando o microfone agora (fim de um deles com outro ativo não encerra a gravação). */
const activeMeetingApps = new Set<string>();

/** Windows: gravando uma chamada do Discord, o detector lê quem fala para dar nome aos trechos de "Outros". Fora disso, não lê nada. */
function syncCallSpeakers(): void {
  detector?.watchSpeakers(process.platform === 'win32' && session?.state === 'recording' && activeMeetingApps.has('Discord') ? 'Discord' : null);
}
// Referências fortes: o GC pode descartar a Notification e perder o clique.
const liveNotifications = new Set<Notification>();

/** Mostra uma notificação; `onAction` roda no clique (corpo ou botão). Resolve quando ela some. */
function notify(opts: { title: string; actionText: string; onAction: () => void; secondaryText?: string; onSecondary?: () => void; onClose?: (acted: boolean) => void }): { close: () => void } {
  const n = new Notification(notificationOptions({ title: opts.title, actionText: opts.actionText, secondaryText: opts.secondaryText, windows: isWindows(), clickHint: t('notify.click-hint', { action: opts.actionText.toLowerCase() }) }));
  liveNotifications.add(n);
  let done = false;
  const finish = (act: boolean) => {
    if (done) return;
    done = true;
    liveNotifications.delete(n);
    if (act) opts.onAction();
    opts.onClose?.(act);
  };
  n.on('click', () => finish(true));
  n.on('action', (_e, index: number) => {
    if (index === 1 && opts.onSecondary) {
      opts.onSecondary();
      finish(false);
    } else {
      finish(true);
    }
  });
  n.on('close', () => finish(false));
  n.show();
  return { close: () => n.close() };
}

/** Só abre links https (nunca file:, javascript: etc.). */
function openJoinUrl(url: string): boolean {
  if (!isHttpsUrl(url)) return false;
  void shell.openExternal(url);
  return true;
}

/** Aviso "vai começar": pilha de janelinhas no canto superior direito, uma por evento. */
const alertWindows = new Map<string, BrowserWindow>();
let alertScheduler: AlertScheduler | null = null;

function restackAlerts(): void {
  const area = screen.getPrimaryDisplay().workArea;
  [...alertWindows.values()].forEach((win, i) => {
    if (win.isDestroyed()) return;
    const pos = alertPosition(area, i);
    win.setPosition(Math.round(pos.x), Math.round(pos.y));
  });
}

function showAlert(plan: AlertPlan): { close: () => void } {
  if (BENCH) return { close: () => {} };
  const area = screen.getPrimaryDisplay().workArea;
  const pos = alertPosition(area, alertWindows.size);
  const win = new BrowserWindow({
    show: false, x: Math.round(pos.x), y: Math.round(pos.y), width: ALERT_WIDTH + 20, height: ALERT_HEIGHT + 20, resizable: false, minimizable: false, maximizable: false,
    fullscreenable: false, alwaysOnTop: true, skipTaskbar: true, focusable: false, hiddenInMissionControl: true, frame: false, roundedCorners: false, hasShadow: false,
    type: 'panel', transparent: true, backgroundColor: '#00000000',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, devTools: false, preload: join(__dirname, 'alert-preload.cjs') },
  });
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  win.loadFile(join(__dirname, '..', 'src', 'renderer', 'alert.html'));
  const hm = (iso: string) => new Date(iso).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });
  win.webContents.on('did-finish-load', () =>
    win.webContents.send('alert:data', { title: plan.event.title, time: `${hm(plan.event.start)} – ${hm(plan.event.end)}`, color: plan.event.color ?? null, hasLink: isHttpsUrl(plan.event.joinUrl) }),
  );
  win.once('ready-to-show', () => win.showInactive());
  win.on('closed', () => {
    alertWindows.delete(plan.key);
    restackAlerts();
  });
  alertWindows.set(plan.key, win);
  return { close: () => !win.isDestroyed() && win.destroy() };
}

function startFromCalendar(ev: { id: string; title: string; joinUrl?: string }, openLink: boolean): void {
  if (openLink && ev.joinUrl) openJoinUrl(ev.joinUrl);
  void (async () => {
    const { root } = await loadSettings();
    let dir: string | undefined;
    for (const d of await listMeetingDirs(root)) {
      const meta = await readMeta(d).catch(() => null);
      if (meta?.state === 'draft' && meta.calendarEventId === ev.id) dir = d;
    }
    startFromPrompt({ title: ev.title, trigger: 'calendar', calendarEventId: ev.id, ...(dir ? { dir } : {}) });
  })();
}

function startFromPrompt(input: { title: string; trigger: 'mic' | 'calendar'; app?: string; calendarEventId?: string; dir?: string }): void {
  if (session?.state !== 'idle') return;
  ensureMicAccess()
    .then(() => session?.start(input))
    .then((dir) => (dir ? rememberParticipants(dir, input.calendarEventId) : undefined))
    .catch((err: Error) => dialog.showErrorBox('Rice', err.message));
}

/** Último acesso ao Calendário do macOS informado pelo detector: granted, denied, notDetermined (ou unknown antes da primeira resposta). */
let calendarAccess = systemCalendarSupported() ? 'unknown' : 'unsupported'; // Windows: a agenda vem só do Google
/** Idem para os Lembretes do macOS (permissão própria, pedida só quando o usuário clica em Permitir). */
let remindersAccess = remindersSupported() ? 'unknown' : 'unsupported';

/** Lista do Início (e avisos): Calendário do macOS dos próximos 7 dias, com os de dia inteiro. */
async function refreshEventKit(): Promise<void> {
  if (!detector || calendarAccess !== 'granted') return;
  const from = new Date();
  from.setHours(0, 0, 0, 0);
  const to = new Date(from.getTime() + 8 * 86_400_000);
  const events = await detector.listEvents(from, to);
  calendarFeed.setEventKit(events.map(fromEventKit));
}

function setupDetector(): void {
  const d = new DetectorClient(riceDetectorBinary());
  detector = d;
  d.on('error', () => {});
  d.on('calendar-access', (status: string) => {
    if (!systemCalendarSupported()) return; // o detector do Windows responde "unsupported"; o estado já está fixo
    calendarAccess = status;
    if (status === 'granted') void refreshEventKit();
    if (window && !window.isDestroyed()) window.webContents.send('calendar:changed', null); // o passo "Agenda" do guia relê o status
    if (status !== 'notDetermined' || cachedSettings.calendarAsked) return;
    void saveSettings({ ...cachedSettings, calendarAsked: true }).then(() => d.requestCalendarAccess());
  });
  d.on('reminders-access', (status: string) => {
    if (!remindersSupported()) return;
    remindersAccess = status;
    send('reminders:changed', null);
  });
  d.on('reminders-changed', () => send('reminders:changed', null));
  d.on('speaker-active', ({ name, speaking }: { name: string; speaking: boolean }) => session?.markSpeaker(name, speaking));
  d.on('meeting-app-started', async ({ app: appName }: { app: string }) => {
    activeMeetingApps.add(appName);
    syncCallSpeakers();
    const key = appName;
    if (!session || !shouldPromptStart({ state: session.state, pending: pendingPrompts, key })) return;
    pendingPrompts.add(key);
    const event = await d.currentEvent().catch(() => null);
    if (session.state !== 'idle' || !shouldOfferRecording({ app: appName, muted: cachedSettings.mutedApps ?? [], calendarEvidence: event !== null, lastPromptAt: pendingPrompts.lastDeclinedAt(appName), now: Date.now() })) {
      pendingPrompts.delete(key);
      return;
    }
    const title = titleFor({ calendarTitle: event?.title, app: appName });
    notify({
      title: t('notify.record.title', { title }),
      actionText: t('notify.record.action'),
      onAction: () => {
        pendingPrompts.accepted(appName);
        startFromPrompt({ title, trigger: 'mic', app: appName, calendarEventId: event?.id });
      },
      secondaryText: t('notify.record.mute', { app: appName }),
      onSecondary: () => void saveSettings({ ...cachedSettings, mutedApps: [...new Set([...(cachedSettings.mutedApps ?? []), appName])] }),
      onClose: (acted) => {
        pendingPrompts.delete(key);
        if (!acted) pendingPrompts.declined(appName); // fechou sem aceitar: respeita o intervalo mínimo
      },
    });
  });
  d.on('calendar-changed', () => void refreshEventKit());
  // Mac: o detector informa a entrada de áudio padrão ({id, name} ou null) ao subir e quando ela muda (o Rice sempre captura a entrada padrão do macOS)
  d.on('default-input', (input: { id?: string; name?: string } | null) => {
    const name = normalizeMic({ name: input?.name })?.name;
    if (!name) return;
    lastDefaultInput = name;
    if (micFromHelper && session && session.state !== 'idle') return; // gravando: o helper informa o microfone realmente aberto (pode não ser o padrão)
    void onMic({ name, isDefault: true });
  });
  d.on('upcoming', (ev: { id: string; title: string; start: string; end: string; url: string | null }) => {
    calendarFeed.addEventKit(fromEventKit(ev));
  });
  d.on('meeting-app-ended', async ({ app: appName }: { app: string }) => {
    activeMeetingApps.delete(appName);
    syncCallSpeakers();
    const s = session;
    const rec = s?.recording;
    if (!s || !rec || !s.currentDir) return;
    const meta = await readMeta(s.currentDir).catch(() => null);
    if (!shouldPromptEnd({ state: s.state, metaApp: meta?.app, app: appName, pending: pendingPrompts })) return;
    // R-33: gravação curta, sem fala dos outros ou outra chamada ativa = ignora; só para sozinho no fim do evento da agenda
    const event = meta?.calendarEventId ? calendarFeed.events().find((e) => e.id === meta.calendarEventId) : undefined;
    const decision = decideMeetingEnd({ recordedMs: rec.recordedMs, othersSpoke: rec.othersSpoke, calendarEnd: event ? new Date(event.end) : null, now: new Date(), otherCallActive: activeMeetingApps.size > 0 });
    if (decision === 'ignore') return;
    const key = endKey(appName);
    pendingPrompts.add(key);
    const dir = s.currentDir;
    let n: { close: () => void } | null = null;
    const stop = () => {
      clearTimeout(timer);
      if (s.state === 'recording') void s.stop().catch((err) => logError('stop failed', err));
    };
    const timer = setTimeout(() => {
      n?.close();
      if (decision === 'ask-then-stop' && s.state === 'recording' && s.currentDir === dir) {
        stop();
        s.alerts.set({ id: 'auto-stopped', level: 'info', message: t('alert.meeting-ended'), action: { kind: 'resume-recording', label: t('alert.action.resume') }, dismissible: true, dir });
        setTimeout(() => s.alerts.clear('auto-stopped'), 30_000).unref?.();
      }
    }, END_PROMPT_TIMEOUT_MS);
    n = notify({
      title: t('notify.end.title'),
      actionText: t('notify.end.action'),
      onAction: stop,
      onClose: () => pendingPrompts.delete(key),
    });
  });
  d.start();
}

/** `RICE_BENCH=1`: instância de medição, sem janelas visíveis, nub, alertas, bandeja nem ícone no Dock. */
const BENCH = process.env.RICE_BENCH === '1';
/** Plataforma que o renderer mostra. Só as instâncias de teste (RICE_BENCH) aceitam RICE_FAKE_PLATFORM, para os prints do layout do Windows no Mac. */
const PLATFORM_FOR_UI = BENCH && process.env.RICE_FAKE_PLATFORM === 'win32' ? 'win32' : process.platform;

function createWindow(): void {
  if (window) {
    if (!BENCH) window.show();
    return;
  }
  window = new BrowserWindow({
    show: !BENCH,
    width: 1200,
    height: 780,
    title: 'Rice',
    ...(isWindows()
      ? { titleBarStyle: 'hidden' as const, titleBarOverlay: titleBarOverlay(nativeTheme.shouldUseDarkColors) } // botões do Windows à direita, sobre a faixa de 48px
      : { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 16, y: 18 } }),
    ...(appIconPath ? { icon: appIconPath } : {}),
    webPreferences: { preload: join(__dirname, 'preload.cjs'), additionalArguments: [`--rice-platform=${PLATFORM_FOR_UI}`], contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, devTools: DEV_TOOLS },
  });
  window.loadFile(join(__dirname, '..', 'src', 'renderer', 'index.html'));
  window.on('focus', updateNub);
  window.on('blur', updateNub);
  window.on('show', updateNub);
  window.on('hide', updateNub);
  window.on('minimize', updateNub);
  window.on('restore', updateNub);
  window.on('closed', () => {
    window = null;
    updateNub();
  });
  updateNub();
}

function updateNub(): void {
  const w = window && !window.isDestroyed() ? window : null;
  nub?.update({
    recording: session?.state === 'recording',
    paused: session?.paused === true,
    mainFocused: Boolean(w?.isFocused()),
    mainVisible: Boolean(w?.isVisible() && !w.isMinimized()),
  });
}

function showMainWindow(): void {
  if (!window || window.isDestroyed()) {
    createWindow();
    return;
  }
  if (window.isMinimized()) window.restore();
  if (BENCH) return;
  window.show();
  window.focus();
}

function createNub(): NubController {
  return new NubController({
    createWindow: () => {
      const win = new BrowserWindow({
        show: false, width: NUB_BAR_WIDTH, height: NUB_HEIGHT, resizable: false, acceptFirstMouse: true, minimizable: false, maximizable: false, fullscreenable: false,
        closable: true, alwaysOnTop: true, skipTaskbar: true, focusable: false, hiddenInMissionControl: true, frame: false,
        roundedCorners: false, hasShadow: false, type: 'panel', transparent: true, backgroundColor: '#00000000',
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, devTools: false, preload: join(__dirname, 'nub-preload.cjs') },
      });
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
      win.loadFile(join(__dirname, '..', 'src', 'renderer', 'nub.html'));
      win.webContents.on('did-finish-load', () => nub?.resendState());
      win.on('moved', () => nub?.persistPosition());
      win.on('closed', () => (nubWindow = null));
      nubWindow = win;
      return {
        showInactive: () => win.showInactive(),
        hide: () => win.hide(),
        isVisible: () => win.isVisible(),
        isDestroyed: () => win.isDestroyed(),
        getPosition: () => win.getPosition(),
        setPosition: (x, y) => win.setPosition(Math.round(x), Math.round(y)),
        send: (channel, payload) => win.webContents.send(channel, payload),
        destroy: () => win.destroy(),
        setBounds: (b) => win.setBounds({ x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) }),
        setFocusable: (focusable) => win.setFocusable(focusable),
        focus: () => win.focus(),
        setIgnoreMouseEvents: (ignore) => win.setIgnoreMouseEvents(ignore),
      };
    },
    screen,
    mainBounds: () => (window && !window.isDestroyed() ? window.getBounds() : null),
    savedPosition: () => cachedSettings.nubPosition,
    savePosition: (position) => void saveSettings({ ...cachedSettings, nubPosition: position }).catch((err) => logError('nub position', err)),
  });
}

/** Menu do app (Editar, Janela…) no idioma escolhido; Configurações… (⌘,) abre a tela de configurações. */
function buildAppMenu(): void {
  const openSettings = () => {
    showMainWindow();
    window?.webContents.send('app:open-settings', null);
  };
  const appMenu: Electron.MenuItemConstructorOptions = isWindows()
    ? {
        // Windows: sem o menu do app do Mac (Sobre/Ocultar); Configurações e Sair ficam em "Rice", com atalhos Ctrl
        label: 'Rice',
        submenu: [
          { label: t('menu.settings'), accelerator: 'Control+,', click: openSettings },
          { type: 'separator' },
          { label: t('menu.quit'), role: 'quit' },
        ],
      }
    : {
        label: 'Rice',
        submenu: [
          { label: t('menu.about'), role: 'about' },
          { type: 'separator' },
          { label: t('menu.settings'), accelerator: 'Command+,', click: openSettings },
          { type: 'separator' },
          { label: t('menu.hide'), role: 'hide' },
          { label: t('menu.hide-others'), role: 'hideOthers' },
          { label: t('menu.show-all'), role: 'unhide' },
          { type: 'separator' },
          { label: t('menu.quit'), role: 'quit' },
        ],
      };
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      appMenu,
      {
        label: t('menu.edit'),
        submenu: [
          { label: t('menu.undo'), role: 'undo' },
          { label: t('menu.redo'), role: 'redo' },
          { type: 'separator' },
          { label: t('menu.cut'), role: 'cut' },
          { label: t('menu.copy'), role: 'copy' },
          { label: t('menu.paste'), role: 'paste' },
          { label: t('menu.select-all'), role: 'selectAll' },
        ],
      },
      {
        // Visualizar: tamanho real (⌘0) e zoom (⌘+ / ⌘−) — sem este menu não havia como desfazer o zoom
        label: t('menu.view'),
        submenu: [
          { label: t('menu.actual-size'), role: 'resetZoom' },
          { label: t('menu.zoom-in'), role: 'zoomIn' },
          { label: t('menu.zoom-in'), role: 'zoomIn', accelerator: 'CommandOrControl+=', visible: false, acceleratorWorksWhenHidden: true },
          { label: t('menu.zoom-out'), role: 'zoomOut' },
        ],
      },
      {
        label: t('menu.window'),
        submenu: [
          { label: t('menu.minimize'), role: 'minimize' },
          ...(isMac() ? [{ label: t('menu.zoom'), role: 'zoom' as const }] : []),
          { label: t('menu.close'), role: 'close' },
        ],
      },
    ]),
  );
}

/** Aplica o idioma do app em todo lugar: textos do main, menu, bandeja e janelas abertas (que re-renderizam). */
function applyUiLanguage(language: UiLanguage): void {
  uiLanguageNow = language;
  setLanguage(language);
  buildAppMenu();
  updateTray();
  for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.send('ui:language', language);
}

function updateTray(state: SessionState = session?.state ?? 'idle'): void {
  if (!tray) return;
  // o logo (imagem template) fica sempre; só o texto muda durante a gravação, sem emoji
  const paused = session?.paused === true && state === 'recording';
  if (isMac()) tray.setTitle(paused ? ` ${t('rec.paused').toUpperCase()}` : state === 'recording' ? ' REC' : state === 'finishing' ? ' …' : '');
  else tray.setToolTip(paused ? t('rec.paused') : state === 'recording' ? t('tray.tooltip-recording') : 'Rice'); // Windows: sem texto ao lado do ícone; o estado vai na dica
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: t('tray.record-now'),
        enabled: state === 'idle',
        click: () => {
          ensureMicAccess().then(() => session?.start({ title: t('meeting.default-title'), trigger: 'manual' })).catch((err: Error) => dialog.showErrorBox('Rice', err.message));
        },
      },
      { label: paused ? t('rec.resume') : t('rec.pause'), enabled: state === 'recording', click: () => (paused ? session?.unpause() : session?.pause()) },
      { label: t('tray.stop'), enabled: state === 'recording', click: () => void session?.stop() },
      { type: 'separator' },
      { label: t('tray.open'), click: createWindow },
      { type: 'separator' },
      { label: t('tray.quit'), click: () => app.quit() },
    ]),
  );
}

/** Logo monocromático para a barra de menus: o macOS pinta imagens "template" de claro ou escuro conforme a barra. */
function trayImage(): Electron.NativeImage {
  if (isWindows()) {
    // Windows: a bandeja não pinta "template"; usa o ícone preto ou branco conforme a barra de tarefas (claro/escuro do sistema) e, sem ele, o .ico colorido
    const mono = findWinTrayIcon(__dirname, nativeTheme.shouldUseDarkColorsForSystemIntegratedUI);
    if (mono) return nativeImage.createFromPath(mono);
    const ico = findWinIcon(__dirname);
    return ico ? nativeImage.createFromPath(ico) : nativeImage.createEmpty();
  }
  const files = findTrayIcons(__dirname);
  if (!files) return nativeImage.createEmpty();
  const image = nativeImage.createFromPath(files.x1);
  image.addRepresentation({ scaleFactor: 2, buffer: nativeImage.createFromPath(files.x2).toPNG() });
  image.setTemplateImage(true);
  return image;
}

function createTray(): void {
  tray = new Tray(trayImage());
  tray.setToolTip('Rice');
  if (isWindows()) {
    tray.on('click', createWindow); // no Windows o clique no ícone abre a janela (o menu fica no botão direito)
    nativeTheme.on('updated', () => tray?.setImage(trayImage())); // a barra de tarefas mudou de claro para escuro (ou o contrário)
  }
  updateTray('idle');
}

/** Microfone em uso (informado pelo helper no Windows e pelo detector no Mac): grava na reunião, avisa o renderer e marca trocas. */
type MicNow = { dir: string; name: string; short: string; isDefault: boolean; chosen: boolean; switched: boolean; detected?: boolean; id?: string };
let micNow: MicNow | null = null;
/** Mac: o que a escolha automática decidiu para a gravação atual, e se o helper já informou o microfone aberto. */
let micPick: MicPick | null = null;
let micFromHelper = false;
const muteMonitor = new MicMuteMonitor();
let muteBusy = false;
let lastDefaultInput: string | null = null;
async function onMic(raw: unknown): Promise<void> {
  const info = normalizeMic(raw);
  const dir = session?.currentDir;
  if (!info || !dir || !session || session.state === 'idle') return;
  const chosen = info.chosen || (info.id !== undefined && info.id === (await loadSettings()).micDevice);
  const switched = isMicSwitch(micNow?.dir === dir ? micNow.name : undefined, info.name);
  // Mac: "detectado" = o Rice achou este microfone (em uso por outro app ou o que tinha voz) e não foi escolha do usuário
  const detected = micPick !== null && micPick.uid !== undefined && micPick.uid === info.id && (micPick.reason === 'in-use' || micPick.reason === 'voice');
  micNow = { dir, name: info.name, short: shortMicName(info.name), isDefault: info.isDefault, chosen, switched: false, detected, ...(info.id ? { id: info.id } : {}) };
  await updateMeta(dir, (m) => applyMic(m, info, toLocalIso(new Date()))).catch((err) => logError('mic meta', err));
  send('session:mic', { ...micNow, switched });
}

/** Entradas de áudio do CoreAudio (rice-detector); vazio se o detector não responde. */
async function macInputs(): Promise<MacInput[]> {
  return detector ? parseInputs(await detector.listInputs().catch(() => null)) : [];
}

/**
 * Mac, ao começar a gravar: escolhe o microfone sozinho (em uso por outro app › com voz › padrão) e passa ao rice-audio por RICE_MIC_DEVICE.
 * O tempo todo cabe em ~2 s; estourou ou falhou, segue com a entrada padrão do macOS (o comportamento de sempre).
 */
async function prepareMic(): Promise<void> {
  micPick = null;
  micFromHelper = false;
  delete process.env.RICE_MIC_DEVICE;
  if (process.platform !== 'darwin' || TEST_INSTANCE) return;
  const settings = await loadSettings();
  const work = (async () => {
    const inputs = await macInputs();
    return pickMic({ inputs, fixed: settings.micDevice, auto: settings.micAuto !== false, probe: (ids) => probeInputs(riceAudioBinary(), ids), budgetMs: 1600 });
  })();
  let timer: NodeJS.Timeout | undefined;
  const pick = await Promise.race([work.catch(() => null), new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), 2000); timer.unref(); })]);
  clearTimeout(timer);
  if (!pick) return;
  micPick = pick;
  if (pick.uid) process.env.RICE_MIC_DEVICE = pick.uid;
}

/** Mic ~20 s sem voz com o sistema falando: se OUTRA entrada tem voz agora, avisa (uma vez; de novo só depois de trocar). */
async function checkMuteMic(): Promise<void> {
  if (muteBusy || !session || session.state !== 'recording') return;
  muteBusy = true;
  try {
    const inputs = await macInputs();
    const alts = alternatives(inputs, micNow?.id ?? micPick?.uid ?? inputs.find((i) => i.isDefault)?.id);
    if (alts.length === 0) return;
    const levels = await probeInputs(riceAudioBinary(), alts.map((a) => a.id));
    const best = levels.filter((l) => l.voice === true).sort((a, b) => (b.rmsDb ?? -120) - (a.rmsDb ?? -120))[0];
    const pick = best ? alts.find((a) => a.id === best.id) : undefined;
    if (!pick || session.state !== 'recording') return;
    muteMonitor.markWarned();
    send('session:mic-mute', { id: pick.id, name: pick.name, short: shortMicName(pick.name) });
  } finally {
    muteBusy = false;
  }
}

function send(channel: string, payload: unknown): void {
  if (window && !window.isDestroyed()) window.webContents.send(channel, payload);
}

async function runAlertAction(s: MeetingSession, kind: AlertActionKind, dir?: string, id?: string): Promise<void> {
  switch (kind) {
    case 'open-storage':
      return void (await shell.openExternal(systemPanelUrl('storage')));
    case 'open-mic-privacy':
      return void (await shell.openExternal(systemPanelUrl('microphone')));
    case 'open-audio-privacy':
      return void (await shell.openExternal(systemPanelUrl('audioCapture')));
    case 'stop-recording':
      return s.stop();
    case 'keep-recording':
      return s.keepRecording();
    case 'unpause-recording':
      return s.unpause();
    case 'resume-recording':
      if (id) s.alerts.clear(id);
      if (dir && s.state === 'idle') {
        await ensureMicAccess();
        await s.start({ title: (await readMeta(dir)).title, trigger: 'manual', dir });
      }
      return;
    default:
      void dir; // as demais ações (notas...) entram com os itens que as usam
  }
}

let asrService: AsrService | null = null;

function setupSession(runner: AiRunner): AsrService {
  const asr = new AsrService({
    onProgress: (p) => {
      asrStatus = { ...asrStatus, downloadPercent: p.totalBytes > 0 && p.receivedBytes < p.totalBytes ? Math.floor((p.receivedBytes / p.totalBytes) * 100) : undefined };
      send('asr:download-progress', p);
    },
    onStatus: (st) => {
      asrStatus = { ...st, downloadPercent: st.state === 'loading' ? asrStatus.downloadPercent : undefined };
      send('asr:status', st);
    },
  });
  asrService = asr;
  const s = new MeetingSession({
    root: async () => (await loadSettings()).root,
    createCapture: () => new AudioCapture(riceAudioBinary()),
    prepareCapture: prepareMic,
    createPipeline: (language, vocabulary, speakers) => asr.createPipeline(language, vocabulary, speakers),
    vocabulary: whisperVocabularyFor,
    speakers: createSpeakerIdentifier,
    defaultLanguage: async () => (await loadSettings()).transcriptionLanguage ?? 'pt',
    generateNotes: async (dir, options) => {
      if (!options?.resume) return generateNotes(dir, runner, resolveMeetingTemplate, notesLanguageOf, meetingTerms);
      // retomada: mesmo template da reunião; as notas anteriores vão para notas-anterior.md
      const template = await resolveMeetingTemplate((await readMeta(dir)).templateId);
      return regenerateNotes(dir, runner, template.id, resolveMeetingTemplate, { queueAfterCurrent: true, languageOf: notesLanguageOf, vocabularyOf: meetingTerms });
    },
    keepAudio: () => cachedSettings.keepAudio !== false,
    spoolDir: () => join(app.getPath('userData'), 'spool'),
    micPermission: () => systemPreferences.getMediaAccessStatus('microphone'),
    inactivityMs: () => (typeof cachedSettings.inactivityMinutes === 'number' ? cachedSettings.inactivityMinutes : 15) * 60_000,
  });
  session = s;
  s.alerts.on('change', (list) => send('session:alerts', list));
  // lembretes que merecem uma notificação do sistema (o app pode estar em segundo plano durante a reunião)
  s.on('attention', ({ kind, message }: { kind: 'idle' | 'long' | 'auto-stopped' | 'paused'; message: string }) => {
    notify({
      title: message,
      actionText: kind === 'auto-stopped' ? t('alert.action.resume') : kind === 'paused' ? t('alert.action.stop') : t('alert.action.keep'),
      onAction: () => {
        if (kind === 'paused') {
          void s.stop();
        } else if (kind === 'auto-stopped') {
          const a = s.alerts.list().find((x) => x.id === 'auto-stopped');
          if (a) void runAlertAction(s, 'resume-recording', a.dir, a.id).catch((err: Error) => dialog.showErrorBox('Rice', err.message));
        } else {
          s.keepRecording();
        }
      },
    });
  });
  for (const name of ['state', 'segment', 'partial', 'asr-status', 'asr-warning', 'capture-event', 'session-warning', 'notes'] as const) {
    s.on(name, (payload) => send(`session:${name}`, payload));
  }
  s.on('mic', (info: unknown) => {
    micFromHelper = true;
    void onMic(info);
  });
  s.on('frame', (f: { source: 'mic' | 'sys'; pcm: Buffer }) => {
    // só o nível por canal que o pipeline já recebe; sem timer próprio: a checagem é disparada pelos próprios frames (no máx. 1 por 20 s)
    const now = Date.now();
    muteMonitor.feed(f.source, f.pcm, now);
    if (process.platform === 'darwin' && !TEST_INSTANCE && !muteBusy && muteMonitor.due(now)) void checkMuteMic().catch(() => {});
  }); // Windows: evento mic-device do helper, repassado pela sessão
  s.on('state', (st: string) => {
    if (st === 'idle') {
      micNow = null;
      micFromHelper = false;
      micPick = null;
    } else if (st === 'recording') muteMonitor.reset(Date.now());
    if (st === 'idle') send('session:mic-mute', null);
    else if (st === 'recording' && lastDefaultInput && !micNow && !micPick?.uid) setTimeout(() => { if (!micNow) void onMic({ name: lastDefaultInput ?? '', isDefault: true }); }, 3000).unref(); // Mac: a entrada padrão que o detector já conhecia, só se o helper não informar o microfone aberto (mic-device) em ~3 s
    if (st === 'recording' && TEST_INSTANCE && process.env.RICE_TEST_MIC) {
      // SÓ instância de teste (prints): simula o evento do helper do Windows; RICE_TEST_MIC_SWITCH troca para outro microfone 4 s depois
      try {
        const fake = JSON.parse(process.env.RICE_TEST_MIC ?? '{}') as { id?: string; name?: string; detected?: boolean };
        setTimeout(() => {
          if (fake.detected && fake.id) micPick = { uid: fake.id, name: fake.name ?? '', transport: 'usb', reason: 'in-use' }; // prints: "detectado" (o estado "recording" vem antes da escolha real do microfone)
          void onMic(fake);
        }, 600).unref();
        if (process.env.RICE_TEST_MIC_MUTE) setTimeout(() => send('session:mic-mute', JSON.parse(process.env.RICE_TEST_MIC_MUTE ?? 'null')), 1500).unref(); // aviso de mic mudo (prints)
        if (process.env.RICE_TEST_MIC_SWITCH) setTimeout(() => void onMic(JSON.parse(process.env.RICE_TEST_MIC_SWITCH ?? '{}')), 4000).unref();
      } catch {
        // JSON inválido: sem simulação
      }
    }
  });
  s.on('state', updateTray);
  s.on('state', syncCallSpeakers);
  s.on('state', (st: string) => { if (st === 'idle') { pendingPrompts.recordingEnded(); winUpdater.recordingEnded(); void maybeNotifyUpdate(); } }); // aviso de versão nova adiado pela gravação
  s.on('state', updateNub);
  s.on('pause', (e: { dir: string; paused: boolean }) => {
    send('session:pause', e);
    updateTray();
    updateNub();
    syncScreenshots(); // pausado: nenhuma captura de tela
    if (e.paused) warRoom.engine.stop(e.dir); // pausado: os ciclos de ideias e de war room também
    else warRoom.onSessionState('recording', e.dir);
  });
  // gravação iniciada fora da janela (aviso de reunião, notificação): a tela relê o estado agora que o dir existe
  s.on('active', () => send('session:state', s.state));
  // falas ainda não finalizadas (parciais atuais de cada fonte): entram nos ciclos como "provisório"
  const livePartials = new Map<string, Map<string, { text: string; at: number }>>();
  s.on('partial', ({ dir: d, partial }: { dir: string; partial: { source: string; text: string } }) => {
    const bySource = livePartials.get(d) ?? new Map<string, { text: string; at: number }>();
    bySource.set(partial.source, { text: partial.text.trim(), at: Date.now() });
    livePartials.set(d, bySource);
  });
  s.on('segment', ({ dir: d, segment }: { dir: string; segment: { source: string } }) => livePartials.get(d)?.delete(segment.source));
  s.on('state', (st: string) => {
    if (st === 'idle') livePartials.clear();
  });
  // ideias ao vivo e War room: ciclos só enquanto grava, nunca nas notas automáticas
  const warRoom = createWarRoom({
    handle,
    send,
    checkedDir,
    runner,
    lightRunner: () => lightRunner ?? runner,
    maxCycles: async () => normalizeMaxCycles((await loadSettings()).warroomMaxCycles),
    provider: async () => (await currentAiSettings()).provider,
    language: async (d) => ((await notesLanguageOf(await readMeta(d))).headings === 'en' ? 'en' : 'pt-BR'),
    transcript: (d) => readMeetingText(d, 'transcript'),
    partials: (d) => [...(livePartials.get(d) ?? new Map<string, { text: string; at: number }>())].filter(([, p]) => p.text && Date.now() - p.at < 8000).map(([source, p]) => `${source}: ${p.text}`), // parcial parado há 8 s não conta (alucinação sem final)
    isRecording: (d) => s.state === 'recording' && !s.paused && s.currentDir === d, // pausado: sem ciclos
    pickFolder: async () => {
      const options = { title: t('warroom.src.folder'), properties: ['openDirectory' as const] };
      const result = window && !window.isDestroyed() ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
      return result.canceled ? null : (result.filePaths[0] ?? null);
    },
    saveAnnotations: async (d, text) => {
      await saveAnnotations(d, text, new Date(), true);
    },
    ideaTemplates: async () => {
      const settings = await loadSettings();
      const language = await currentUiLanguage();
      return { templates: (await listIdeaTemplates(settings.root)).templates.map((x) => localizeIdeaTemplate(x, language)), ...(settings.lastIdeaTemplate ? { lastId: settings.lastIdeaTemplate } : {}) };
    },
    rememberIdeaTemplate: async (id) => {
      await saveSettings({ ...(await loadSettings()), lastIdeaTemplate: id });
    },
    userData: app.getPath('userData'),
    openPath: (path) => shell.openPath(path), // abre o .command no Terminal padrão (sem osascript)
    openExternal: (url) => shell.openExternal(url),
    reveal: (path) => shell.showItemInFolder(path),
  });
  registerAttachments({
    handle,
    send,
    checkedDir,
    isRecording: (d) => s.state === 'recording' && s.currentDir === d,
    imagesSupported: async () => {
      const provider = (await currentAiSettings()).provider;
      return { provider, supported: ['claude-api', 'openai-api', 'gemini-api'].includes(provider) };
    },
    pickFiles: async () => {
      const options = { title: t('attach.pick'), properties: ['openFile' as const, 'multiSelections' as const] };
      const result = window && !window.isDestroyed() ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
      return result.canceled ? [] : result.filePaths;
    },
    trash: (p) => shell.trashItem(p),
    open: (p) => shell.openPath(p),
    reveal: (p) => shell.showItemInFolder(p),
    thumbnail: (p) => {
      const image = nativeImage.createFromPath(p);
      return image.isEmpty() ? null : image.resize({ width: 192, quality: 'good' }).toDataURL();
    },
    reindex: () => {}, // a busca relê sozinha: o index.json dos anexos conta na data de modificação
  });
  // capturas de tela: só enquanto grava, só com a opção ligada; as imagens só vão ao provedor de IA ativo (e só se ele aceita imagem)
  const shotLanguage = async (d: string): Promise<'pt' | 'en'> => ((await notesLanguageOf(await readMeta(d))).headings === 'en' ? 'en' : 'pt');
  const screenshotCapture = new ScreenshotCapture({
    grab: TEST_INSTANCE && process.env.RICE_SHOT_SOURCE_DIR ? grabFromFolder(process.env.RICE_SHOT_SOURCE_DIR) : (hint) => grabScreen({ apps: [...activeMeetingApps], preferWindow: hint.preferWindow }), // o detector diz qual app usa o microfone; RICE_SHOT_SOURCE_DIR: só instâncias de teste, quadros prontos no lugar da tela
    // a decisão é só por texto (últimos ~60 s + o trecho candidato): vale para qualquer provedor, inclusive os CLIs
    decide: async (context, candidates, d) => decideCapture(withEgressContext(lightRunner ?? runner, { kind: 'screenshot', dir: d }), await shotLanguage(d), context, candidates),
    // com provedor que aceita imagem, a legenda pode ser refinada pela imagem; sem ele fica o motivo da fala
    refine: async (jpeg, _reason, d) => {
      if (!providerSeesImages((await currentAiSettings()).provider)) return null;
      const verdict = await judgeShot(withEgressContext(lightRunner ?? runner, { kind: 'screenshot', dir: d }), { mime: 'image/jpeg', data: jpeg.toString('base64') }, await shotLanguage(d));
      return verdict.useful && verdict.caption ? verdict.caption : null;
    },
    nearestSegment: async (d, at) => nearestSegmentClock(await readMeetingText(d, 'transcript'), at),
    locate: async (d, text) => clockOfSegmentText(await readMeetingText(d, 'transcript'), text),
    onChange: (d, list) => screenshotsIpc.changed(d, list),
    onError: (err) => logError('screenshots', err),
  });
  s.on('segment', ({ dir: d, segment }: { dir: string; segment: { source: string; speaker?: number; text: string; startMs: number } }) => {
    if (cachedSettings.screenshots === true) screenshotCapture.onSegment({ dir: d, who: segment.source === 'Outros' && segment.speaker ? `Pessoa ${segment.speaker}` : segment.source, text: segment.text, startMs: segment.startMs });
  });
  const syncScreenshots = () => {
    const dir = s.currentDir;
    if (cachedSettings.screenshots === true && s.state === 'recording' && !s.paused && dir) {
      void readMeta(dir).then((meta) => {
        if (cachedSettings.screenshots === true && s.state === 'recording' && !s.paused && s.currentDir === dir) screenshotCapture.start(dir, new Date(meta.startedAt));
      }).catch((err) => logError('screenshots', err));
    } else screenshotCapture.stop();
  };
  s.on('state', syncScreenshots);
  s.on('active', syncScreenshots);
  const screenshotsIpc = registerScreenshots({
    handle,
    send,
    checkedDir,
    thumbnail: (p, width) => {
      const image = nativeImage.createFromPath(p);
      return image.isEmpty() ? null : image.resize({ width, quality: 'good' }).toDataURL();
    },
    enabled: () => cachedSettings.screenshots === true,
    setEnabled: async (on) => {
      await saveSettings({ ...(await loadSettings()), screenshots: on });
      syncScreenshots();
    },
    environment: async () => {
      const provider = (await currentAiSettings()).provider;
      return { provider, seesImages: providerSeesImages(provider), permission: screenPermission() };
    },
    openPrivacy: () => {
      if (process.platform === 'darwin') void shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
    },
    isRecording: (d) => s.state === 'recording' && s.currentDir === d,
    captureNow: async () => s.state === 'recording' && !s.paused && (await screenshotCapture.captureNow()) !== null,
  });
  let warRoomDir: string | null = null;
  // o "batimento" do war room só roda enquanto grava (parado, nenhum timer fica acordando o computador)
  let warRoomBeat: NodeJS.Timeout | null = null;
  s.on('state', (state: string) => {
    if (s.currentDir) warRoomDir = s.currentDir;
    warRoom.onSessionState(state, warRoomDir);
    if (state === 'recording' && !warRoomBeat) {
      warRoomBeat = setInterval(() => warRoom.ensure(s.currentDir), 15_000);
      warRoomBeat.unref();
    } else if (state === 'idle' && warRoomBeat) {
      clearInterval(warRoomBeat);
      warRoomBeat = null;
    }
  });
  const levels = new LevelThrottle((l) => nub?.sendLevel(l));
  s.on('frame', (frame) => levels.push(frame));
  // "Recuperar reunião": finaliza o áudio órfão, transcreve o que ficou sem texto e gera as notas
  handle('meetings:recover', async (_e, rawDir: string) => {
    try {
      const dir = await checkedDir(rawDir);
      if (s.state !== 'idle' && s.currentDir === dir) return { ok: false as const, message: t('err.meeting-recording') };
      const result = await recoverMeeting(dir, {
        createPipeline: (language) => asr.createPipeline(language),
        generateNotes: (d) => generateNotes(d, runner, resolveMeetingTemplate, notesLanguageOf, meetingTerms),
        language: async (d) => (await readMeta(d)).language ?? (await loadSettings()).transcriptionLanguage ?? 'pt',
        keepAudio: () => cachedSettings.keepAudio !== false,
      });
      return { ok: true as const, ...result };
    } catch (err) {
      return { ok: false as const, message: err instanceof Error ? err.message : String(err) };
    }
  });
  handle('session:alerts', () => s.alerts.list());
  handle('session:alert-dismiss', (_e, id: unknown) => {
    const alert = s.alerts.list().find((a) => a.id === id);
    if (alert?.dismissible) s.alerts.clear(alert.id);
  });
  // botão de um aviso: só as ações conhecidas (o renderer manda o id, nunca um comando)
  handle('session:alert-action', async (_e, id: unknown, kind: unknown) => {
    const alert = s.alerts.list().find((a) => a.id === id);
    if (!alert) return;
    // só vale uma das ações que o próprio aviso oferece (o renderer manda o id e o tipo, nunca um comando)
    const offered = [alert.action?.kind, alert.secondary?.kind];
    const chosen = offered.includes(kind as AlertActionKind) ? (kind as AlertActionKind) : alert.action?.kind;
    if (chosen) await runAlertAction(s, chosen, alert.dir, alert.id);
  });
  handle('session:start', async (_e, input?: { title?: string; dir?: string }) => {
    try {
      const request = parseStartInput(input, (await loadSettings()).root);
      await ensureMicAccess();
      s.alerts.clear('permission:mic');
      return { ok: true as const, dir: await s.start(request) };
    } catch (err) {
      // R-06: sem permissão a gravação não começa em silêncio; o aviso traz o atalho para o painel certo
      if ((err as Error).message === t('err.mic-permission')) {
        s.alerts.set({ id: 'permission:mic', level: 'error', message: t('err.mic-permission'), action: { kind: 'open-mic-privacy', label: t('alert.action.privacy') } });
      }
      return { ok: false as const, message: (err as Error).message };
    }
  });
  const stopRecording = async () => {
    try {
      await s.stop();
      return { ok: true as const };
    } catch (err) {
      return { ok: false as const, message: (err as Error).message };
    }
  };
  handle('session:stop', stopRecording);
  handle('session:pause', () => {
    s.pause();
    return { ok: true as const, paused: s.paused };
  });
  handle('session:unpause', () => {
    s.unpause();
    return { ok: true as const, paused: s.paused };
  });
  // os IPCs do nub só valem se vierem da própria janelinha
  const fromNub = (e: Electron.IpcMainInvokeEvent) => nubWindow !== null && e.sender === nubWindow.webContents;
  handle('nub:open-main', (e) => {
    if (fromNub(e)) showMainWindow();
  });
  handle('nub:stop', (e) => (fromNub(e) ? stopRecording() : { ok: false as const, message: t('err.foreign-origin') }));
  handle('nub:pause', (e) => {
    if (!fromNub(e)) return { ok: false as const, message: t('err.foreign-origin') };
    if (s.paused) s.unpause();
    else s.pause();
    return { ok: true as const };
  });
  const nubIpc = createNubIpc<Electron.IpcMainInvokeEvent>({
    fromNub,
    activeDir: () => (s.state === 'recording' ? s.currentDir : null),
    expand: () => nub?.expand() ?? false,
    collapse: () => nub?.collapse(),
    context: async (dir) => ({
      title: (await readMeta(dir)).title,
      lines: lastTranscriptLines(await readMeetingText(dir, 'transcript')),
    }),
    ask: (dir, question, signal, onDelta) => askAboutMeeting(runner, dir, question, signal, onDelta),
    sendToNub: (channel, payload) => nub?.sendExpanded(channel, payload),
    notifyMain: (turn) => {
      if (window && !window.isDestroyed()) window.webContents.send('chat:external', turn);
    },
  });
  handle('nub:expand', (e) => nubIpc.expand(e));
  handle('nub:collapse', (e) => nubIpc.collapse(e));
  handle('nub:ask', (e, question: unknown) => nubIpc.ask(e, question));
  handle('nub:cancel', (e) => nubIpc.cancel(e));
  s.on('segment', ({ segment }) => nub?.sendExpanded('nub:segment', segment));
  s.on('partial', ({ partial }) => nub?.sendExpanded('nub:partial', partial));
  handle('nub:drag-end', (e) => {
    if (fromNub(e)) nub?.persistPosition();
  });
  handle('session:recovered-count', () => recoveredCount);
  handle('session:state', () => ({ state: s.state, dir: s.currentDir, paused: s.paused }));
  handle('asr:retry', () => s.retryAsr());
  handle('notes:generate', async (_e, rawDir: string) => {
    try {
      await generateNotes(await checkedDir(rawDir), runner, resolveMeetingTemplate, notesLanguageOf);
      return { ok: true };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  });
  handle('notes:regenerate', async (_e, rawDir: string, templateId: string) => {
    try {
      const dir = await checkedDir(rawDir);
      const { root } = await loadSettings();
      const template = await getTemplate(root, String(templateId ?? ''));
      if (!template) throw new Error(t('err.template-not-found'));
      await regenerateNotes(dir, runner, template.id, resolveMeetingTemplate, { languageOf: notesLanguageOf, vocabularyOf: meetingTerms });
      return { ok: true };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  });
  handle('notes:versions', async (_e, rawDir: string) => listVersions(await checkedDir(rawDir)));
  handle('notes:version-read', async (_e, rawDir: string, file: string) => {
    try {
      const { version, content } = await readVersion(await checkedDir(rawDir), String(file ?? ''));
      return { ok: true as const, version, content };
    } catch (err) {
      return { ok: false as const, message: (err as Error).message };
    }
  });
  handle('notes:version-restore', async (_e, rawDir: string, file: string) => {
    try {
      const dir = await checkedDir(rawDir);
      const nameOf = async (id: string | undefined) => (await resolveMeetingTemplate(id)).title;
      await restoreVersion(dir, String(file ?? ''), nameOf);
      return { ok: true as const };
    } catch (err) {
      return { ok: false as const, message: (err as Error).message };
    }
  });
  return asr;
}

/** Pergunta sobre a reunião: monta o prompt, transmite o texto aos poucos e grava a troca no chat.md. */
/** Orçamento de texto do modelo local (depende do `num_ctx`); null com qualquer outro provedor (valem os limites de sempre). */
async function activeLocalBudget(): Promise<ContextBudget | null> {
  const ai = await currentAiSettings();
  return ai.provider === 'local-model' ? localBudget(ai.local?.numCtx ?? DEFAULT_NUM_CTX) : null;
}

/** O modelo local escolhido (ou o menor instalado) aceita imagens? */
async function localAcceptsImages(): Promise<boolean> {
  const ai = await currentAiSettings();
  if (ai.provider !== 'local-model') return false;
  const server = await cachedLocalServer(ai.local ?? {}, (url, init) => fetch(url, init), Date.now()).catch(() => null);
  const model = ai.models['local-model'] || smallestLocalModel(server?.models ?? []);
  return Boolean(server && model && (await isVisionModel(server, model, (url, init) => fetch(url, init))));
}

/** "Buscar na web" pedido para UMA pergunta: só vale com `true` exato e se o provedor ativo suporta; senão a pergunta nem sai. */
/** Ferramentas/MCPs no chat: opção ligada, fora do Modo 100% local e com um provedor que as usa (o modelo local não usa). */
async function toolsAllowed(): Promise<boolean> {
  return (await loadSettings()).chatTools === true && !isLocalMode() && (await currentAiSettings()).provider !== 'local-model';
}

async function webRequested(raw: unknown): Promise<boolean> {
  if (raw !== true) return false;
  if (isLocalMode()) throw new AiError('other', t('local.mode.blocked.web'));
  if (!webSearchSupported((await currentAiSettings()).provider)) throw new AiError('other', t('chat.web.unavailable'));
  return true;
}

async function chatAnswer(runner: AiRunner, dir: string, question: string, signal: AbortSignal, onDelta: (text: string) => void, web = false, onSources?: (sources: WebSource[]) => void): Promise<string> {
  const meta = await readMeta(dir);
  const { language } = await notesLanguageOf(meta);
  const mem = (await memoryRef?.chatContext(question, meta).catch(() => null)) ?? { text: '', dirs: [] as string[] }; // pedidos, promessas e decisões de reuniões anteriores com essas pessoas
  const prompt = buildChatPrompt(
    {
      title: meta.title,
      startedAt: meta.startedAt,
      transcript: await chatTranscript(dir, applySpeakerNames(await readMeetingText(dir, 'transcript'), meta.speakers), question, language, (await activeLocalBudget())?.chatChars),
      annotations: await readMeetingText(dir, 'annotations'),
      attachments: await attachmentsContext(dir),
      vocabulary: await meetingTerms(meta),
      memory: mem.text,
    },
    await readChat(dir),
    question,
    language,
  );
  // ferramentas/MCPs só aqui (chat) e só se o usuário ligou a opção; notas, e-mail e extrações nunca passam por este caminho
  // War room: o chat da reunião usa as fontes ligadas no painel e leva os fatos confirmados como contexto
  const war = await readWarRoomConfig(dir);
  const warOn = war.kind === 'warroom';
  const facts = warOn ? contextFacts(war) : [];
  const folder = warOn && war.sources.folder && (await currentAiSettings()).provider === 'claude-sub' && (await checkWorkFolder(war.sources.folder)).ok ? war.sources.folder : undefined;
  const system = facts.length ? `${chatSystemPrompt(language)}\n\n${t('warroom.facts.context', undefined, language === 'en' ? 'en' : 'pt-BR')}:\n${facts.map((f) => `- ${f.text}`).join('\n')}` : chatSystemPrompt(language);
  const warAccess = warOn && !isLocalMode() && (war.sources.web || war.sources.mcp || folder) && supportsWarRoom(await currentAiSettings().then((a) => a.provider)) ? { mcp: war.sources.mcp, web: war.sources.web, ...(folder ? { folder } : {}) } : undefined;
  const apiProvider = ['claude-api', 'openai-api', 'gemini-api'].includes((await currentAiSettings()).provider) || (await localAcceptsImages());
  const images = apiProvider ? await attachmentImages(dir) : []; // imagens só vão para APIs (e modelos locais de visão); os CLIs as ignoram
  let found: WebSource[] = [];
  const answer = await runChat(runner, { system, prompt, signal, egress: { kind: 'chat', dirs: [...new Set([dir, ...mem.dirs])] }, ...(images.length ? { images } : {}) }, { useTools: await toolsAllowed(), ...(warAccess ? { access: warAccess } : {}), language: language === 'en' ? 'en' : 'pt-BR', onDelta, ...(web ? { web: true, onSources: (list: WebSource[]) => { found = list; onSources?.(list); } } : {}) });
  await appendChat(dir, new Date(), question, answer, found); // as fontes ficam junto da resposta e voltam ao reabrir
  return answer;
}

async function askAboutMeeting(runner: AiRunner, dir: string, question: string, signal: AbortSignal, onDelta: (text: string) => void) {
  try {
    return { ok: true as const, answer: await chatAnswer(runner, dir, question, signal, onDelta) };
  } catch (err) {
    return { ok: false as const, kind: err instanceof AiError ? err.kind : 'other', message: (err as Error).message };
  }
}

async function checkedDir(dir: unknown): Promise<string> {
  const { root } = await loadSettings();
  const resolved = resolve(String(dir ?? ''));
  if (!isInsideRoot(root, resolved)) throw new Error(t('err.outside-root'));
  return resolved;
}


/** Guarda na reunião os e-mails dos participantes do evento da agenda (o evento sai do feed depois de passar). */
async function rememberParticipants(dir: string, eventId: string | undefined): Promise<void> {
  const emails = eventId ? calendarFeed.events().find((e) => e.id === eventId)?.attendeeEmails : undefined;
  if (!emails || emails.length === 0) return;
  await updateMeta(dir, (meta) => ({ ...meta, participantEmails: emails })).catch((err) => logError('participants', err));
}

/** Pasta de destino dos PDFs: a última escolhida (nas configurações) ou Downloads. RICE_EXPORT_DIR: instância de teste. */
async function exportDir(): Promise<string> {
  return process.env.RICE_EXPORT_DIR ?? (await loadSettings()).exportDir ?? app.getPath('downloads');
}
/** Último PDF gravado: é o único caminho que "Mostrar no Finder" aceita (o renderer nunca escolhe um caminho). */
let lastExport: string | null = null;

function shareDeps(runner: AiRunner): ShareDeps {
  return {
    checkedDir,
    readMeta,
    readText: readMeetingText,
    clipboard: { write: ({ text, html }) => clipboard.write([new ClipboardItem(html ? { 'text/plain': text, 'text/html': html } : { 'text/plain': text })]) },
    runner,
    languageOf: async (meta) => {
      const { language, headings } = await notesLanguageOf(meta);
      return { language, headings };
    },
    participants: async (meta) => meta.participantEmails ?? calendarFeed.events().find((e) => e.id === meta.calendarEventId)?.attendeeEmails ?? [],
    selfEmails: async () => [],
    openExternal: (url) => shell.openExternal(url),
    exportFolder: async () => ({ display: tildify(await exportDir()) }),
    exportTarget: async (name) => {
      const dir = await exportDir();
      await mkdir(dir, { recursive: true });
      const path = await uniquePath(dir, name, (p) => access(p).then(() => true, () => false));
      lastExport = path;
      return path;
    },
    writeFile: (path, data) => writeFile(path, data),
    createPdfWindow: () => {
      const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, javascript: false, contextIsolation: true, nodeIntegration: false, devTools: false } });
      win.webContents.on('will-navigate', (e) => e.preventDefault());
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      return { loadURL: (url) => win.loadURL(url), printToPDF: (options) => win.webContents.printToPDF(options), destroy: () => win.destroy() };
    },
  };
}

/** "Nova reunião" / nota de um evento: reaproveita o rascunho vazio mais recente quando não há título nem agenda; senão cria a pasta. */
async function createMeetingDraft(title: string, calendarEventId?: string, folderId?: string, kind?: string): Promise<string> {
  const { root, defaultTemplateId } = await loadSettings();
  const inFolder = typeof folderId === 'string' && folderId && (await folderExists(root, folderId)) ? folderId : null;
  const warroom = kind === 'warroom' ? 'warroom' : undefined;
  const eventId = typeof calendarEventId === 'string' && calendarEventId ? calendarEventId : undefined;
  const draft = !eventId && !(typeof title === 'string' && title.trim()) ? await findEmptyDraft(root) : null;
  let dir: string;
  if (draft) {
    dir = draft;
    await reuseDraft(dir, { startedAt: new Date(), ...(inFolder ? { folderId: inFolder } : {}), ...(warroom ? { kind: warroom } : {}) });
  } else {
    ({ dir } = await createMeeting(root, {
      title,
      startedAt: new Date(),
      trigger: 'manual',
      state: 'draft',
      ...(eventId ? { calendarEventId: eventId } : {}),
      ...(inFolder ? { folderId: inFolder } : {}),
      templateId: (await resolveTemplate(root, defaultTemplateId)).id,
    }));
    if (warroom) await writeWarRoomConfig(dir, { ...(await readWarRoomConfig(dir)), kind: 'warroom' });
  }
  await rememberParticipants(dir, eventId);
  return dir;
}

/** Nota do evento: o rascunho que já existe para ele ou um novo (a mesma nota do "Preparar notas" do Início). */
async function draftForEvent(event: { id: string; title: string }): Promise<string> {
  const { root } = await loadSettings();
  for (const dir of await listMeetingDirs(root)) {
    const meta = await readMeta(dir).catch(() => null);
    if (meta?.calendarEventId === event.id && meta.state === 'draft') return dir;
  }
  return createMeetingDraft(event.title, event.id);
}

/**
 * Atalho global de gravar e parar (padrão ⌥⌘R), com o Rice em segundo plano. Instância de teste não registra nada (não disputa o
 * atalho com o Rice do dia a dia); `RICE_TEST_SHORTCUT=conflict` só simula um atalho já ocupado para os prints.
 */
const shortcutManager = createShortcutManager({
  register: (accelerator, callback) => (TEST_INSTANCE ? process.env.RICE_TEST_SHORTCUT !== 'conflict' : globalShortcut.register(accelerator, callback)),
  unregister: (accelerator) => {
    if (!TEST_INSTANCE) globalShortcut.unregister(accelerator);
  },
  onTrigger: () => {
    void toggleRecording({
      state: () => session?.state ?? 'idle',
      events: () => calendarFeed.events(),
      draftFor: draftForEvent,
      defaultTitle: () => t('meeting.default-title'),
      start: async (input) => {
        await ensureMicAccess();
        const request = parseStartInput(input, (await loadSettings()).root);
        return session?.start(request);
      },
      stop: async () => session?.stop(),
      notify: (kind, detail) => {
        const body = kind === 'recording' ? t('shortcut.recording') : kind === 'stopped' ? t('shortcut.stopped') : t('common.error', { message: detail ?? '' });
        if (Notification.isSupported()) new Notification({ title: 'Rice', body, silent: true }).show();
      },
    });
  },
});

/** Varredura de retenção: nunca toca em reunião gravando/finalizando; manda para a Lixeira do sistema e avisa uma vez. */
async function sweepRetention(now: Date = new Date()): Promise<SweepAction[]> {
  const settings = await loadSettings();
  const folders = await readFolders(settings.root);
  if (!settings.retentionDefault && !folders.some((f) => f.retention)) return []; // nenhuma regra em lugar nenhum
  const meetings: SweepMeeting[] = [];
  for (const dir of await listMeetingDirs(settings.root)) {
    const meta = await readMeta(dir).catch(() => null);
    if (!meta) continue;
    const audio = (await readdir(dir).catch(() => [] as string[])).filter((n) => /^audio\.(m4a|wav)$/.test(n));
    meetings.push({ dir, state: meta.state, startedAt: meta.startedAt, ...(meta.endedAt ? { endedAt: meta.endedAt } : {}), ...(meta.folderId ? { folderId: meta.folderId } : {}), audio });
  }
  const busy = new Set<string>(session && session.state !== 'idle' && session.currentDir ? [session.currentDir] : []);
  const plan = planSweep({ meetings, folders, fallback: settings.retentionDefault, now, busy });
  const done: SweepAction[] = [];
  for (const action of plan) {
    try {
      for (const file of action.kind === 'meeting' ? [action.dir] : action.files.map((f) => join(action.dir, f))) await shell.trashItem(file);
      done.push(action);
    } catch (err) {
      logError('retention trash', err);
    }
  }
  if (done.length > 0) {
    send('meetings:changed', null);
    if (Notification.isSupported()) new Notification({ title: 'Rice', body: sweepNotice(done, (key, n, vars) => tn(key, n, vars)).slice(0, 3).join('\n'), silent: true }).show();
  }
  return done;
}

/** Windows: atualização automática (electron-updater + GitHub Releases), só no app instalado pelo NSIS. No Mac nunca liga. */
const winUpdater = createWinUpdater({
  load: () => {
    try {
      return (require('electron-updater') as { autoUpdater: UpdaterLike }).autoUpdater;
    } catch {
      return null;
    }
  },
  supported: () => (TEST_INSTANCE ? process.env.RICE_TEST_WINUPDATE !== undefined : nsisInstall({ platform: process.platform, packaged: app.isPackaged, resourcesPath: process.resourcesPath })),
  enabled: async () => (await loadSettings()).checkUpdates !== false && !isLocalMode(),
  allowed: async () => !isLocalMode(), // baixar e instalar valem com a consulta automática desligada (o usuário pediu); só o Modo 100% local barra
  isRecording: () => session !== null && session.state !== 'idle',
  onChange: (st) => send('winupdate:changed', st),
});
/** SÓ instância de teste (RICE_TEST_WINUPDATE=available|downloading|downloaded|waiting): estado fixo para os prints, sem consultar nada. */
const fakeWinUpdate = (): WinUpdateState | null => {
  const f = TEST_INSTANCE ? process.env.RICE_TEST_WINUPDATE : undefined;
  if (f === 'available') return { supported: true, phase: 'available', version: '0.5.0' };
  if (f === 'downloading') return { supported: true, phase: 'downloading', version: '0.5.0', percent: 42 };
  if (f === 'downloaded') return { supported: true, phase: 'downloaded', version: '0.5.0' };
  if (f === 'waiting') return { supported: true, phase: 'downloaded', version: '0.5.0', waitingForRecording: true };
  return null;
};

/** Versão do build (commit, remote público, clone de origem); lida uma vez ao abrir. Instância de teste nunca consulta nada. */
let buildInfo: BuildInfo | null = null;
const updateChecker = createUpdateChecker({
  info: () => buildInfo,
  enabled: async () => (await loadSettings()).checkUpdates !== false && !isLocalMode(),
  getState: async () => (await loadSettings()).updateCheck ?? {},
  setState: async (state) => saveSettings({ ...(await loadSettings()), updateCheck: state }),
  disabled: () => TEST_INSTANCE,
  cloneUsable: (path) => process.platform === 'darwin' && existsSync(join(path, 'update.sh')),
  localMode: () => isLocalMode(),
});
/** Mac: notificação UMA vez por versão nova (guarda o sha avisado); nunca durante a gravação (tenta de novo quando ela acaba). O clique traz a janela com a faixa. */
async function maybeNotifyUpdate(): Promise<void> {
  if (process.platform !== 'darwin' || TEST_INSTANCE || !Notification.isSupported()) return;
  const status = await updateChecker.status(); // já respeita "Procurar atualizações" desligado, Modo 100% local e build sem remoto público
  const settings = await loadSettings();
  const state = settings.updateCheck ?? {};
  if (!shouldNotify({ available: status.available, state, recording: session !== null && session.state !== 'idle' })) return;
  await saveSettings({ ...settings, updateCheck: { ...state, notifiedSha: state.sha } }); // grava antes: nunca repete, mesmo que a notificação falhe
  const n = new Notification({ title: t('update.notif.title'), body: t('update.notif.body'), silent: true });
  liveNotifications.add(n);
  const done = () => liveNotifications.delete(n);
  n.on('click', () => {
    done();
    void (async () => {
      const cur = await loadSettings();
      const { dismissedSha, dismissedAt, ...rest } = cur.updateCheck ?? {};
      void dismissedSha; void dismissedAt;
      await saveSettings({ ...cur, updateCheck: rest }); // o clique reabre a faixa, mesmo que tenha dado "Depois" antes
      send('update:changed', await updateChecker.status());
      showMainWindow();
    })();
  });
  n.on('close', done);
  n.show();
}
/** Windows: a consulta do electron-updater deu certo agora (a do Mac grava sozinha em check.ts). */
const markChecked = async () => {
  const s = await loadSettings();
  await saveSettings({ ...s, updateCheck: { ...(s.updateCheck ?? {}), lastCheckAt: new Date().toISOString() } });
};
/** "Buscar atualização agora" (Configurações › Atualizações). */
const checkNowRunner = createCheckNow({
  localMode: async () => isLocalMode(),
  win: async () => ((await winUpdater.status()).supported ? winUpdater.check(true) : null),
  commit: () => updateChecker.checkNow(),
  lastCheckAt: async () => lastCheckOf((await loadSettings()).updateCheck),
  markChecked,
});

function registerIpc(runner: AiRunner): void {
  // memória entre reuniões e pendências: só consome notas e eventos que já existem (nunca toca na captura de áudio)
  const memorySvc = new MemoryService({
    root: async () => (await loadSettings()).root,
    runner: () => lightRunner ?? runner,
    language: async (meta) => ((await notesLanguageOf((meta ?? {}) as MeetingMeta)).language === 'en' ? 'en' : 'pt'),
    enabled: () => cachedSettings.memory !== false,
    notifyEnabled: () => cachedSettings.followupNotify !== false,
    events: () => calendarFeed.events(),
    ownDomains: () => cachedSettings.memoryOwnDomains ?? [],
    budget: async () => (await activeLocalBudget())?.globalChars, // modelo local: contexto menor
    onChanged: () => send('memory:changed', null),
    onProgress: (p) => send('memory:progress', p),
  });
  memoryRef = memorySvc;
  onNotesDone((dir) => void memorySvc.onNotesReady(dir));
  registerMemory(
    {
      handle,
      send,
      checkedDir,
      readMeetingInfo: async (dir) => {
        const m = await readMeta(dir).catch(() => null);
        return m ? { title: m.title, date: m.startedAt } : null;
      },
      setEnabled: async (on) => void (await saveSettings({ ...(await loadSettings()), memory: on })),
      setNotify: async (on) => void (await saveSettings({ ...(await loadSettings()), followupNotify: on })),
      remindersActive: async () => isMac() && remindersAccess === 'granted' && remindersSupported() && (await loadSettings()).showReminders !== false,
    },
    memorySvc,
  );
  // cobrança: uma vez por dia, a partir das 9h (ou na abertura do app, se ele estava fechado); agrupa várias numa só
  const checkFollowupsDue = async () => {
    const n = await memorySvc.dueNotification().catch(() => null);
    if (!n) return;
    await memorySvc.markNotified(n.ids).catch(() => {});
    const title = n.count === 1 ? t('followup.notify.one', { text: n.text }) : n.allToday ? t('followup.notify.many-today', { n: n.count }) : t('followup.notify.many-overdue', { n: n.count });
    if (TEST_INSTANCE && process.env.RICE_NOTIFY_LOG) {
      await appendFile(process.env.RICE_NOTIFY_LOG, `${JSON.stringify({ title, count: n.count })}\n`).catch(() => {}); // instância de teste: nada aparece na tela do usuário
      return;
    }
    notify({ title, actionText: t('followup.notify.open'), onAction: () => { showMainWindow(); send('app:open-followups', null); } });
  };
  setTimeout(() => void checkFollowupsDue(), 15_000).unref();
  setInterval(() => void checkFollowupsDue(), 10 * 60_000).unref();
  handle('settings:get', async () => {
    const settings = await loadSettings();
    return {
      ...settings,
      rootDisplay: tildify(settings.root),
      transcriptionLanguage: settings.transcriptionLanguage ?? 'pt',
      uiLanguage: await currentUiLanguage(),
      keepAudio: settings.keepAudio !== false,
      vocabulary: settings.vocabulary ?? '',
      vocabularyAttendees: settings.vocabularyAttendees !== false,
      identifySpeakers: settings.identifySpeakers === true,
      memory: settings.memory !== false,
      followupNotify: settings.followupNotify !== false,
      screenshots: settings.screenshots === true,
      chatTools: settings.chatTools === true,
      checkUpdates: settings.checkUpdates !== false,
      launchAtLogin: settings.launchAtLogin === true,
      micDevice: settings.micDevice ?? null,
      micAuto: settings.micAuto !== false,
      asrModel: asrChoiceOf(settings.asrModel),
      fullyLocal: settings.fullyLocal === true,
      redactPii: settings.redactPii === true,
      retentionDefault: settings.retentionDefault ?? {},
      consentRemind: settings.consentRemind !== false,
      consentText: settings.consentText ?? '',
      savedPrompts: normalizeSavedPrompts(settings.savedPrompts),
      warroomMaxCycles: normalizeMaxCycles(settings.warroomMaxCycles),
    };
  });
  handle('settings:set-warroom-max-cycles', async (_e, value: unknown) => {
    await saveSettings({ ...(await loadSettings()), warroomMaxCycles: normalizeMaxCycles(value) });
    return { ok: true as const };
  });
  handle('settings:set-ui-language', async (_e, language: unknown) => {
    if (language !== 'pt-BR' && language !== 'en') return { ok: false as const, message: t('err.language-invalid') };
    await saveSettings({ ...(await loadSettings()), uiLanguage: language });
    applyUiLanguage(language);
    return { ok: true as const };
  });
  // vale para as próximas gravações (o idioma de uma gravação em andamento não muda)
  handle('settings:set-transcription-language', async (_e, language: unknown) => {
    if (!isTranscriptionLanguage(language)) return { ok: false as const, message: t('err.language-invalid') };
    await saveSettings({ ...(await loadSettings()), transcriptionLanguage: language });
    return { ok: true as const };
  });
  handle('settings:set-vocabulary', async (_e, text: unknown, includeAttendees: unknown) => {
    const vocabulary = parseVocabulary(String(text ?? '')).join('\n');
    await saveSettings({ ...(await loadSettings()), vocabulary, vocabularyAttendees: includeAttendees !== false });
    return { ok: true as const };
  });
  handle('settings:set-identify-speakers', async (_e, on: unknown) => {
    await saveSettings({ ...(await loadSettings()), identifySpeakers: on === true });
    return { ok: true as const };
  });
  handle('settings:set-chat-tools', async (_e, on: unknown) => {
    if (on === true && isLocalMode()) return { ok: false as const, message: t('local.mode.blocked.tools') };
    await saveSettings({ ...(await loadSettings()), chatTools: on === true });
    return { ok: true as const };
  });
  // estado do recurso para o chip e a tela de Configurações: ligado? o provedor ativo suporta? há MCP configurado?
  handle('ai:tools-status', async () => {
    const on = (await loadSettings()).chatTools === true;
    const provider = (await currentAiSettings()).provider;
    if (isLocalMode()) return { on, provider, available: false as const, hint: t('local.mode.blocked.tools') };
    if (provider === 'local-model') return { on, provider, available: false as const, hint: t('chat-tools.unavailable-local') };
    if (provider === 'claude-sub') {
      const deps = aiDeps();
      const servers = on ? await probeClaudeMcpServers({ binary: deps.binaries.claude, cwd: `${deps.workDir}/claude-cwd`, token: await getSecret('claude-sub') }) : [];
      return { on, provider, available: true as const, ...(on ? { servers: servers.length } : {}), ...(on && servers.length === 0 ? { hint: t('chat-tools.none-claude') } : {}) };
    }
    if (provider === 'chatgpt-sub') return { on, provider, available: true as const };
    return { on, provider, available: false as const, hint: t(provider === 'opencode-sub' || provider === 'agy-sub' ? 'chat-tools.unavailable-cli' : 'chat-tools.unavailable-api') };
  });
  // "Buscar na web" do chat: o provedor ativo suporta? (o interruptor fica desabilitado, com o motivo, quando não)
  handle('ai:web-status', async () => {
    const provider = (await currentAiSettings()).provider;
    if (isLocalMode()) return { available: false as const, provider, hint: t('local.mode.blocked.web') };
    if (provider === 'local-model') return { available: false as const, provider, hint: t('chat.web.unavailable-local') };
    return webSearchSupported(provider) ? { available: true as const, provider } : { available: false as const, provider, hint: t('chat.web.unavailable-provider', { provider: PROVIDER_LABEL[provider] }) };
  });
  // aviso de consentimento: o toast ao começar a gravar (só UI, disparado pelo estado da sessão); o texto vem daqui, no idioma da reunião
  handle('consent:notice', async (_e, rawDir: unknown) => {
    try {
      const dir = await checkedDir(rawDir);
      const meta = await readMeta(dir);
      const lang = (await notesLanguageOf(meta)).headings === 'en' ? 'en' : 'pt-BR';
      return consentOffer(await loadSettings(), meta, lang, (l) => t('consent.default-text', undefined, l));
    } catch {
      return { show: false as const };
    }
  });
  handle('consent:mark-copied', async (_e, rawDir: unknown) => {
    const dir = await checkedDir(rawDir);
    await updateMeta(dir, (m) => ({ ...m, consentNoticeCopiedAt: toLocalIso(new Date()) }));
    return { ok: true as const };
  });
  handle('settings:set-consent', async (_e, remind: unknown, text: unknown) => {
    await saveSettings({ ...(await loadSettings()), consentRemind: remind !== false, consentText: normalizeConsentText(text) });
    return { ok: true as const };
  });
  // ocultar dados pessoais (opção global) e retenção padrão, em Configurações › Privacidade
  handle('settings:set-privacy', async (_e, input: unknown) => {
    const o = (typeof input === 'object' && input !== null ? input : {}) as { redactPii?: unknown; retentionDefault?: unknown };
    const settings = await loadSettings();
    const retentionDefault = o.retentionDefault === undefined ? settings.retentionDefault : parseRetention(o.retentionDefault);
    const { retentionDefault: _old, ...rest } = settings;
    await saveSettings({ ...rest, redactPii: o.redactPii === undefined ? settings.redactPii === true : o.redactPii === true, ...(retentionDefault ? { retentionDefault } : {}) });
    return { ok: true as const };
  });
  // pasta sensível e tempo de guarda de uma pasta (no ⋯ da pasta)
  handle('folders:set-privacy', (_e, id: unknown, patch: unknown) => folderCall((root) => setFolderPrivacy(root, String(id ?? ''), (typeof patch === 'object' && patch !== null ? patch : {}) as { sensitive?: unknown; retention?: unknown })));
  // recibo de privacidade: o que saiu (ou não) desta reunião, só a partir dos metadados guardados (nunca o conteúdo)
  const receiptOf = async (rawDir: unknown) => {
    const dir = await checkedDir(rawDir);
    const meta = await readMeta(dir);
    const receipt = buildReceipt(await readEgress(dir), meta, (key, vars) => t(key, vars), (key, n, vars) => tn(key, n, vars), (p) => t(`receipt.provider.${p}`));
    return { dir, meta, receipt, text: receiptText(receipt, meta.title, t('receipt.title')) };
  };
  handle('receipt:get', async (_e, dir: unknown) => {
    try {
      const { meta, receipt, text } = await receiptOf(dir);
      return { ok: true as const, title: meta.title, ...receipt, text };
    } catch (err) {
      return { ok: false as const, message: (err as Error).message };
    }
  });
  handle('receipt:export', async (_e, dir: unknown, mode: unknown) => {
    try {
      const { meta, receipt, text } = await receiptOf(dir);
      if (mode === 'copy') {
        clipboard.writeText(text);
        return { ok: true as const };
      }
      const deps = shareDeps(runner);
      const path = await deps.exportTarget(pdfFileName(`${t('receipt.file')} - ${meta.title}`));
      const html = receiptHtml({ title: meta.title, heading: t('receipt.title'), generated: t('receipt.generated', { date: new Date().toLocaleString(locale()) }), receipt });
      await deps.writeFile(path, await renderPdf(html, deps.createPdfWindow));
      return { ok: true as const, path, display: tildify(path) };
    } catch (err) {
      return { ok: false as const, message: (err as Error).message };
    }
  });
  // atalho global: o renderer só pede "none", "default" ou um atalho; o main valida e só guarda o que conseguiu registrar
  handle('shortcut:status', () => shortcutManager.status());
  handle('shortcut:set', async (_e, choice: unknown) => {
    const result = shortcutManager.change(choice);
    if (result.ok) await saveSettings({ ...(await loadSettings()), recordShortcut: result.saved });
    return { ok: result.ok, invalid: result.invalid === true, ...result.status };
  });
  // atualização: o aviso vem do build-info + uma consulta anônima por dia; nada se atualiza sozinho
  handle('update:status', async () => {
    // SÓ instância de teste: força o aviso para os prints ("clone" = veio de um clone; "release" = veio de uma release)
    const fake = TEST_INSTANCE ? process.env.RICE_TEST_UPDATE : undefined;
    if (fake === 'clone' || fake === 'release') return { enabled: true, available: true, from: 'a1b2c3d', to: 'e4f5a6b', fromClone: fake === 'clone', dismissed: false };
    return updateChecker.status();
  });
  // qual cópia do Rice está aberta (versão, commit do build e caminho do app): ajuda a ver se o que roda é o que acabou de ser instalado
  // "Buscar atualização agora": pedido do usuário (funciona com a consulta automática desligada; no Modo 100% local não consulta); no máx. 1 a cada 10 s
  handle('update:check-now', async () => {
    const fake = TEST_INSTANCE ? process.env.RICE_TEST_CHECKNOW : undefined; // SÓ instância de teste: resultado fixo para os prints
    if (fake === 'latest' || fake === 'available' || fake === 'error') {
      const lastCheckAt = new Date().toISOString();
      return fake === 'error' ? { phase: 'error', error: 'network' } : fake === 'available' ? { phase: 'available', newVersion: 'e4f5a6b', lastCheckAt } : { phase: 'latest', lastCheckAt };
    }
    const result = await checkNowRunner.checkNow();
    if (result.status) {
      send('update:changed', result.status);
      void maybeNotifyUpdate().catch(() => {});
    }
    return result;
  });
  // "Depois" na faixa: esconde por 24 h ou até um sha mais novo
  handle('update:dismiss', async () => {
    const s = await loadSettings();
    const state = s.updateCheck ?? {};
    if (state.sha) await saveSettings({ ...s, updateCheck: { ...state, dismissedSha: state.sha, dismissedAt: new Date().toISOString() } });
    const status = await updateChecker.status();
    send('update:changed', status);
    return status;
  });
  handle('update:last-check', async () => lastCheckOf((await loadSettings()).updateCheck) ?? null);
  handle('update:about', async () => appAbout({ version: app.getVersion(), commit: buildInfo?.commit, exePath: app.getPath('exe') }));
  // Windows: procurar / baixar / reiniciar e atualizar (nada disso roda no Mac; o estado só diz que não há suporte)
  handle('winupdate:status', async () => fakeWinUpdate() ?? winUpdater.status());
  handle('winupdate:check', async () => fakeWinUpdate() ?? winUpdater.check(true));
  handle('winupdate:download', async () => fakeWinUpdate() ?? winUpdater.download());
  handle('winupdate:install', async () => (fakeWinUpdate() ? { ok: true as const } : winUpdater.install()));
  // Windows: "Iniciar com o Windows" (desligado por padrão); só grava a opção e o item de login; instância de teste nunca mexe no sistema
  handle('settings:set-launch-at-login', async (_e, on: unknown) => {
    const value = on === true;
    await saveSettings({ ...(await loadSettings()), launchAtLogin: value });
    if (loginItemApplicable(process.platform, TEST_INSTANCE)) app.setLoginItemSettings(loginItemOptions(value));
    return { ok: true as const, launchAtLogin: value };
  });
  handle('settings:set-check-updates', async (_e, on: unknown) => {
    await saveSettings({ ...(await loadSettings()), checkUpdates: on !== false });
    const status = await updateChecker.maybeCheck();
    send('update:changed', status);
    return status;
  });
  // "Atualizar": o comando sai só do build-info (nunca do renderer); sem clone, abre a página de releases
  handle('update:run', async () => {
    const status = await updateChecker.status();
    if (status.fromClone) {
      const res = await openUpdateInTerminal(buildInfo, (file) => void execFile('open', ['-a', 'Terminal', file], () => {}));
      if (res.ok) return { ok: true as const, mode: 'terminal' as const };
    }
    void shell.openExternal(RELEASES_URL);
    return { ok: true as const, mode: 'releases' as const };
  });
  // perguntas prontas do chat: até 8, texto puro; devolve a lista normalizada (o que o main guardou)
  handle('settings:set-saved-prompts', async (_e, list: unknown) => {
    const savedPrompts = normalizeSavedPrompts(list);
    await saveSettings({ ...(await loadSettings()), savedPrompts });
    return savedPrompts;
  });
  handle('settings:set-keep-audio', async (_e, keep: unknown) => {
    await saveSettings({ ...(await loadSettings()), keepAudio: keep !== false });
    return { ok: true as const };
  });
  // abre a pasta das reuniões no Finder (caminho vem das configurações, nunca do renderer)
  handle('settings:reveal-root', async () => {
    const { root } = await loadSettings();
    await mkdir(root, { recursive: true });
    const error = await shell.openPath(root);
    return error ? { ok: false as const, message: error } : { ok: true as const };
  });

  handle('settings:set-onboarding-done', async () => {
    await saveSettings({ ...(await loadSettings()), onboardingDone: true });
    return { ok: true as const };
  });

  handle('asr:status', () => asrStatus);

  // microfone: o que está em uso (para o chip depois de recarregar a tela), a lista de entradas (Windows) e a escolha
  handle('audio:mic-current', () => (micNow && session && session.state !== 'idle' && session.currentDir === micNow.dir ? micNow : null));
  handle('audio:list-inputs', async () => {
    if (TEST_INSTANCE && process.env.RICE_TEST_MIC_INPUTS) {
      try {
        return { supported: true, inputs: JSON.parse(process.env.RICE_TEST_MIC_INPUTS) as unknown[] }; // só instância de teste: lista fictícia para os prints
      } catch {
        return { supported: false, inputs: [] };
      }
    }
    if (process.platform === 'darwin') {
      // Mac: as entradas reais do CoreAudio (sem BlackHole, Loopback, Teams Audio...), com a padrão marcada
      const real = (await macInputs()).filter((i) => !isVirtual(i));
      return { supported: real.length > 0, inputs: real.map((i) => ({ id: i.id, name: i.name, isDefault: i.isDefault, state: 'active' })) };
    }
    if (!isWindows()) return { supported: false, inputs: [] };
    const inputs = cleanInputs(await listMicInputs(riceAudioBinary())); // rice-audio.exe --list-inputs (processo curto, fora da captura)
    return { supported: inputs.length > 0, inputs };
  });
  handle('audio:set-mic', async (_e, id: unknown) => {
    if (!isWindows() && process.platform !== 'darwin' && !TEST_INSTANCE) return { ok: false as const };
    const value = typeof id === 'string' && id.length > 0 && id.length < 512 ? id : undefined; // vazio = padrão do Windows
    const { micDevice: _old, ...rest } = await loadSettings();
    await saveSettings({ ...rest, ...(value ? { micDevice: value } : {}) });
    if (isWindows()) applyMicDevice(process.env, value); // o rice-audio.exe herda RICE_MIC_DEVICE na próxima abertura do microfone (no Mac quem define é a escolha ao gravar)
    return { ok: true as const, micDevice: value ?? null };
  });
  // Mac: "Escolher o microfone automaticamente" (padrão: ligado)
  handle('audio:set-mic-auto', async (_e, on: unknown) => {
    await saveSettings({ ...(await loadSettings()), micAuto: on !== false });
    return { ok: true as const, micAuto: on !== false };
  });
  // chip do microfone: a lista para o menu (reais, a atual marcada) e a troca na hora, durante a gravação
  handle('mic:inputs', async () => {
    if (TEST_INSTANCE && process.env.RICE_TEST_MIC_INPUTS) {
      try {
        const list = (JSON.parse(process.env.RICE_TEST_MIC_INPUTS) as Array<{ id: string; name: string; isDefault?: boolean }>).map((i) => ({ id: i.id, name: i.name, short: shortMicName(i.name), isDefault: i.isDefault === true })); // só instância de teste: lista fictícia (prints)
        return { inputs: list, currentId: micNow?.id ?? list.find((i) => i.isDefault)?.id ?? null };
      } catch {
        return { inputs: [], currentId: null };
      }
    }
    const real = (await macInputs()).filter((i) => !isVirtual(i) && (i.transport !== 'bluetooth' || i.inUse || i.isDefault));
    return { inputs: real.map((i) => ({ id: i.id, name: i.name, short: shortMicName(i.name), isDefault: i.isDefault })), currentId: micNow?.id ?? micPick?.uid ?? real.find((i) => i.isDefault)?.id ?? null };
  });
  handle('mic:switch', async (_e, id: unknown) => {
    if (TEST_INSTANCE && process.env.RICE_TEST_MIC_INPUTS && session && session.state === 'recording') {
      // só instância de teste (prints): a troca "acontece" sem helper real
      const list = JSON.parse(process.env.RICE_TEST_MIC_INPUTS) as Array<{ id: string; name: string; isDefault?: boolean }>;
      const hit = list.find((i) => i.id === id) ?? list.find((i) => i.isDefault);
      if (hit) void onMic({ id: hit.id, name: hit.name, isDefault: hit.isDefault === true, chosen: typeof id === 'string' && id !== '' });
      send('session:mic-mute', null);
      return { ok: true as const };
    }
    if (!session || session.state !== 'recording' || process.platform !== 'darwin') return { ok: false as const };
    const uid = typeof id === 'string' && id.length > 0 && id.length < 512 ? id : undefined; // vazio = Padrão do macOS
    micPick = { uid, name: '', transport: 'other', reason: uid ? 'fixed' : 'default' }; // trocou na mão: deixa de ser "detectado"
    muteMonitor.reset(Date.now()); // nova contagem e o aviso de mudo volta a valer
    session.switchMic(uid);
    return { ok: true as const };
  });
  handle('mic:mute-ignore', async () => {
    muteMonitor.markWarned();
    return { ok: true as const };
  });
  // modelo de transcrição em uso e o motivo (modo leve com pouca memória); o usuário pode forçar Leve ou Completo
  const profileNow = async () => {
    const choice = asrChoiceOf((await loadSettings()).asrModel);
    const fake = TEST_INSTANCE ? { gb: Number(process.env.RICE_TEST_RAM_GB), cores: Number(process.env.RICE_TEST_CORES) } : { gb: 0, cores: 0 }; // só instância de teste (prints)
    return { choice, ...machineProfile({ platform: PLATFORM_FOR_UI, totalMemBytes: fake.gb > 0 ? fake.gb * 1024 ** 3 : totalmem(), logicalCores: fake.cores > 0 ? fake.cores : availableParallelism(), choice }) };
  };
  handle('audio:profile', () => profileNow());
  handle('audio:set-asr-model', async (_e, choice: unknown) => {
    if (!isWindows() && !TEST_INSTANCE) return { ok: false as const }; // o Mac ignora o modo (sempre o modelo grande quantizado)
    const next = asrChoiceOf(choice);
    await saveSettings({ ...(await loadSettings()), asrModel: next });
    setTranscriberMode(next);
    const p = await profileNow();
    setLightFactor(p.light ? 2 : 1);
    const recording = session !== null && session.state !== 'idle';
    if (asrService && !recording && isWindows()) {
      await asrService.stop().catch(() => {}); // a troca vale já, se não há gravação; baixa o modelo escolhido em segundo plano
      void asrService.warmup();
    }
    return { ok: true as const, appliedNow: !recording, ...p };
  });

  // `headings`: idioma dos nomes das seções dos embutidos (a página da reunião passa o idioma dela; senão vale o do app)
  const displayLanguage = async (headings: unknown): Promise<UiLanguage> => (headings === 'en' || headings === 'pt-BR' ? headings : currentUiLanguage());
  handle('templates:list', async (_e, headings?: unknown) => {
    const { root, defaultTemplateId } = await loadSettings();
    const language = await displayLanguage(headings);
    const { templates, warnings } = await listTemplates(root);
    if (warnings.length > 0) logWarn(`${warnings.length} template(s) ignorado(s)`);
    return { templates: templates.map((tpl) => localizeTemplate(tpl, language)), warnings, defaultId: (await resolveTemplate(root, defaultTemplateId)).id };
  });
  handle('templates:get', async (_e, id: string, headings?: unknown) => {
    const found = await getTemplate((await loadSettings()).root, String(id ?? ''));
    return found ? localizeTemplate(found, await displayLanguage(headings)) : null;
  });
  handle('templates:save', async (_e, input: NoteTemplateInput) => {
    try {
      return { ok: true as const, template: await saveTemplate((await loadSettings()).root, input) };
    } catch (err) {
      return { ok: false as const, message: (err as Error).message };
    }
  });
  handle('templates:delete', async (_e, id: string) => {
    try {
      const settings = await loadSettings();
      await deleteTemplate(settings.root, String(id ?? ''));
      if (settings.defaultTemplateId === id) {
        const { defaultTemplateId: _gone, ...rest } = settings;
        await saveSettings(rest);
      }
      return { ok: true as const };
    } catch (err) {
      return { ok: false as const, message: (err as Error).message };
    }
  });
  handle('templates:restore', async (_e, id: string) => {
    try {
      return { ok: true as const, template: await restoreBuiltinTemplate((await loadSettings()).root, String(id ?? '')) };
    } catch (err) {
      return { ok: false as const, message: (err as Error).message };
    }
  });
  // templates de ideias (modo ideia): embutidos + do usuário em <raiz>/.rice/idea-templates
  handle('ideatemplates:list', async (_e, headings?: unknown) => {
    const { root, lastIdeaTemplate } = await loadSettings();
    const language = await displayLanguage(headings);
    const { templates, warnings } = await listIdeaTemplates(root);
    return { templates: templates.map((x) => localizeIdeaTemplate(x, language)), warnings, lastId: lastIdeaTemplate ?? 'general' };
  });
  handle('ideatemplates:save', async (_e, input: unknown) => {
    try {
      return { ok: true as const, template: await saveIdeaTemplate((await loadSettings()).root, input as never) };
    } catch (err) {
      return { ok: false as const, message: (err as Error).message };
    }
  });
  handle('ideatemplates:delete', async (_e, id: string) => {
    try {
      await deleteIdeaTemplate((await loadSettings()).root, String(id ?? ''));
      return { ok: true as const };
    } catch (err) {
      return { ok: false as const, message: (err as Error).message };
    }
  });
  handle('ideatemplates:restore', async (_e, id: string) => {
    try {
      return { ok: true as const, template: await restoreBuiltinIdeaTemplate((await loadSettings()).root, String(id ?? '')) };
    } catch (err) {
      return { ok: false as const, message: (err as Error).message };
    }
  });
  handle('templates:set-default', async (_e, id: string) => {
    const settings = await loadSettings();
    const template = await getTemplate(settings.root, String(id ?? ''));
    if (!template) return { ok: false as const, message: t('err.template-not-found') };
    await saveSettings({ ...settings, defaultTemplateId: template.id });
    return { ok: true as const };
  });
  // idioma falado nesta reunião (vale ao começar ou continuar a gravação; não muda durante uma gravação)
  handle('meetings:set-language', async (_e, rawDir: string, language: unknown) => {
    try {
      const dir = await checkedDir(rawDir);
      if (!isTranscriptionLanguage(language)) throw new Error(t('err.language-invalid'));
      if (session && session.state !== 'idle' && session.currentDir === dir) throw new Error(t('err.language-recording'));
      await updateMeta(dir, (meta) => ({ ...meta, language }));
      return { ok: true as const };
    } catch (err) {
      return { ok: false as const, message: (err as Error).message };
    }
  });
  // ---- pastas (agrupamento na barra lateral): só rótulos; nenhuma pasta física se move ----
  const folderCall = async <T>(run: (root: string) => Promise<T>) => {
    try {
      return { ok: true as const, value: await run((await loadSettings()).root) };
    } catch (err) {
      return { ok: false as const, message: (err as Error).message };
    }
  };
  handle('folders:list', async () => readFolders((await loadSettings()).root));
  handle('folders:create', (_e, name: unknown, parentId?: unknown) => folderCall((root) => createFolder(root, name, parentId)));
  handle('folders:move', (_e, id: unknown, parentId: unknown) => folderCall((root) => moveFolder(root, String(id ?? ''), parentId ?? null)));
  handle('folders:rename', (_e, id: unknown, name: unknown) => folderCall((root) => renameFolder(root, String(id ?? ''), name)));
  handle('folders:delete', (_e, id: unknown) => folderCall((root) => deleteFolder(root, String(id ?? ''))));
  handle('folders:reorder', (_e, ids: unknown) => folderCall((root) => reorderFolders(root, ids)));
  // `dir` validado contra a raiz; `folderId` contra a lista (null remove da pasta)
  handle('meetings:set-folder', async (_e, rawDir: string, folderId: unknown) => {
    try {
      await setMeetingFolder((await loadSettings()).root, rawDir, folderId);
      return { ok: true as const };
    } catch (err) {
      return { ok: false as const, message: (err as Error).message };
    }
  });

  handle('meetings:set-template', async (_e, rawDir: string, templateId: string) => {
    try {
      const dir = await checkedDir(rawDir);
      const template = await getTemplate((await loadSettings()).root, String(templateId ?? ''));
      if (!template) throw new Error(t('err.template-not-found'));
      await updateMeta(dir, (meta) => ({ ...meta, templateId: template.id }));
      return { ok: true as const };
    } catch (err) {
      return { ok: false as const, message: (err as Error).message };
    }
  });

  handle('app:permission-status', () => ({
    microphone: systemPreferences.getMediaAccessStatus('microphone'),
  }));

  // URL fixa: o renderer nunca escolhe o que abrir.
  handle('app:open-privacy', () => shell.openExternal(systemPanelUrl('microphone')));

  // URLs fixas: o renderer nunca escolhe o que abrir.
  handle('app:open-internet-accounts', () => shell.openExternal('x-apple.systempreferences:com.apple.Internet-Accounts-Settings.extension'));
  handle('app:open-calendar-privacy', () => shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars'));
  handle('app:open-reminders-privacy', () => shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Reminders'));
  // Lembretes de hoje (EKReminder): lidos só no Mac, mostrados no Início e nunca enviados à IA
  const remindersEnabled = async () => remindersSupported() && (await loadSettings()).showReminders !== false;
  handle('reminders:status', async () => ({ access: remindersAccess, enabled: remindersSupported() && (await remindersEnabled()) }));
  handle('reminders:request', () => {
    if (remindersAccess === 'notDetermined') detector?.requestRemindersAccess(); // a resposta chega por 'reminders:changed'
    return { access: remindersAccess };
  });
  handle('reminders:list', async () => {
    const enabled = await remindersEnabled();
    const items = enabled && remindersAccess === 'granted' && detector ? await detector.listReminders() : [];
    return { access: remindersAccess, enabled, items };
  });
  handle('reminders:complete', async (_e, id: unknown) => ({ ok: typeof id === 'string' && id.length > 0 && id.length < 200 && remindersAccess === 'granted' && detector ? await detector.completeReminder(id) : false }));
  handle('reminders:set-enabled', async (_e, on: unknown) => {
    await saveSettings({ ...(await loadSettings()), showReminders: on !== false });
    send('reminders:changed', null);
    return { ok: true as const };
  });
  handle('calendar:eventkit-status', () => ({ access: calendarAccess }));
  handle('calendar:eventkit-request', () => {
    if (calendarAccess === 'notDetermined') detector?.requestCalendarAccess(); // a resposta chega por 'calendar-access'
    return { access: calendarAccess };
  });
  handle('calendar:google-status', async () => ({
    ...(await googleAuth.status()),
    calendars: calendarFeed.calendarCount(),
    error: calendarFeed.lastError,
    ...(isLocalMode() ? { blocked: t('local.mode.blocked.google') } : {}),
  }));
  // Agenda por link (ICS): o renderer só recebe o domínio e a contagem; o link inteiro nunca sai do main
  handle('calendar:ics-status', () => icsSub.status());
  handle('calendar:ics-save', async (_e, url: unknown) => {
    const r = await icsSub.save(typeof url === 'string' ? url : '');
    if (!r.ok) return r;
    calendarFeed.setIcs(r.events);
    return { ok: true as const, count: r.count };
  });
  handle('calendar:ics-remove', async () => {
    await icsSub.remove();
    calendarFeed.setIcs([]);
    return { ok: true as const };
  });
  handle('calendar:ics-refresh', async () => {
    await refreshIcs();
    return icsSub.status();
  });
  handle('calendar:google-save-client', (_e, id: string, secret: string) => googleAuth.saveClient(String(id ?? ''), String(secret ?? '')));
  handle('calendar:google-connect', async () => {
    if (isLocalMode()) return { ok: false as const, message: t('local.mode.blocked.google') };
    const result = await googleAuth.connect();
    if (result.ok) await calendarFeed.refresh();
    return result;
  });
  handle('calendar:google-disconnect', async () => {
    calendarFeed.invalidate(); // descarta refresh em andamento antes de apagar as credenciais
    await googleAuth.disconnect();
    await calendarFeed.refresh();
    return { ok: true as const };
  });
  handle('alert:action', (e, action: string) => {
    const entry = [...alertWindows.entries()].find(([, w]) => !w.isDestroyed() && w.webContents === e.sender);
    if (!entry || !alertScheduler) return; // só as janelinhas de aviso podem agir
    const [key] = entry;
    const ev = alertScheduler.eventFor(key);
    alertScheduler.dismiss(key);
    if (!ev) return;
    if (action === 'join') startFromCalendar(ev, true);
    else if (action === 'record') startFromCalendar(ev, false);
  });
  handle('calendar:events', () => calendarFeed.events().map(({ selfEmail: _self, ...rest }) => rest)); // o e-mail do próprio usuário não vai para o renderer
  handle('calendar:open-link', (_e, url: string) => openJoinUrl(String(url ?? '')));

  // ---- provedores de IA: o renderer nunca recebe segredo, só hasKey e os 4 últimos caracteres ----
  handle('ai:status', async () => {
    const settings = await currentAiSettings();
    const notice = (await loadSettings()).aiNotices?.geminiSub ? 'gemini-discontinued' : null;
    return { ...(await aiStatus(settings, aiDeps())), light: settings.light, lightModel: (await lightModelFor(settings, undefined, () => cachedAgyModels({ binary: agyBinary(), workDir: app.getPath('userData') }, false), () => installedLocalModels(aiDeps()))) ?? null, fullyLocal: isLocalMode(), notice };
  });
  // o aviso aparece até a tela de IA mostrá-lo uma vez: aí o renderer chama isto e ele some
  handle('ai:dismiss-notice', async () => {
    const settings = await loadSettings();
    if (settings.aiNotices?.geminiSub) {
      const { geminiSub: _gone, ...rest } = settings.aiNotices;
      await saveSettings({ ...settings, aiNotices: rest });
    }
    return { ok: true as const };
  });
  handle('ai:set-light', async (_e, value: unknown) => {
    const v = String(value ?? '').trim();
    const provider = (await currentAiSettings()).provider;
    if (v !== 'auto' && v !== 'same' && !isModelFor(provider, v)) return { ok: false as const, message: t('err.model-invalid') };
    await updateAiSettings((ai) => ({ ...ai, light: v }));
    return { ok: true as const };
  });

  handle('ai:set-provider', async (_e, provider: unknown) => {
    invalidateAiStatus();
    if (!isProvider(provider)) return { ok: false as const, message: t('err.provider-unknown') };
    if (isLocalMode() && provider !== 'local-model') return { ok: false as const, message: t('local.mode.only-local') };
    await updateAiSettings((ai) => ({ ...ai, provider }));
    return { ok: true as const };
  });

  handle('ai:save-key', async (_e, provider: unknown, raw: unknown) => {
    invalidateAiStatus();
    if (!isProvider(provider) || !hasKeyField(provider)) return { ok: false as const, message: t('err.provider-no-key') };
    if (isLocalMode()) return { ok: false as const, message: t('local.mode.only-local') };
    const valid = validateKey(provider, String(raw ?? ''));
    if (!valid.ok) return { ok: false as const, message: valid.message };
    if (!safeStorage.isEncryptionAvailable()) return { ok: false as const, message: t('err.keychain') };
    await saveSecret(app.getPath('userData'), provider, valid.key, tokenCrypto);
    await updateAiSettings((ai) => ({ ...ai, verified: { ...ai.verified, [provider]: undefined } })); // a conexão mudou: testar de novo
    return { ok: true as const, last4: valid.key.slice(-4) };
  });

  handle('ai:clear-key', async (_e, provider: unknown) => {
    invalidateAiStatus();
    if (!isProvider(provider) || !hasKeyField(provider)) return { ok: false as const, message: t('err.provider-no-key') };
    await clearSecret(app.getPath('userData'), provider);
    await updateAiSettings((ai) => ({ ...ai, verified: { ...ai.verified, [provider]: undefined } }));
    return { ok: true as const };
  });

  handle('ai:test', async (_e, provider: unknown) => {
    invalidateAiStatus();
    if (!isProvider(provider)) return { ok: false as const, message: t('err.provider-unknown') };
    if (isLocalMode() && provider !== 'local-model') return { ok: false as const, message: t('local.mode.only-local') };
    const result = await testProvider(provider, await currentAiSettings(), aiDeps());
    await updateAiSettings((ai) => ({ ...ai, verified: { ...ai.verified, [provider]: result.ok } }));
    return result;
  });

  handle('ai:list-models', async (_e, provider: unknown) => {
    if (!isProvider(provider)) return { ok: false as const, message: t('err.provider-unknown') };
    if (isLocalMode() && provider !== 'local-model') return { ok: false as const, message: t('local.mode.only-local') };
    return listModels(provider, aiDeps());
  });

  // modelos que o menu de IA do chat oferece para um provedor (o OpenCode consulta a CLI; o ChatGPT lê o cache do codex)
  handle('ai:model-catalog', async (_e, provider: unknown) => {
    if (!isProvider(provider)) return { ok: false as const, message: t('err.provider-unknown') };
    const models = await modelCatalog(provider, {
      opencode: async () => {
        const r = await listModels('opencode-sub', aiDeps());
        return r.ok ? r.models : [];
      },
      local: async () => (await installedLocalModels(aiDeps())).map((m) => ({ id: m.id, label: m.id })),
      agy: async () => {
        const r = await listModels('agy-sub', aiDeps());
        return r.ok ? r.models.map((id) => ({ id, label: id })) : [];
      },
    });
    return { ok: true as const, models };
  });

  // Modelo local: endereço (SÓ localhost; qualquer outro é recusado aqui) e tamanho do contexto
  handle('ai:set-local', async (_e, input: unknown) => {
    const o = (typeof input === 'object' && input !== null ? input : {}) as { url?: unknown; numCtx?: unknown; server?: unknown };
    let url: string | undefined;
    if (typeof o.url === 'string' && o.url.trim()) {
      try {
        url = parseLocalUrl(o.url);
      } catch (err) {
        return { ok: false as const, message: (err as Error).message };
      }
    }
    if (o.numCtx !== undefined && !isNumCtx(o.numCtx)) return { ok: false as const, message: t('ai.local.bad-ctx') };
    if (o.server !== undefined && !isLocalServerId(o.server)) return { ok: false as const, message: t('ai.local.bad-url') };
    invalidateAiStatus();
    const ai = await updateAiSettings((cur) => {
      const server = o.server === undefined ? cur.local?.server : o.server === 'auto' ? undefined : (o.server as LocalServerId);
      return { ...cur, local: { ...(url ? { url } : {}), ...(server ? { server } : {}), ...(isNumCtx(o.numCtx) ? { numCtx: o.numCtx } : cur.local?.numCtx ? { numCtx: cur.local.numCtx } : {}) } };
    });
    return { ok: true as const, local: ai.local ?? {} };
  });
  // Modo 100% local: só liga com o Modelo local ativo; bloqueia tudo o que usa a rede (ver privacy/local-mode.ts)
  handle('privacy:set-local-mode', async (_e, on: unknown) => {
    if (on === true) {
      if ((await currentAiSettings()).provider !== 'local-model') return { ok: false as const, needsProvider: true as const, message: t('local.mode.need-provider') };
      setLocalMode(true);
    } else {
      setLocalMode(false);
    }
    await saveSettings({ ...(await loadSettings()), fullyLocal: on === true });
    invalidateAiStatus();
    send('privacy:changed', { fullyLocal: isLocalMode() });
    void refreshIcs().catch(() => {}); // ligar o Modo 100% local tira os eventos do link; desligar volta a ler
    return { ok: true as const, fullyLocal: isLocalMode() };
  });
  handle('ai:set-model', async (_e, provider: unknown, model: unknown) => {
    if (!isProvider(provider)) return { ok: false as const, message: t('err.provider-unknown') };
    const value = String(model ?? '').trim();
    if (value && !isModelFor(provider, value)) return { ok: false as const, message: t('err.model-invalid') };
    await updateAiSettings((ai) => {
      const { [provider]: _old, ...models } = ai.models;
      return { ...ai, models: value ? { ...models, [provider]: value } : models };
    });
    return { ok: true as const };
  });

  handle('settings:choose-root', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'], title: t('dialog.choose-root') });
    if (result.canceled || !result.filePaths[0]) return loadSettings();
    const settings = { ...(await loadSettings()), root: result.filePaths[0] };
    await saveSettings(settings);
    return settings;
  });

  handle('meetings:repair', async (_e, rawDir: string) => {
    try {
      const dir = await checkedDir(rawDir);
      if (await readMetaIfUsable(dir)) return { ok: true as const, meta: await readMeta(dir) }; // já está bom
      return { ok: true as const, meta: await repairMeta(dir) };
    } catch (err) {
      return { ok: false as const, message: err instanceof Error ? err.message : String(err) };
    }
  });
  handle('meetings:list', async () => {
    const { root } = await loadSettings();
    const dirs = await listMeetingDirs(root);
    const metas = await Promise.all(
      dirs.map(async (dir) => {
        // R-52: meta ilegível não derruba a lista: a reunião aparece como "precisa de reparo" (título e data pelo nome da pasta)
        return (await readMetaIfUsable(dir).then((m) => (m ? { dir, ...m } : null))) ?? (await damagedEntry(dir).catch(() => null));
      }),
    );
    return metas.filter((m) => m !== null).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  });

  // busca no conteúdo: o índice fica em memória e é atualizado por data de modificação a cada consulta
  handle('search:query', (_e, query: unknown) =>
    handleSearch({ root: async () => (await loadSettings()).root, folders: readFolders, index: searchIndex }, query).catch((err) => {
      logError('search failed', err);
      return [];
    }),
  );

  // "Nova reunião" / "Nova war room" sem título e sem agenda reaproveitam o rascunho vazio mais recente (não criam mais uma pasta)
  handle('meetings:create', (_e, title: string, calendarEventId?: string, folderId?: string, kind?: string) => createMeetingDraft(title, calendarEventId, folderId, kind));
  // ao sair de uma reunião: se ela ficou vazia (rascunho), vai para a Lixeira em silêncio; a que está gravando nunca
  handle('meetings:discard-draft', async (_e, rawDir: unknown) => {
    const dir = await checkedDir(rawDir);
    if (!canDeleteMeeting({ sessionState: session?.state ?? 'idle', currentDir: session?.currentDir ?? null, dir })) return { ok: false as const };
    return { ok: await discardEmptyDraft(dir, (d) => shell.trashItem(d)) };
  });

  handle('meetings:read', async (_e, rawDir: string) => {
    const dir = await checkedDir(rawDir);
    return {
    meta: await readMeta(dir),
    transcript: await readMeetingText(dir, 'transcript'),
    annotations: await readMeetingText(dir, 'annotations'),
    notes: await readMeetingText(dir, 'notes'),
    chat: await readChat(dir),
    };
  });

  // dar nome a "Pessoa N": vale para a reunião toda (meta.speakers); nome vazio remove
  handle('meetings:set-speaker-name', async (_e, rawDir: string, id: unknown, name: unknown) => {
    const dir = await checkedDir(rawDir);
    const key = String(Math.trunc(Number(id)));
    if (!/^[1-9]\d?$/.test(key)) return { ok: false as const, message: t('err.speaker-invalid') };
    const clean = cleanSpeakerName(name);
    const speakers = await setSpeakerName(dir, Number(key), clean);
    return { ok: true as const, speakers };
  });
  // sugestão da IA pelo contexto da conversa; só devolve, nunca aplica
  handle('meetings:suggest-speakers', async (_e, rawDir: string) => {
    try {
      const dir = await checkedDir(rawDir);
      const meta = await readMeta(dir);
      const { language } = await notesLanguageOf(meta);
      const transcript = await chatTranscript(dir, await readMeetingText(dir, 'transcript'), 'obrigado, valeu, thanks', language);
      return { ok: true as const, suggestions: await suggestSpeakerNames(withEgressContext(lightRunner ?? runner, { kind: 'other', dir }), transcript, language) };
    } catch (err) {
      return { ok: false as const, message: err instanceof Error ? err.message : String(err) };
    }
  });
  handle('meetings:notes-progress', async (_e, rawDir: string) => notesProgress.get(await checkedDir(rawDir)) ?? null);
  handle('meetings:save-annotations', async (_e, rawDir: string, text: string) => {
    const dir = await checkedDir(rawDir);
    const meta = await readMeta(dir);
    return saveAnnotations(dir, String(text ?? ''), new Date(), meta.state === 'recording');
  });

  handle('meetings:rename', async (_e, dir: string, title: string) => {
    try {
      const meta = await renameMeeting(await checkedDir(dir), String(title ?? ''));
      return { ok: true as const, title: meta.title };
    } catch (err) {
      return { ok: false as const, message: (err as Error).message };
    }
  });

  handle('meetings:delete', async (_e, dir: string) => {
    try {
      const { root } = await loadSettings();
      await deleteMeetingDir({ dir, root, sessionState: session?.state ?? 'idle', currentDir: session?.currentDir ?? null, trash: (d) => shell.trashItem(d) });
      await memoryRef?.removeMeeting(resolve(String(dir))).catch(() => {}); // apagar a reunião remove os fatos dela
      return { ok: true as const };
    } catch (err) {
      return { ok: false as const, message: (err as Error).message };
    }
  });

  handle('meetings:reveal', async (_e, dir: string) => shell.openPath(await checkedDir(dir)));

  handle('chat:ask', async (event, id: number, rawDir: string, question: string, web?: unknown) => {
    const controller = new AbortController();
    chats.set(id, controller);
    try {
      const dir = await checkedDir(rawDir);
      let sources: WebSource[] = [];
      const answer = await chatAnswer(runner, dir, question, controller.signal, (text) => event.sender.send('chat:delta', id, text), await webRequested(web), (list) => (sources = list));
      return { ok: true as const, answer, sources };
    } catch (err) {
      const kind = err instanceof AiError ? err.kind : 'other';
      return { ok: false as const, kind, message: (err as Error).message };
    } finally {
      chats.delete(id);
    }
  });

  // ---- compartilhar: copiar notas (HTML + Markdown), rascunho de e-mail, Mail e PDF ----
  // texto puro para a área de transferência pelo main: a página não tem permissão de clipboard (hardening nega tudo)
  handle('clipboard:write-text', (_e, text: unknown) => {
    if (typeof text !== 'string' || text.length > 200_000) return false;
    clipboard.writeText(text);
    return true;
  });
  handle('share:copy-notes', (_e, dir: unknown) => copyNotes(shareDeps(runner), dir, 'rich'));
  handle('share:copy-markdown', (_e, dir: unknown) => copyNotes(shareDeps(runner), dir, 'markdown'));
  handle('share:email-draft', async (_e, id: number, dir: unknown) => {
    const controller = new AbortController();
    chats.set(id, controller);
    try {
      return await draftEmail(shareDeps(runner), dir, controller.signal);
    } finally {
      chats.delete(id);
    }
  });
  handle('share:open-mail', (_e, draft: unknown) => openMail(shareDeps(runner), draft));
  handle('share:export-info', (_e, dir: unknown) => exportInfo(shareDeps(runner), dir));
  handle('share:export-pdf', async (_e, dir: unknown, options: unknown) => {
    const result = await exportPdf(shareDeps(runner), dir, (options ?? {}) as Record<string, unknown>);
    return result.ok ? { ...result, display: tildify(result.path) } : result;
  });
  // "Alterar…": escolhe a pasta no diálogo nativo e lembra para as próximas vezes
  handle('share:choose-export-dir', async () => {
    const options = { title: t('dialog.save-pdf'), defaultPath: await exportDir(), properties: ['openDirectory' as const, 'createDirectory' as const] };
    const result = window && !window.isDestroyed() ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) return { ok: true as const, canceled: true as const, folder: tildify(await exportDir()) };
    await saveSettings({ ...(await loadSettings()), exportDir: result.filePaths[0] });
    return { ok: true as const, folder: tildify(result.filePaths[0]) };
  });
  handle('share:reveal-export', (_e, path: unknown) => {
    if (typeof path !== 'string' || path !== lastExport) return { ok: false as const };
    shell.showItemInFolder(path);
    return { ok: true as const };
  });

  // chat entre reuniões: o escopo é validado no main; o streaming usa o mesmo 'chat:delta' do chat da reunião
  handle('gchat:history', async () => readGlobalConversation((await loadSettings()).root));
  handle('gchat:new', async () => {
    await startNewGlobalConversation((await loadSettings()).root);
    return { ok: true as const };
  });
  handle('gchat:ask', async (event, id: number, question: unknown, scope: unknown, web?: unknown) => {
    const controller = new AbortController();
    chats.set(id, controller);
    try {
      return await askAcrossMeetings(
        {
          root: async () => (await loadSettings()).root,
          folders: readFolders,
          index: searchIndex,
          runner,
          language: async () => ((await currentUiLanguage()) === 'en' ? 'en' : 'pt'),
          noMeetings: (lang) => t('gchat.none', undefined, lang === 'en' ? 'en' : 'pt-BR'),
          fallbackNotice: (lang) => t('gchat.fallback', undefined, lang === 'en' ? 'en' : 'pt-BR'),
          noMeetingsInPeriod: (lang) => t('gchat.none-period', undefined, lang === 'en' ? 'en' : 'pt-BR'),
          memory: async (q) => (await memoryRef?.chatContext(q)) ?? { text: '', dirs: [] },
          useTools: toolsAllowed,
          contextBudget: async () => (await activeLocalBudget())?.globalChars,
          web: () => webRequested(web),
        },
        question,
        scope,
        controller.signal,
        (text) => event.sender.send('chat:delta', id, text),
      );
    } finally {
      chats.delete(id);
    }
  });

  handle('chat:cancel', (_e, id: number) => chats.get(id)?.abort());
}

/**
 * R-56: uma instância só usa o microfone e a pasta das reuniões. A segunda traz a primeira para a frente e encerra
 * (o bloqueio é por `--user-data-dir`, então uma instância de teste isolada não conflita com a do dia a dia).
 */
const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (window && !window.isDestroyed()) {
      if (window.isMinimized()) window.restore();
      if (!BENCH) window.show();
      window.focus();
    } else {
      createWindow();
    }
  });
}

// instâncias de teste/medição (RICE_BENCH ou --user-data-dir próprio) usam um Keychain falso: rodam isoladas, sem acesso ao
// Keychain do usuário, e o macOS mostrava "Chaves Não Encontradas" na tela dele a cada abertura
const TEST_INSTANCE = BENCH || process.env.RICE_MOCK_KEYCHAIN === '1' || process.argv.some((a) => a.startsWith('--user-data-dir'));
if (TEST_INSTANCE && process.platform === 'darwin') app.commandLine.appendSwitch('use-mock-keychain');

// renderers sempre em sandbox (os preloads só usam contextBridge/ipcRenderer) e toda janela, inclusive a do PDF, travada
app.enableSandbox();
app.on('web-contents-created', (_e, contents) => lockdownWebContents(contents, RENDERER_DIR));

app.whenReady().then(async () => {
  if (!singleInstance) return; // a segunda instância só espera o `quit`
  // nenhuma permissão de página (câmera, microfone do navegador, localização, notificações...): o áudio é capturado pelo
  // processo nativo e as notificações são do próprio Electron; downloads por página também ficam bloqueados
  void loadSettings().then(({ root }) => tightenAppData(root, app.getPath('userData'))).catch(() => {}); // corrige o que foi criado antes com 0755/0644
  const ses = electronSession.defaultSession;
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.setDevicePermissionHandler(() => false);
  ses.on('will-download', (event) => event.preventDefault());
  if (isWindows()) {
    app.setAppUserModelId('com.rice.app'); // avisos e agrupamento na barra de tarefas
    nativeTheme.on('updated', () => {
      if (window && !window.isDestroyed()) window.setTitleBarOverlay(titleBarOverlay(nativeTheme.shouldUseDarkColors, window.webContents.getZoomFactor()));
    });
  }
  if (BENCH) app.dock?.hide();
  if (appIconPath) {
    const image = nativeImage.createFromPath(appIconPath);
    if (!image.isEmpty()) app.dock?.setIcon(image);
  }
  uiLanguageNow = await currentUiLanguage();
  setLanguage(uiLanguageNow);
  buildAppMenu();
  await migrateLegacyToken(app.getPath('userData')).catch((err) => logError('token migration', err));
  const runner = createActiveRunner(currentAiSettings, aiDeps());
  lightRunner = createLightRunner(currentAiSettings, aiDeps());
  configureLongNotes({
    lightRunner,
    // modelo local: janela pequena; o limite do map-reduce e o tamanho das partes seguem o `num_ctx` escolhido
    budget: () => {
      const ai = resolveAiSettings(cachedSettings.ai);
      return ai.provider === 'local-model' ? localBudget(ai.local?.numCtx ?? DEFAULT_NUM_CTX) : null;
    },
    ...(typeof cachedSettings.notesDirectMaxChars === 'number' && cachedSettings.notesDirectMaxChars >= 5_000 ? { directMaxChars: cachedSettings.notesDirectMaxChars } : {}),
    onProgress: (p) => {
      if (p.phase === 'done') notesProgress.delete(p.dir);
      else notesProgress.set(p.dir, p);
      send('session:notes-progress', p);
    },
  });
  registerIpc(runner);
  const asr = setupSession(runner);
  if (!BENCH) {
    createTray();
    nub = createNub();
  }
  try {
    const result = await recoverInterrupted((await loadSettings()).root);
    recoveredCount = (Array.isArray(result) ? result : result.recovered).length;
  } catch (err) {
    logError('recovery failed', err);
  }
  setLightFactor(machineProfile({ platform: PLATFORM_FOR_UI, totalMemBytes: totalmem(), logicalCores: availableParallelism(), choice: (await loadSettings()).asrModel }).light ? 2 : 1); // modo leve: IA ao vivo mais contida
  if (loginItemApplicable(process.platform, TEST_INSTANCE)) app.setLoginItemSettings(loginItemOptions((await loadSettings()).launchAtLogin === true)); // mantém o item do Windows em dia com a opção
  if (!startedAtLogin(process.argv) || !isWindows()) createWindow(); // aberto pelo Windows ao entrar: só a bandeja (o clique no ícone, um aviso ou o atalho abrem a janela)
  setupDetector();
  const sendCalendar = (channel: string) => window && !window.isDestroyed() && window.webContents.send(channel, null);
  calendarFeed.on('change', () => sendCalendar('calendar:changed'));
  googleAuth.on('disconnected', () => {
    sendCalendar('calendar:disconnected');
    void calendarFeed.refresh();
  });
  powerMonitor.on('suspend', () => session?.suspend());
  powerMonitor.on('resume', () => {
    session?.resume();
    void calendarFeed.refresh();
    void refreshEventKit();
  });
  alertScheduler = new AlertScheduler({
    now: Date.now,
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as NodeJS.Timeout),
    isRecording: () => session?.state !== 'idle',
    show: showAlert,
  });
  calendarFeed.on('change', () => {
    alertScheduler?.update(calendarFeed.events());
    const mine = [...new Set(calendarFeed.events().flatMap((e) => (e.selfEmail ? [e.selfEmail.split('@')[1]?.toLowerCase() ?? ''] : [])).filter(Boolean))];
    if (mine.some((d) => !(cachedSettings.memoryOwnDomains ?? []).includes(d))) void saveSettings({ ...cachedSettings, memoryOwnDomains: [...new Set([...(cachedSettings.memoryOwnDomains ?? []), ...mine])] }).catch(() => {});
  });
  if (TEST_INSTANCE && process.env.RICE_TEST_EVENTS) {
    try {
      calendarFeed.setTestEvents(JSON.parse(process.env.RICE_TEST_EVENTS));
    } catch {
      // JSON inválido: sem eventos de teste
    }
  }
  calendarFeed.start();
  void refreshIcs().catch(() => {});
  setInterval(() => void refreshIcs().catch(() => {}), ICS_REFRESH_MS).unref(); // a cada 10 min, só o link assinado
  setInterval(() => void refreshEventKit(), 5 * 60_000).unref();
  setTimeout(() => void asr.warmup(), 2000);
  shortcutManager.init((await loadSettings()).recordShortcut);
  // retenção por pasta: varredura ao abrir e a cada 24 h; o que venceu vai para a Lixeira (nunca apaga em definitivo) e o Rice avisa uma vez
  setTimeout(() => void sweepRetention().catch((err) => logError('retention', err)), 30_000).unref();
  setInterval(() => void sweepRetention().catch((err) => logError('retention', err)), 24 * 3_600_000).unref();
  // versão nova: lê o build-info e consulta (no máximo uma vez por dia) pouco depois de abrir e a cada 6 h com o app aberto
  buildInfo = await readBuildInfo(join(__dirname, 'build-info.json'));
  const checkUpdate = () => {
    void updateChecker.maybeCheck().then((status) => { send('update:changed', status); void maybeNotifyUpdate().catch(() => {}); }).catch(() => {});
    if (!TEST_INSTANCE) void winUpdater.check(false).then((st) => (st.supported && st.error === undefined ? markChecked() : undefined)).catch(() => {}); // Windows instalado pelo NSIS; no Mac o estado fica sem suporte
  };
  setTimeout(checkUpdate, 20_000).unref();
  setInterval(checkUpdate, 6 * 3_600_000).unref();
  // monta o índice de busca em segundo plano, para a primeira busca já encontrar tudo
  void loadSettings().then(({ root }) => searchIndex.refresh(root)).catch((err) => logError('search index', err));
  // versões antigas guardavam os centroides das vozes em `falantes.json` por reunião; a assinatura de voz agora é só em memória: apaga o legado
  void loadSettings().then(async ({ root }) => removeLegacyVoiceFiles(await listMeetingDirs(root))).catch((err) => logError('voice cleanup', err));
  app.on('activate', createWindow);

  app.on('before-quit', (event) => {
    if (quitting) return;
    shortcutManager.dispose();
    event.preventDefault();
    quitting = true;
    detector?.stop();
    alertScheduler?.dispose();
    calendarFeed.stop();
    nub?.dispose();
    void (async () => {
      try {
        if (session?.state === 'recording') await session.stop({ quick: true }); // saída: prazo curto para a fila de transcrição
        await session?.drain();
      } catch (err) {
        logError('stop on quit failed', err);
      }
      await asr.stop().catch(() => {});
      app.quit();
    })();
  });
});

// O Rice continua na barra de menu quando a janela fecha.
app.on('window-all-closed', () => {});
