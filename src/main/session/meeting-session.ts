import { EventEmitter } from 'node:events';
import { appendFile, rename, rm, stat, statfs } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { AudioFrame } from '../../shared/frames';
import { formatClock, toLocalIso } from '../../shared/naming';
import { meetingSessions } from '../../shared/sessions';
import { getLanguage, t, type UiLanguage } from '../i18n';
import type { MeetingMeta, MeetingTrigger, RecordingSession, Segment, TranscriptionLanguage } from '../../shared/types';
import type { AsrPipeline, AsrStatus, PartialSegment } from '../asr/pipeline';
import type { SpeakerIdentifier } from '../asr/speaker-identifier';
import { SpeakerLabels, SpeakerTimeline } from './call-speakers';
import { recoverOrphanAudio } from './audio-recovery';
import { createMeeting, formatSegmentLine, gapMarkerLine, MEETING_FILES, readMeta, updateMeta } from '../store/meeting-files';
import { TranscriptSink, type SinkFs } from '../store/transcript-sink';
import { AlertCenter } from './alerts';
import { SourceWatchdog, type WatchdogEvent } from './source-watchdog';
import type { AudioCapture, AudioEvent } from './audio-capture';
import { concatM4a, encodeM4a, StereoWavWriter, type WavFailure, type WavFs } from './wav-writer';

export type SessionState = 'idle' | 'recording' | 'finishing';

export type SessionDeps = {
  root: () => Promise<string>;
  createCapture: () => AudioCapture;
  /** Antes de abrir a captura (em paralelo com a preparação da pasta): escolhe o microfone (Mac). Quem implementa limita o tempo; falha é ignorada. */
  prepareCapture?: () => Promise<void>;
  createPipeline: (language: TranscriptionLanguage, vocabulary?: string, speakers?: SpeakerIdentifier) => Promise<AsrPipeline>;
  /** Identificador de pessoas do canal do sistema (beta, opcional); `null`/falha = sem identificação. */
  speakers?: (dir: string) => Promise<SpeakerIdentifier | null>;
  /** Initial prompt do whisper com o vocabulário da reunião (do usuário + participantes da agenda); falha vira ''. */
  vocabulary?: (dir: string) => Promise<string>;
  /** Prazos duros do `stop()` (padrões: captura 8 s, etapa 30 s, escritas 15 s); só os testes mudam. */
  captureStopMs?: number;
  stepDeadlineMs?: number;
  writesDeadlineMs?: number;
  encodeDeadlineMs?: number;
  /** Idioma das reuniões sem `meta.language` (padrão `pt`). */
  defaultLanguage?: () => TranscriptionLanguage | Promise<TranscriptionLanguage>;
  /** `resume`: a reunião já tinha gravação; as notas são regeneradas sobre a transcrição inteira. */
  generateNotes: (dir: string, options?: { resume: boolean }) => Promise<void>;
  keepAudio: () => boolean;
  now?: () => Date;
  encode?: typeof encodeM4a;
  /** Junta o áudio anterior com o da retomada (padrão: afconvert). */
  concat?: typeof concatM4a;
  /** Espera antes de reiniciar a captura (padrão 1000 ms). */
  restartDelayMs?: number;
  /** Pasta local de segurança para quando a das reuniões some (padrão: a temporária do sistema). */
  spoolDir?: () => string;
  /** Espaço livre (bytes) do volume de `path`; `null` = não sei. Padrão: `statfs`. */
  freeBytes?: (path: string) => Promise<number | null>;
  /** Intervalo da checagem de espaço durante a gravação (padrão 60 s). */
  diskCheckMs?: number;
  /** Espera entre tentativas de regravar a transcrição / o áudio depois de falha de disco (padrões 5 s e 10 s). */
  sinkRetryMs?: number;
  wavRetryMs?: number;
  /** Só para testes: sistema de arquivos falso do WAV e da transcrição (disco cheio, pasta que some). */
  wavFs?: WavFs;
  sinkFs?: SinkFs;
  /** Estado da permissão do microfone (`granted`, `denied`...); consultado durante a gravação (R-07). */
  micPermission?: () => string;
  /** Intervalo do vigia das fontes (padrão 1 s). */
  watchdogMs?: number;
  /** Sem fala por este tempo: "ainda gravando?" (padrão 15 min; 0 desliga). */
  inactivityMs?: () => number;
  /** Quanto esperar a resposta do "ainda gravando?" antes de parar sozinho (padrão 2 min). */
  inactivityGraceMs?: number;
  /** Gravação esquecida: primeiro lembrete e intervalo entre os próximos (padrões 3 h e 1 h). */
  forgottenAfterMs?: number;
  forgottenEveryMs?: number;
  /** Prazo para esvaziar a fila de transcrição ao parar (padrão 30 s). */
  finishDeadlineMs?: number;
  /** Pausado por este tempo: pergunta se quer parar (padrão 30 min). */
  pauseAlertMs?: number;
};

/** Abaixo disto, avisa antes de gravar (uma reunião longa em AAC precisa de bem menos, mas o WAV temporário é ~230 MB/h). */
export const LOW_DISK_BYTES = 1024 ** 3;

type StartInput = { title: string; trigger: MeetingTrigger; app?: string; calendarEventId?: string; dir?: string };

type Active = {
  dir: string;
  startedAt: Date;
  /** Caminho do WAV temporário desta gravação. */
  wavPath: string;
  /** Idioma falado, valendo para toda esta gravação (começo ou retomada). */
  language: TranscriptionLanguage;
  /** Idioma dos marcadores escritos na transcrição. */
  markerLanguage: UiLanguage;
  /** Retomada de uma reunião já gravada. */
  resume: boolean;
  /** Horário (HH:MM) do marcador de retomada ainda não escrito na transcrição. */
  resumeMark: string | null;
  capture: AudioCapture;
  pipeline: AsrPipeline | null;
  /** Frames recebidos antes do pipeline ficar pronto. */
  pending: AudioFrame[];
  wav: StereoWavWriter;
  /** Transcrição com tolerância a falha de disco (memória + cópia local). */
  sink: TranscriptSink;
  /** Início (ms da reunião) do trecho de áudio não salvo por disco cheio, ainda aberto. */
  audioGapFrom: number | null;
  /** Instante (ms desde o início) em que o Mac começou a dormir; `null` = acordado. */
  suspendedAtMs: number | null;
  /** Instante (ms desde o início) em que o usuário pausou; `null` = gravando. A captura fica parada: nada é gravado nem transcrito. */
  pausedAtMs: number | null;
  /** Relógio de parede do início da pausa (para o aviso de pausa longa) e se o aviso já saiu. */
  pausedAtWall: number;
  pauseAlerted: boolean;
  watchdog: SourceWatchdog;
  /** Última fala transcrita (ms de relógio de parede) e quando o "ainda gravando?" foi mostrado. */
  lastSpeechAt: number;
  idlePromptAt: number | null;
  nextReminderAt: number | null;
  watchTimer: NodeJS.Timeout | null;
  /** Início (ms da reunião) do trecho sem áudio de cada fonte, ainda aberto. */
  sourceGapFrom: Partial<Record<'mic' | 'sys', number>>;
  micRevoked: boolean;
  spaceTimer: NodeJS.Timeout | null;
  offsetMs: number; // somado aos timestamps da captura atual (reinícios)
  lastMs: number;
  lastStatus: AsrStatus['state'];
  /** Reinícios consecutivos sem nenhum frame recebido. */
  restartsWithoutFrames: number;
  hasSegments: boolean;
  /** Algum trecho do sistema (os outros participantes) já foi transcrito. */
  othersSpoke: boolean;
  /** Houve trecho sem transcrição (pipeline falhou ou entrou tarde). */
  incomplete: boolean;
  retrying: boolean;
  closing: boolean;
  /** A transcrição foi encerrada (prazo ou fim da fila): segmentos tardios são descartados. */
  sealed: boolean;
  restartTimer: NodeJS.Timeout | null;
  writes: Promise<void>;
  /** TODAS as capturas (processos helper) criadas nesta gravação: parar mata cada uma, nunca sobra órfão. */
  captures: Set<AudioCapture>;
  /** A captura já foi parada: frames que ainda chegarem são descartados. */
  captureClosed: boolean;
  /** Quem falou na chamada (Discord no Windows) e o número de "Pessoa N" de cada nome; só em memória. */
  callSpeakers: SpeakerTimeline;
  speakerLabels: SpeakerLabels;
};

const MAX_RESTARTS_WITHOUT_FRAMES = 3;
const FINISH_DEADLINE_MS = 30_000;
const QUICK_FINISH_MS = 4000;
/** Prazos duros ao parar: nenhuma etapa trava o `stop()` (a etapa que estoura é abandonada, avisada e a reunião fica marcada como incompleta). */
const CAPTURE_STOP_MS = 8000;
const STEP_DEADLINE_MS = 30_000;
const ENCODE_DEADLINE_MS = 5 * 60_000;
const WRITES_DEADLINE_MS = 15_000;
const DEFAULT_INACTIVITY_MS = 15 * 60_000;
const FORGOTTEN_AFTER_MS = 3 * 3_600_000;
const FORGOTTEN_EVERY_MS = 3_600_000;
/** Repouso menor que isto não vira lacuna (só reconstrói as fontes). */
const MIN_SLEEP_GAP_MS = 2000;
const PAUSE_ALERT_MS = 30 * 60_000;

export class MeetingSession extends EventEmitter {
  state: SessionState = 'idle';
  private active: Active | null = null;
  private starting: Promise<unknown> | null = null;
  private readonly lost = new WeakSet<AudioCapture>();
  /** Finalizações em andamento por pasta (a gravação seguinte não espera por elas). */
  private readonly finalizing = new Map<string, Promise<void>>();
  /** Avisos persistentes da gravação (disco, fontes de áudio...); o main os repassa ao app. */
  readonly alerts = new AlertCenter();

  constructor(private readonly deps: SessionDeps) {
    super();
  }

  /** Para a decisão de fim de reunião (R-33): há quanto tempo grava e se os outros participantes já falaram. */
  get recording(): { recordedMs: number; othersSpoke: boolean } | null {
    const a = this.active;
    return a && this.state === 'recording' ? { recordedMs: this.now().getTime() - a.startedAt.getTime(), othersSpoke: a.othersSpoke } : null;
  }

  /** Gravação pausada pelo usuário (a sessão segue `recording`; nada é gravado nem transcrito). */
  get paused(): boolean {
    return this.active?.pausedAtMs != null && this.state === 'recording';
  }

  get currentDir(): string | null {
    return this.active?.dir ?? null;
  }

  private setState(state: SessionState): void {
    this.state = state;
    this.emit('state', state);
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private warn(message: string): void {
    this.emit('session-warning', { message });
  }

  /** Encadeia escritas em arquivo; a cadeia nunca rejeita. */
  private enqueue(active: Active, fn: () => Promise<void>): void {
    active.writes = active.writes.then(fn).catch((err: Error) => this.warn(err.message));
  }

  /** "Tentar de novo" da UI: retoma a fila do pipeline ativo. */
  retryAsr(): void {
    const active = this.active;
    if (!active || active.closing) return;
    if (active.pipeline) {
      active.pipeline.retry();
    } else if (active.lastStatus === 'failed' && !active.retrying) {
      // o pipeline nunca subiu: tenta criar de novo; o áudio anterior fica só no WAV
      active.retrying = true;
      active.lastStatus = 'idle';
      this.startPipeline(active);
    }
  }

  async start(input: StartInput): Promise<string> {
    if (this.state !== 'idle') throw new Error(t('err.already-recording'));
    this.setState('recording');
    const starting = this.begin(input);
    this.starting = starting;
    try {
      return await starting;
    } catch (err) {
      this.active = null;
      this.setState('idle');
      throw err;
    } finally {
      this.starting = null;
    }
  }

  private async begin(input: StartInput): Promise<string> {
    // retomar uma reunião que ainda está finalizando: espera só essa (as outras não bloqueiam nada)
    if (input.dir) await this.finalizing.get(input.dir)?.catch(() => {});
    const prepared = this.deps.prepareCapture?.().catch(() => {});
    const startedAt = this.now();
    const adopted = await this.adoptMeeting(input.dir, startedAt);
    let wav: StereoWavWriter | null = null;
    let wavPath: string | null = null;
    try {
      const dir = adopted?.dir ?? (await createMeeting(await this.deps.root(), { ...input, startedAt })).dir;
      const resume = adopted?.resume ?? false;
      wavPath = join(dir, await freeName(dir, 'audio', '.wav'));
      wav = await StereoWavWriter.open(wavPath, {
        fallbackPath: join(this.spoolRoot(), basename(dir), 'audio.wav'),
        retryMs: this.deps.wavRetryMs,
        ...(this.deps.wavFs ? { fs: this.deps.wavFs } : {}),
        onFailure: (failure) => this.onAudioFailure(failure),
        onRecovered: () => this.onAudioRecovered(),
      });
      const language = (await readMeta(dir)).language ?? (await this.deps.defaultLanguage?.()) ?? 'pt';
      await this.checkFreeSpace(dir);
      await prepared; // o microfone já está escolhido (a captura herda a escolha ao abrir)
      return this.launch(dir, startedAt, wavPath, resume, wav, language);
    } catch (err) {
      // não deixa a reunião adotada presa em `recording` com uma sessão aberta
      await wav?.close().catch(() => {});
      if (wavPath) await rm(wavPath, { force: true }).catch(() => {});
      if (adopted) await this.rollbackAdopted(adopted).catch(() => {});
      throw err;
    }
  }

  private launch(dir: string, startedAt: Date, wavPath: string, resume: boolean, wav: StereoWavWriter, language: TranscriptionLanguage): string {
    const active: Active = {
      dir, startedAt, wavPath, language, markerLanguage: markerLanguage(language), resume, resumeMark: resume ? formatClock(startedAt).slice(0, 5) : null, capture: null as never, pipeline: null, pending: [], wav,
      sink: new TranscriptSink({
        path: join(dir, MEETING_FILES.transcript),
        spoolPath: join(this.spoolRoot(), basename(dir), MEETING_FILES.transcript),
        retryMs: this.deps.sinkRetryMs,
        ...(this.deps.sinkFs ? { fs: this.deps.sinkFs } : {}),
        onFailure: (kind) => this.onTranscriptFailure(kind),
        onRecovered: () => this.alerts.clear('storage:transcript'),
      }),
      audioGapFrom: null, suspendedAtMs: null, pausedAtMs: null, pausedAtWall: 0, pauseAlerted: false, watchdog: new SourceWatchdog(), lastSpeechAt: startedAt.getTime(), idlePromptAt: null, nextReminderAt: null, watchTimer: null, sourceGapFrom: {}, micRevoked: false, spaceTimer: null,
      offsetMs: 0, lastMs: 0, lastStatus: 'idle', restartsWithoutFrames: 0,
      hasSegments: false, othersSpoke: false, incomplete: false, retrying: false, closing: false, sealed: false, restartTimer: null, writes: Promise.resolve(), captures: new Set(), captureClosed: false, callSpeakers: new SpeakerTimeline(), speakerLabels: new SpeakerLabels(),
    };
    this.active = active;
    this.emit('active', dir); // o 'recording' saiu antes de a reunião existir: quem leu o currentDir lá viu null
    active.spaceTimer = setInterval(() => void this.checkFreeSpace(dir), this.deps.diskCheckMs ?? 60_000);
    active.spaceTimer.unref?.();
    let ticks = 0;
    active.watchTimer = setInterval(() => {
      this.watchTick(active);
      if (++ticks % 5 === 0) this.checkMicPermission(active);
    }, this.deps.watchdogMs ?? 1000);
    active.watchTimer.unref?.();
    this.attachCapture(active);
    // o áudio já está sendo gravado; o pipeline entra quando o modelo estiver pronto
    this.startPipeline(active);
    return dir;
  }

  private spoolRoot(): string {
    return this.deps.spoolDir?.() ?? join(tmpdir(), 'rice-spool');
  }

  /** Pouco espaço livre: aviso antes de gravar e enquanto grava (some quando o espaço volta). Nunca impede a gravação. */
  private async checkFreeSpace(dir: string): Promise<void> {
    const free = await (this.deps.freeBytes ?? defaultFreeBytes)(dir).catch(() => null);
    if (free === null) return;
    if (free < LOW_DISK_BYTES) {
      this.alerts.set({ id: 'storage:low', level: 'warn', message: t('alert.disk-low', { free: formatBytes(free) }), action: { kind: 'open-storage', label: t('alert.action.storage') } });
    } else {
      this.alerts.clear('storage:low');
    }
  }

  private onAudioFailure(failure: WavFailure): void {
    const active = this.active;
    const open = { kind: 'open-storage' as const, label: t('alert.action.storage') };
    if (failure.kind === 'full') {
      if (active) active.audioGapFrom ??= active.lastMs;
      this.alerts.set({ id: 'storage:audio', level: 'error', message: t('alert.disk-full'), action: open });
    } else if (failure.kind === 'unavailable') {
      this.alerts.set({ id: 'storage:audio', level: 'error', message: t(failure.fallback ? 'alert.folder-gone' : 'alert.folder-recreated') });
    } else {
      if (active) active.audioGapFrom ??= active.lastMs;
      this.alerts.set({ id: 'storage:audio', level: 'error', message: t('alert.audio-lost'), action: open });
    }
  }

  private onAudioRecovered(): void {
    const active = this.active;
    this.alerts.clear('storage:audio');
    if (active) this.closeAudioGap(active);
  }

  private onTranscriptFailure(kind: 'full' | 'unavailable' | 'other'): void {
    this.alerts.set({
      id: 'storage:transcript',
      level: 'error',
      message: t(kind === 'full' ? 'alert.transcript-full' : 'alert.transcript-unavailable'),
      ...(kind === 'full' ? { action: { kind: 'open-storage' as const, label: t('alert.action.storage') } } : {}),
    });
  }

  /** Registra (meta e transcrição) o trecho cujo áudio não foi salvo por falta de espaço. */
  private closeAudioGap(active: Active): void {
    const fromMs = active.audioGapFrom;
    if (fromMs === null) return;
    active.audioGapFrom = null;
    const toMs = Math.max(active.lastMs, fromMs);
    this.enqueue(active, async () => {
      await this.writeResumeMark(active);
      await updateMeta(active.dir, (meta) => ({ ...meta, gaps: [...meta.gaps, { fromMs, toMs, reason: 'disk-full' }] }));
      await active.sink.append(gapMarkerLine(active.startedAt, fromMs, toMs, active.markerLanguage));
    });
  }

  private async rollbackAdopted(adopted: Adopted): Promise<void> {
    const { previous } = adopted;
    await updateMeta(adopted.dir, ({ sessions: _open, ...m }) => ({
      ...m,
      state: previous.state,
      startedAt: previous.startedAt,
      ...(previous.sessions ? { sessions: previous.sessions } : {}),
    }));
  }

  /**
   * Grava numa reunião existente (rascunho, concluída ou interrompida) em vez de criar outra pasta.
   * O `startedAt` original é mantido (exceto no rascunho); cada gravação vira uma entrada em `sessions`.
   */
  private async adoptMeeting(dir: string | undefined, startedAt: Date): Promise<Adopted | null> {
    if (!dir) return null;
    const meta = await readMeta(dir).catch(() => null);
    if (!meta) return null;
    if (meta.state === 'recording' || meta.state === 'finishing') throw new Error(t('err.meeting-recording'));
    // retomar uma reunião interrompida: o áudio órfão da queda vira m4a antes, para a retomada juntar certo
    if (meta.state === 'interrupted') await recoverOrphanAudio(dir, { keepAudio: this.deps.keepAudio() }).catch(() => {});
    const now = toLocalIso(startedAt);
    if (meta.state === 'draft') {
      await updateMeta(dir, (m) => ({ ...m, state: 'recording', startedAt: now, sessions: [{ startedAt: now }] }));
      return { dir, resume: false, previous: meta };
    }
    await updateMeta(dir, (m) => ({ ...m, state: 'recording', sessions: [...meetingSessions(m), { startedAt: now }] }));
    return { dir, resume: true, previous: meta };
  }

  /** Escreve (uma vez) o marcador de retomada antes do primeiro conteúdo novo da transcrição. */
  private async writeResumeMark(active: Active): Promise<void> {
    const mark = active.resumeMark;
    if (!mark) return;
    active.resumeMark = null;
    await active.sink.append(`${t('marker.resumed', { time: mark }, active.markerLanguage)}\n\n`);
  }

  private startPipeline(active: Active): void {
    const { vocabulary, speakers } = this.deps;
    const created = vocabulary || speakers
      ? Promise.all([vocabulary ? vocabulary(active.dir).catch(() => '') : '', speakers ? speakers(active.dir).catch(() => null) : null]).then(([terms, who]) => this.deps.createPipeline(active.language, terms, who ?? undefined))
      : this.deps.createPipeline(active.language);
    void created.then(
      (pipeline) => {
        active.retrying = false;
        this.attachPipeline(active, pipeline);
      },
      (err: Error) => {
        active.retrying = false;
        active.lastStatus = 'failed';
        active.incomplete = true;
        active.pending = [];
        if (!active.closing) this.emit('asr-status', { state: 'failed', queueSeconds: 0, error: err.message } satisfies AsrStatus);
      },
    );
  }

  private attachPipeline(active: Active, pipeline: AsrPipeline): void {
    if (active.closing) {
      // a gravação acabou antes do modelo carregar: devolve o pipeline para o servidor poder descer
      void pipeline.finish().catch(() => {});
      return;
    }
    pipeline.on('segment', (raw: Segment) => {
      if (active.sealed) return;
      active.hasSegments = true;
      if (raw.source === 'Outros') active.othersSpoke = true;
      this.noteSpeech(active);
      const { segment, named } = this.nameFromCall(active, raw);
      this.enqueue(active, async () => {
        // nome dado pelo usuário vale mais; falha no meta não pode custar a linha da transcrição
        if (named) await updateMeta(active.dir, (m) => (m.speakers?.[String(named.speaker)] ? m : { ...m, speakers: { ...m.speakers, [String(named.speaker)]: named.name } })).catch(() => {});
        await this.writeResumeMark(active);
        await active.sink.append(formatSegmentLine(active.startedAt, segment));
      });
      this.emit('segment', { dir: active.dir, segment });
    });
    pipeline.on('partial', (partial: PartialSegment) => this.emit('partial', { dir: active.dir, partial }));
    pipeline.on('status', (status: AsrStatus) => {
      active.lastStatus = status.state;
      this.emit('asr-status', status);
    });
    pipeline.on('warning', (warning) => this.emit('asr-warning', warning));
    active.pipeline = pipeline;
    const pending = active.pending;
    active.pending = [];
    for (const frame of pending) this.push(active, frame);
  }

  /** Trecho de "Outros" que coincide com alguém falando na chamada vira a "Pessoa N" desse nome; `named` = nome novo para o meta. */
  private nameFromCall(active: Active, segment: Segment): { segment: Segment; named?: { speaker: number; name: string } } {
    if (segment.source !== 'Outros') return { segment };
    const name = active.callSpeakers.whoSpoke(segment.startMs, segment.endMs);
    const { speaker, fresh } = active.speakerLabels.label(name, segment.speaker);
    if (!name || speaker === undefined) return { segment };
    return { segment: { ...segment, speaker, speakerName: name }, ...(fresh ? { named: { speaker, name } } : {}) };
  }

  /** O detector viu `name` começar/parar de falar na chamada (Discord no Windows). */
  markSpeaker(name: string, speaking: boolean): void {
    const active = this.active;
    if (active) active.callSpeakers.mark(name, speaking, this.now().getTime() - active.startedAt.getTime());
  }

  private push(active: Active, frame: AudioFrame): void {
    try {
      active.pipeline?.pushFrame(frame);
    } catch (err) {
      this.warn((err as Error).message);
    }
  }

  /** Troca o microfone no meio da gravação (Mac): `uid` vazio = entrada padrão do macOS. */
  switchMic(uid?: string): void {
    this.active?.capture.setMicDevice(uid);
  }

  private attachCapture(active: Active): void {
    const capture = this.deps.createCapture();
    active.capture = capture;
    active.captures.add(capture);
    const offset = active.offsetMs;
    active.watchdog.captureStarted(this.now().getTime());
    capture.on('frame', (frame: AudioFrame) => {
      if (active.captureClosed || active.sealed) return; // a gravação já parou: nada entra depois (nem de um helper que escapou)
      if (active.pausedAtMs !== null) return; // pausado: nada é gravado nem transcrito (nem um quadro atrasado da captura que acabou de parar)
      active.restartsWithoutFrames = 0;
      this.watchEvents(active, active.watchdog.onFrame(frame.source, frame.pcm, this.now().getTime()));
      this.emit('frame', frame);
      const shifted = { ...frame, timestampMs: frame.timestampMs + offset };
      active.lastMs = Math.max(active.lastMs, shifted.timestampMs + frame.pcm.length / 32);
      try {
        active.wav.write(shifted);
      } catch (err) {
        this.warn((err as Error).message);
      }
      if (active.pipeline) this.push(active, shifted);
      else if (active.lastStatus !== 'failed') active.pending.push(shifted);
    });
    capture.on('event', (event: AudioEvent) => {
      this.emit('capture-event', event);
      // Aditivo: só o helper do Windows emite `mic-device`; o do Mac nunca, então nada muda por lá. Não mexe na captura.
      if (event.event === 'mic-device' && typeof event.name === 'string') this.emit('mic', { id: typeof event.id === 'string' ? event.id : undefined, name: event.name, isDefault: event.isDefault === true, chosen: event.chosen === true });
      if (event.fatal === true && active.capture === capture && !active.closing) {
        // fonte perdida com o processo ainda vivo: tratar como queda
        void capture.stop().catch(() => {});
        this.captureLost(active, capture);
      }
    });
    capture.on('exit', ({ expected }: { expected: boolean }) => {
      if (expected || active.capture !== capture) return;
      this.captureLost(active, capture);
    });
    capture.start();
  }

  private captureLost(active: Active, capture: AudioCapture): void {
    if (this.lost.has(capture) || this.active !== active || this.state !== 'recording' || active.closing) return;
    this.lost.add(capture);
    if (active.restartsWithoutFrames >= MAX_RESTARTS_WITHOUT_FRAMES) {
      this.emit('capture-event', { event: 'error', fatal: true, source: 'session', message: t('err.capture-no-restart') });
      return;
    }
    if (active.restartsWithoutFrames === 0) {
      const fromMs = active.lastMs;
      const toMs = Math.max(this.now().getTime() - active.startedAt.getTime(), fromMs);
      this.enqueue(active, async () => {
        await this.writeResumeMark(active);
        await updateMeta(active.dir, (meta) => ({ ...meta, gaps: [...meta.gaps, { fromMs, toMs, reason: 'audio-restart' }] }));
        await active.sink.append(gapMarkerLine(active.startedAt, fromMs, toMs, active.markerLanguage));
      });
    }
    active.restartTimer = setTimeout(() => {
      active.restartTimer = null;
      if (active.closing || this.active !== active) return;
      active.restartsWithoutFrames++;
      active.offsetMs = Math.max(this.now().getTime() - active.startedAt.getTime(), active.lastMs);
      try {
        this.attachCapture(active);
      } catch (err) {
        this.warn((err as Error).message);
      }
    }, this.deps.restartDelayMs ?? 1000);
  }

  /**
   * R-19: o Mac vai dormir. Guarda o instante pelo relógio de parede (o da captura não anda durante o repouso); quando o
   * sistema acordar, `resume()` marca a lacuna com o horário real e reconstrói as fontes de áudio.
   */
  suspend(): void {
    const active = this.active;
    if (!active || this.state !== 'recording' || active.closing || active.suspendedAtMs !== null || active.pausedAtMs !== null) return; // pausado: a captura já está parada
    active.suspendedAtMs = Math.max(this.now().getTime() - active.startedAt.getTime(), active.lastMs);
    if (active.restartTimer) clearTimeout(active.restartTimer);
    active.restartTimer = null;
    // a captura antiga para agora: o tap do sistema morre no repouso e não pode escrever com a linha do tempo velha
    const old = active.capture;
    this.lost.add(old);
    void old.stop().catch(() => {});
  }

  resume(): void {
    const active = this.active;
    if (!active || this.state !== 'recording' || active.closing || active.suspendedAtMs === null) return;
    const fromMs = active.suspendedAtMs;
    active.suspendedAtMs = null;
    const toMs = Math.max(this.now().getTime() - active.startedAt.getTime(), fromMs);
    if (toMs - fromMs >= MIN_SLEEP_GAP_MS) {
      this.enqueue(active, async () => {
        await this.writeResumeMark(active);
        await updateMeta(active.dir, (meta) => ({ ...meta, gaps: [...meta.gaps, { fromMs, toMs, reason: 'sleep' }] }));
        await active.sink.append(gapMarkerLine(active.startedAt, fromMs, toMs, active.markerLanguage, 'marker.sleep'));
      });
      const clock = (ms: number) => formatClock(new Date(active.startedAt.getTime() + ms)).slice(0, 5);
      this.alerts.set({ id: 'sleep', level: 'info', message: t('alert.slept', { from: clock(fromMs), to: clock(toMs) }), dismissible: true });
      const timer = setTimeout(() => this.alerts.clear('sleep'), 30_000);
      timer.unref?.();
    }
    active.restartsWithoutFrames = 0;
    active.offsetMs = toMs; // a linha do tempo volta a seguir o relógio de parede
    try {
      this.attachCapture(active);
    } catch (err) {
      this.warn((err as Error).message);
    }
  }

  private watchTick(active: Active): void {
    if (active.closing || this.active !== active || active.suspendedAtMs !== null) return;
    const now = this.now().getTime();
    if (active.pausedAtMs !== null) return this.pauseTick(active, now); // pausado: sem vigia das fontes, sem inatividade, sem parada automática
    this.watchEvents(active, active.watchdog.tick(now));
    this.policyTick(active, now);
  }

  /** Depois de ~30 min pausado, pergunta se quer parar (nunca para sozinho). */
  private pauseTick(active: Active, now: number): void {
    if (active.pauseAlerted || now - active.pausedAtWall < (this.deps.pauseAlertMs ?? PAUSE_ALERT_MS)) return;
    active.pauseAlerted = true;
    const message = t('alert.paused-long', { minutes: Math.round((now - active.pausedAtWall) / 60_000) });
    this.alerts.set({ id: 'paused-long', level: 'warn', message, action: { kind: 'stop-recording', label: t('alert.action.stop') }, secondary: { kind: 'unpause-recording', label: t('rec.resume') } });
    this.emit('attention', { kind: 'paused', message });
  }

  /**
   * Pausa (sem parar): a captura é encerrada, então o microfone é liberado e nenhum quadro chega. A linha do tempo segue o
   * relógio de parede (como no repouso do Mac): os offsets e horários depois da pausa continuam certos e o trecho fica
   * registrado como lacuna `paused`. A fala em andamento é fechada na hora.
   */
  pause(): void {
    const active = this.active;
    if (!active || this.state !== 'recording' || active.closing || active.suspendedAtMs !== null || active.pausedAtMs !== null) return;
    const now = this.now().getTime();
    active.pausedAtMs = Math.max(now - active.startedAt.getTime(), active.lastMs);
    active.pausedAtWall = now;
    active.pauseAlerted = false;
    if (active.restartTimer) clearTimeout(active.restartTimer);
    active.restartTimer = null;
    const old = active.capture;
    this.lost.add(old);
    void old.stop().catch(() => {});
    void active.pipeline?.flush?.().catch(() => {});
    for (const source of ['mic', 'sys'] as const) {
      delete active.sourceGapFrom[source]; // a pausa não é falha de fonte
      this.alerts.clear(`source:${source}`);
    }
    this.emit('pause', { dir: active.dir, paused: true });
  }

  /** Continua depois de uma pausa: marcador "pausado 14:03–14:07" na transcrição e a captura volta. */
  unpause(): void {
    const active = this.active;
    if (!active || this.state !== 'recording' || active.closing || active.pausedAtMs === null) return;
    this.closePause(active);
    active.restartsWithoutFrames = 0;
    active.lastSpeechAt = this.now().getTime(); // o silêncio da pausa não conta como inatividade
    active.idlePromptAt = null;
    this.alerts.clear('idle');
    active.offsetMs = Math.max(this.now().getTime() - active.startedAt.getTime(), active.lastMs);
    try {
      this.attachCapture(active);
    } catch (err) {
      this.warn((err as Error).message);
    }
  }

  /** Fecha o registro da pausa (marcador, lacuna no meta e avisos); a captura é com quem chama. */
  private closePause(active: Active): void {
    const fromMs = active.pausedAtMs;
    if (fromMs === null) return;
    active.pausedAtMs = null;
    active.pauseAlerted = false;
    this.alerts.clear('paused-long');
    const toMs = Math.max(this.now().getTime() - active.startedAt.getTime(), fromMs);
    this.enqueue(active, async () => {
      await this.writeResumeMark(active);
      await updateMeta(active.dir, (meta) => ({ ...meta, gaps: [...meta.gaps, { fromMs, toMs, reason: 'paused' }] }));
      await active.sink.append(gapMarkerLine(active.startedAt, fromMs, toMs, active.markerLanguage, 'marker.paused'));
    });
    this.emit('pause', { dir: active.dir, paused: false, line: gapMarkerLine(active.startedAt, fromMs, toMs, active.markerLanguage, 'marker.paused').trim() }); // `line`: o marcador, para a transcrição ao vivo
  }

  private noteSpeech(active: Active): void {
    active.lastSpeechAt = this.now().getTime();
    if (active.idlePromptAt !== null) {
      active.idlePromptAt = null;
      this.alerts.clear('idle');
    }
  }

  /** "Manter gravando" nos avisos de inatividade e de gravação esquecida. */
  keepRecording(): void {
    const active = this.active;
    if (!active) return;
    active.lastSpeechAt = this.now().getTime();
    active.idlePromptAt = null;
    this.alerts.clear('idle');
    this.alerts.clear('long');
  }

  /** R-34/R-35: nada para sozinho sem aviso prévio e opção de continuar; gravação esquecida só gera lembretes. */
  private policyTick(active: Active, now: number): void {
    const stopNow = { kind: 'stop-recording' as const, label: t('alert.action.stop') };
    const keep = { kind: 'keep-recording' as const, label: t('alert.action.keep') };
    const limit = this.deps.inactivityMs ? this.deps.inactivityMs() : DEFAULT_INACTIVITY_MS;
    if (limit > 0) {
      if (active.idlePromptAt === null && now - active.lastSpeechAt >= limit) {
        active.idlePromptAt = now;
        const message = t('alert.idle', { minutes: Math.round((now - active.lastSpeechAt) / 60_000) });
        this.alerts.set({ id: 'idle', level: 'warn', message, action: keep, secondary: stopNow });
        this.emit('attention', { kind: 'idle', message });
      } else if (active.idlePromptAt !== null && now - active.idlePromptAt >= (this.deps.inactivityGraceMs ?? 2 * 60_000)) {
        const dir = active.dir;
        this.alerts.clear('idle');
        this.alerts.set({ id: 'auto-stopped', level: 'info', message: t('alert.auto-stopped'), action: { kind: 'resume-recording', label: t('alert.action.resume') }, dismissible: true, dir });
        const timer = setTimeout(() => this.alerts.clear('auto-stopped'), 30_000);
        timer.unref?.();
        this.emit('attention', { kind: 'auto-stopped', message: t('alert.auto-stopped') });
        void this.stop();
        return;
      }
    }
    const first = this.deps.forgottenAfterMs ?? FORGOTTEN_AFTER_MS;
    const recorded = now - active.startedAt.getTime();
    if (recorded >= first && (active.nextReminderAt === null || now >= active.nextReminderAt)) {
      active.nextReminderAt = now + (this.deps.forgottenEveryMs ?? FORGOTTEN_EVERY_MS);
      const message = t('alert.long', { duration: formatDuration(recorded) });
      this.alerts.set({ id: 'long', level: 'info', message, action: keep, secondary: stopNow });
      this.emit('attention', { kind: 'long', message });
    }
  }

  /** R-10/R-07: traduz os eventos do vigia em avisos, lacunas e reinícios (nunca em laço infinito: o vigia tem tetos). */
  private watchEvents(active: Active, events: WatchdogEvent[]): void {
    for (const e of events) {
      const name = t(e.source === 'mic' ? 'alert.source.mic' : 'alert.source.sys');
      const id = `source:${e.source}`;
      const privacy = { kind: e.source === 'mic' ? ('open-mic-privacy' as const) : ('open-audio-privacy' as const), label: t('alert.action.privacy') };
      if (e.type === 'stalled') {
        active.sourceGapFrom[e.source] ??= Math.max(0, e.since - active.startedAt.getTime());
        this.alerts.set({ id, level: 'warn', message: t('alert.source-stalled', { name }) });
      } else if (e.type === 'silent') {
        this.alerts.set({ id, level: 'info', message: t('alert.source-silent', { name }), dismissible: true });
      } else if (e.type === 'restart') {
        this.forceRestart(active);
      } else if (e.type === 'failed') {
        // queda de blocos: erro persistente com atalho; só silêncio do microfone: aviso discreto (pode ser escolha do usuário)
        if (e.reason === 'stalled') this.alerts.set({ id, level: 'error', message: t('alert.source-lost', { name }), action: privacy });
        else this.alerts.set({ id, level: 'info', message: t('alert.source-silent-lost', { name }), dismissible: true });
      } else if (e.type === 'recovered') {
        this.alerts.clear(id);
        this.closeSourceGap(active, e.source);
      }
    }
  }

  /** Registra (meta e transcrição) o trecho sem áudio de uma fonte, quando ele fecha. */
  private closeSourceGap(active: Active, source: 'mic' | 'sys'): void {
    const fromMs = active.sourceGapFrom[source];
    delete active.sourceGapFrom[source];
    if (fromMs === undefined) return;
    const toMs = Math.max(this.now().getTime() - active.startedAt.getTime(), fromMs);
    if (toMs - fromMs < MIN_SLEEP_GAP_MS) return;
    this.enqueue(active, async () => {
      await this.writeResumeMark(active);
      await updateMeta(active.dir, (meta) => ({ ...meta, gaps: [...meta.gaps, { fromMs, toMs, reason: `source-${source}` }] }));
      await active.sink.append(gapMarkerLine(active.startedAt, fromMs, toMs, active.markerLanguage));
    });
  }

  /** Reinicia a captura inteira (as duas fontes) pela via do vigia; a linha do tempo segue o relógio de parede. */
  private forceRestart(active: Active): void {
    if (active.closing || active.restartTimer || active.pausedAtMs !== null) return;
    const old = active.capture;
    this.lost.add(old);
    void old.stop().catch(() => {});
    active.restartTimer = setTimeout(() => {
      active.restartTimer = null;
      if (active.closing || this.active !== active) return;
      active.offsetMs = Math.max(this.now().getTime() - active.startedAt.getTime(), active.lastMs);
      try {
        this.attachCapture(active);
      } catch (err) {
        this.warn((err as Error).message);
      }
    }, this.deps.restartDelayMs ?? 1000);
  }

  /** R-07: permissão do microfone revogada durante a gravação: aviso com atalho, sem laço de reinícios; quando volta, retoma. */
  private checkMicPermission(active: Active): void {
    const status = this.deps.micPermission?.();
    if (!status || active.closing || this.active !== active || active.pausedAtMs !== null) return;
    const revoked = status === 'denied' || status === 'restricted';
    if (revoked && !active.micRevoked) {
      active.micRevoked = true;
      active.watchdog.setExpected('mic', false);
      active.sourceGapFrom.mic ??= Math.max(0, this.now().getTime() - active.startedAt.getTime());
      this.alerts.set({ id: 'source:mic', level: 'error', message: t('alert.mic-revoked'), action: { kind: 'open-mic-privacy', label: t('alert.action.privacy') } });
    } else if (!revoked && active.micRevoked) {
      active.micRevoked = false;
      active.watchdog.setExpected('mic', true);
      this.alerts.clear('source:mic');
      this.closeSourceGap(active, 'mic');
      this.forceRestart(active);
    }
  }

  /** Espera `promise` no máximo `WRITES_DEADLINE_MS`; estourou: avisa, marca como incompleta e segue (devolve undefined). */
  private async bounded<T>(active: Active, promise: Promise<T>, ms = this.deps.writesDeadlineMs ?? WRITES_DEADLINE_MS): Promise<T | undefined> {
    let timer: NodeJS.Timeout | undefined;
    const cut = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), ms);
      timer.unref?.();
    });
    try {
      const out = await Promise.race([promise, cut]);
      if (out === 'timeout') {
        active.incomplete = true;
        this.warn(t('warn.step-timeout'));
        return undefined;
      }
      return out;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Última tentativa de gravar a transcrição; se a pasta continua indisponível, diz onde ficou a cópia. */
  private async closeTranscript(active: Active): Promise<void> {
    const result = await this.bounded(active, active.sink.close());
    if (!result) return; // estourou o prazo: segue sem travar o fim da reunião
    if (result.complete) {
      this.alerts.clear('storage:transcript');
    } else if (result.spoolPath) {
      this.alerts.set({ id: 'storage:transcript', level: 'error', message: t('alert.spool-transcript', { path: result.spoolPath }), dismissible: true });
    }
  }

  /** Fecha o WAV, codifica para m4a e, numa retomada, junta com o áudio anterior (sem nunca perder nenhum). */
  private async finishAudio(active: Active, step: (fn: () => Promise<unknown> | unknown, ms?: number) => Promise<boolean>): Promise<void> {
    const { dir } = active;
    const keep = this.deps.keepAudio();
    const encode = this.deps.encode ?? encodeM4a;
    const m4aPath = join(dir, MEETING_FILES.audio);
    let closed: { durationMs: number; path?: string } | undefined;
    const wavClosed = await step(async () => {
      closed = await active.wav.close();
    });
    // se a pasta da reunião sumiu no meio, o áudio ficou no local alternativo: é de lá que se codifica
    const wavPath = closed?.path ?? active.wavPath;
    const hadAudio = active.resume && (await exists(m4aPath));
    if (active.resume && !keep) {
      await step(() => rm(wavPath, { force: true })); // o áudio anterior fica como está
      return;
    }
    if (!hadAudio) {
      const encoded = wavClosed && (await step(() => encode(wavPath, m4aPath), this.deps.encodeDeadlineMs ?? ENCODE_DEADLINE_MS));
      if (encoded) {
        await step(() => rm(wavPath, { force: true }));
        if (!keep) await step(() => rm(m4aPath, { force: true }));
      } else if (wavPath !== active.wavPath) {
        // não deu para codificar na pasta da reunião: o WAV fica no local seguro e o usuário é avisado onde
        this.alerts.set({ id: 'storage:spool', level: 'error', message: t('alert.spool-audio', { path: wavPath }), dismissible: true });
      } else if (!keep) {
        await step(() => rm(wavPath, { force: true }));
      }
      return;
    }
    const part = join(dir, '.audio-retomada.m4a');
    if (!wavClosed || !(await step(() => encode(wavPath, part), this.deps.encodeDeadlineMs ?? ENCODE_DEADLINE_MS))) return; // o WAV fica na pasta
    await step(() => rm(wavPath, { force: true }));
    const merged = join(dir, '.audio-junto.m4a');
    const concat = this.deps.concat ?? concatM4a;
    if ((await step(() => concat(m4aPath, part, merged), this.deps.encodeDeadlineMs ?? ENCODE_DEADLINE_MS)) && (await step(() => rename(merged, m4aPath)))) {
      await step(() => rm(part, { force: true }));
      return;
    }
    // não juntou (ou não substituiu): a parte nova é a única cópia, então só muda de nome
    await step(() => rm(merged, { recursive: true, force: true }));
    const name = await freeName(dir, 'audio', '.m4a', 2);
    await step(() => rename(part, join(dir, name)));
    this.warn(t('warn.audio-merge-failed', { name }, active.markerLanguage));
  }

  /**
   * Para a gravação. A captura para na hora e a sessão volta a `idle` (R-37: a próxima reunião pode começar sem esperar);
   * esvaziar a fila de transcrição, codificar o áudio e gerar as notas seguem em segundo plano, mas `stop()` só resolve
   * quando isso termina. `quick` (saída do app) usa um prazo curto para a fila (R-45).
   */
  async stop(options: { quick?: boolean } = {}): Promise<void> {
    if (!this.active && this.starting) await this.starting.catch(() => {});
    const active = this.active;
    if (!active || this.state !== 'recording') return;
    const endedAt = toLocalIso(this.now());
    this.setState('finishing');
    active.closing = true;
    this.closePause(active); // parou pausado: a pausa vai até o fim e fica registrada
    if (active.restartTimer) clearTimeout(active.restartTimer);
    if (active.spaceTimer) clearInterval(active.spaceTimer);
    if (active.watchTimer) clearInterval(active.watchTimer);
    const step = async (fn: () => Promise<unknown> | unknown, ms?: number): Promise<boolean> => {
      let timer: NodeJS.Timeout | undefined;
      try {
        const limit = ms ?? this.deps.stepDeadlineMs ?? STEP_DEADLINE_MS;
        await Promise.race([
          Promise.resolve().then(fn),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new StepTimeout()), limit);
            timer.unref?.();
          }),
        ]);
        return true;
      } catch (err) {
        if (err instanceof StepTimeout) {
          active.incomplete = true;
          this.warn(t('warn.step-timeout'));
        } else this.warn((err as Error).message);
        return false;
      } finally {
        clearTimeout(timer);
      }
    };
    const captureMs = this.deps.captureStopMs ?? CAPTURE_STOP_MS;
    await step(() => active.capture.stop(), captureMs);
    // qualquer outra captura desta gravação (reiniciada, retomada ou que escapou): para e, se preciso, é morta; nunca sobra helper vivo
    await step(() => Promise.all([...active.captures].filter((c) => c !== active.capture).map((c) => c.stop(1500).catch(() => {}))), captureMs);
    for (const c of active.captures) c.kill?.();
    active.captureClosed = true;
    await step(() => updateMeta(active.dir, (meta) => ({ ...meta, state: 'finishing' })));
    // a captura parou: daqui para a frente nada mais depende da gravação ativa
    this.active = null;
    for (const id of ['storage:low', 'storage:audio', 'idle', 'long', 'paused-long']) this.alerts.clear(id);
    this.alerts.clearPrefix('source:');
    const dir = active.dir;
    const fin: Promise<void> = this.finalize(active, step, endedAt, options).finally(() => {
      if (this.finalizing.get(dir) === fin) this.finalizing.delete(dir);
    });
    this.finalizing.set(dir, fin);
    this.setState('idle');
    await fin;
  }

  /** Espera todas as finalizações em andamento (saída do app). */
  async drain(): Promise<void> {
    await Promise.allSettled([...this.finalizing.values()]);
  }

  private async finalize(active: Active, step: (fn: () => Promise<unknown> | unknown, ms?: number) => Promise<boolean>, endedAt: string, options: { quick?: boolean }): Promise<void> {
    // R-45: a fila de transcrição tem prazo; passado ele o trecho final é marcado como incompleto e a reunião fecha
    const deadlineMs = options.quick ? QUICK_FINISH_MS : (this.deps.finishDeadlineMs ?? FINISH_DEADLINE_MS);
    if (active.pipeline) {
      const finishing = step(() => active.pipeline?.finish());
      let timer: NodeJS.Timeout | undefined;
      const cut = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), deadlineMs);
      });
      const outcome = await Promise.race([finishing, cut]);
      if (timer) clearTimeout(timer);
      if (outcome === 'timeout') {
        active.incomplete = true;
        this.warn(t('warn.transcription-cut'));
      }
    }
    active.sealed = true; // segmentos que ainda chegarem depois do prazo são descartados
    await this.bounded(active, active.writes);
    this.closeAudioGap(active);
    for (const source of ['mic', 'sys'] as const) this.closeSourceGap(active, source);
    await this.bounded(active, active.writes);
    if (!active.pipeline || active.lastStatus === 'failed' || active.incomplete) {
      await step(async () => {
        await this.writeResumeMark(active);
        await active.sink.append(`${t('marker.incomplete', undefined, active.markerLanguage)}\n\n`);
      });
    }
    await this.finishAudio(active, step);
    await this.closeTranscript(active);
    await step(async () => updateMeta(active.dir, (meta) => ({ ...meta, state: 'done', endedAt, sessions: closeLastSession(meta, endedAt) })));
    if (!active.hasSegments) return;
    const dir = active.dir;
    (active.resume ? this.deps.generateNotes(dir, { resume: true }) : this.deps.generateNotes(dir)).then(
      () => this.emit('notes', { dir, ok: true }),
      (err: Error) => this.emit('notes', { dir, ok: false, error: err.message }),
    );
  }
}

class StepTimeout extends Error {
  constructor() {
    super('step timeout');
  }
}

/** Idioma dos marcadores do arquivo: o falado na reunião; `auto` usa o idioma do app. */
function markerLanguage(language: TranscriptionLanguage): UiLanguage {
  return language === 'en' ? 'en' : language === 'pt' ? 'pt-BR' : getLanguage();
}

type Adopted = { dir: string; resume: boolean; previous: MeetingMeta };

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

/** `audio.wav`, ou (se já existir) `audio-2.wav`, `audio-3.wav`… A partir de `from` os nomes sempre levam sufixo. */
async function freeName(dir: string, base: string, ext: string, from = 1): Promise<string> {
  for (let n = from; ; n++) {
    const name = n === 1 ? `${base}${ext}` : `${base}-${n}${ext}`;
    if (!(await exists(join(dir, name)))) return name;
  }
}

function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  return minutes >= 60 ? `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min` : `${minutes} min`;
}

async function defaultFreeBytes(path: string): Promise<number | null> {
  const info = await statfs(path);
  return info.bavail * info.bsize;
}

function formatBytes(bytes: number): string {
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.max(0, Math.round(bytes / 1024 ** 2))} MB`;
}

function closeLastSession(meta: MeetingMeta, endedAt: string): RecordingSession[] {
  const sessions = meetingSessions(meta).map((s) => ({ ...s }));
  sessions[sessions.length - 1]!.endedAt = endedAt;
  return sessions;
}
