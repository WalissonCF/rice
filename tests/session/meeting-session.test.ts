import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { describe, expect, it, test, vi } from 'vitest';
import { MeetingSession } from '../../src/main/session/meeting-session';
import { createMeeting, readMeetingText, readMeta, updateMeta, writeMeta } from '../../src/main/store/meeting-files';
import { recoverMeeting } from '../../src/main/session/recover-meeting';
import type { AudioFrame } from '../../src/shared/frames';
import { makeTmpDir } from '../helpers/tmp';

class FakeCapture extends EventEmitter {
  started = 0;
  stopped = 0;
  micDevices: Array<string | undefined> = [];
  killed = 0;
  kill() { this.killed++; }
  start() { this.started++; }
  setMicDevice(uid?: string) { this.micDevices.push(uid); }
  async stop() { this.stopped++; this.emit('exit', { code: 0, signal: null, expected: true }); }
  emitFrames(n: number, fromMs: number) {
    for (let i = 0; i < n; i++) {
      for (const source of ['mic', 'sys'] as const) {
        this.emit('frame', { source, timestampMs: fromMs + i * 100, pcm: Buffer.alloc(3200, 1) } satisfies AudioFrame);
      }
    }
  }
  crash() {
    this.emit('event', { event: 'error', source: 'sys', fatal: true, message: 'x' });
    this.emit('exit', { code: 3, signal: null, expected: false });
  }
}

class FakePipeline extends EventEmitter {
  mic = 0;
  /** `false`: o pipeline recebe áudio mas não transcreve nada (silêncio na reunião). */
  speak = true;
  finished = false;
  retried = 0;
  pushFrame(f: AudioFrame) {
    this.frames.push(f);
    if (f.source !== 'mic') return;
    if (++this.mic % 10 === 0 && this.speak) {
      this.emit('segment', { id: String(this.mic), source: 'Eu', startMs: f.timestampMs - 900, endMs: f.timestampMs + 100, text: `fala ${this.mic}` });
    }
  }
  finishError: Error | null = null;
  frames: AudioFrame[] = [];
  async finish() {
    if (this.finishError) throw this.finishError;
    this.finished = true;
  }
  retry() { this.retried++; }
  flushes = 0;
  async flush() { this.flushes++; }
}

type SetupOpts = {
  keepAudio?: boolean;
  createPipeline?: () => Promise<never>;
  encode?: (wav: string, m4a: string) => Promise<void>;
  now?: () => Date;
  restartDelayMs?: number;
  makeCapture?: () => FakeCapture;
  concat?: (a: string, b: string, out: string) => Promise<void>;
  defaultLanguage?: () => 'pt' | 'en' | 'auto';
  createPipelineSpy?: (language: string, vocabulary?: string) => void;
  vocabulary?: (dir: string) => Promise<string>;
  speakers?: (dir: string) => Promise<unknown>;
  deps?: Record<string, unknown>;
  createPipelineSpyAll?: (...args: unknown[]) => void;
};

async function setup(keepAudioOrOpts: boolean | SetupOpts = true) {
  const opts: SetupOpts = typeof keepAudioOrOpts === 'boolean' ? { keepAudio: keepAudioOrOpts } : keepAudioOrOpts;
  const keepAudio = opts.keepAudio ?? true;
  const root = await makeTmpDir();
  const captures: FakeCapture[] = [];
  const pipeline = new FakePipeline();
  const generateNotes = vi.fn(async (_dir: string) => {});
  const session = new MeetingSession({
    root: async () => root,
    createCapture: () => {
      const c = opts.makeCapture?.() ?? new FakeCapture();
      captures.push(c);
      return c as never;
    },
    ...(opts.vocabulary ? { vocabulary: opts.vocabulary } : {}),
    ...(opts.speakers ? { speakers: opts.speakers as never } : {}),
    createPipeline: opts.createPipeline ?? (async (language: string, vocabulary?: string, ...rest: unknown[]) => {
      opts.createPipelineSpy?.(language, vocabulary);
      opts.createPipelineSpyAll?.(language, vocabulary, ...rest);
      return pipeline as never;
    }),
    ...(opts.defaultLanguage ? { defaultLanguage: opts.defaultLanguage } : {}),
    generateNotes,
    keepAudio: () => keepAudio,
    now: opts.now ?? (() => new Date(2026, 9, 8, 14, 0)),
    restartDelayMs: opts.restartDelayMs ?? 1,
    ...(opts.encode ? { encode: opts.encode } : {}),
    ...(opts.concat ? { concat: opts.concat } : {}),
    ...(opts.deps ?? {}),
  } as never);
  return { session, captures, pipeline, generateNotes, root };
}

// o encode real usa o afconvert (só macOS): no Windows o áudio fica em audio.wav
const macAudio = test.skipIf(process.platform !== 'darwin');

macAudio('grava, transcreve em arquivo e para gerando áudio e notas', async () => {
  const { session, captures, pipeline, generateNotes } = await setup();
  const states: string[] = [];
  session.on('state', (s: string) => states.push(s));
  const dir = await session.start({ title: 'Daily', trigger: 'manual' });
  captures[0]!.emitFrames(20, 0);
  await session.stop();
  expect(states).toEqual(['recording', 'finishing', 'idle']);
  expect(pipeline.finished).toBe(true);
  expect(await readMeetingText(dir, 'transcript')).toContain('**[14:00:01] Eu:** fala 20');
  const meta = await readMeta(dir);
  expect(meta.state).toBe('done');
  expect(meta.endedAt).toBeDefined();
  expect((await readdir(dir)).sort()).toContain('audio.m4a');
  expect(await readdir(dir)).not.toContain('audio.wav');
  await vi.waitFor(() => expect(generateNotes).toHaveBeenCalledWith(dir));
});

test('avisa qual reunião está gravando assim que ela existe (o estado "recording" chega antes do dir)', async () => {
  const { session } = await setup();
  const seen: Array<string | null> = [];
  session.on('state', () => seen.push(session.currentDir));
  const active = new Promise<string>((resolve) => session.once('active', resolve));
  const dir = await session.start({ title: 'Do aviso', trigger: 'calendar' });
  expect(seen[0]).toBeNull(); // quem lê o dir no evento de estado ainda não vê a reunião
  expect(await active).toBe(dir);
  expect(session.currentDir).toBe(dir);
  await session.stop();
});

test('não grava duas reuniões ao mesmo tempo', async () => {
  const { session } = await setup();
  await session.start({ title: 'A', trigger: 'manual' });
  await expect(session.start({ title: 'B', trigger: 'mic' })).rejects.toThrow('já existe uma gravação');
  await session.stop();
});

test('captura que cai é reiniciada e a lacuna fica registrada', async () => {
  const { session, captures } = await setup();
  const dir = await session.start({ title: 'A', trigger: 'manual' });
  captures[0]!.emitFrames(10, 0);
  captures[0]!.crash();
  await vi.waitFor(() => expect(captures).toHaveLength(2));
  expect(captures[1]!.started).toBe(1);
  await session.stop();
  const meta = await readMeta(dir);
  expect(meta.gaps).toHaveLength(1);
  expect(meta.gaps[0]!.reason).toBe('audio-restart');
  expect(await readMeetingText(dir, 'transcript')).toContain('áudio interrompido');
});

test('keepAudio=false apaga o áudio ao final', async () => {
  const { session, captures } = await setup(false);
  const dir = await session.start({ title: 'A', trigger: 'manual' });
  captures[0]!.emitFrames(10, 0);
  await session.stop();
  expect(await readdir(dir)).not.toContain('audio.m4a');
});

test('repassa warning do pipeline e retryAsr chama retry()', async () => {
  const { session, pipeline } = await setup();
  const warnings: unknown[] = [];
  session.on('asr-warning', (w) => warnings.push(w));
  await session.start({ title: 'A', trigger: 'manual' });
  pipeline.emit('warning', { source: 'mic', message: 'VAD: x' });
  expect(warnings).toEqual([{ source: 'mic', message: 'VAD: x' }]);
  session.retryAsr();
  expect(pipeline.retried).toBe(1);
  await session.stop();
  expect(() => session.retryAsr()).not.toThrow();
});

test('pipeline em failed no stop: done com marcador de transcrição incompleta', async () => {
  const { session, captures, pipeline } = await setup();
  const dir = await session.start({ title: 'A', trigger: 'manual' });
  captures[0]!.emitFrames(10, 0);
  pipeline.emit('status', { state: 'failed', queueSeconds: 12, error: 'boom' });
  await session.stop();
  expect((await readMeta(dir)).state).toBe('done');
  expect(await readMeetingText(dir, 'transcript')).toContain('*[transcrição incompleta — use Retranscrever depois]*');
});

test('captura que sai sempre: reinícios limitados, avisa fatal e continua gravando', async () => {
  vi.useFakeTimers();
  try {
    const { session, captures } = await setup({
      restartDelayMs: 1000,
      makeCapture: () => {
        const c = new FakeCapture();
        c.start = function (this: FakeCapture) {
          this.started++;
          this.emit('exit', { code: 1, signal: null, expected: false });
        };
        return c;
      },
    });
    const events: Array<Record<string, unknown>> = [];
    session.on('capture-event', (e) => events.push(e));
    await session.start({ title: 'A', trigger: 'manual' });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(captures.length).toBeLessThanOrEqual(4);
    expect(events).toContainEqual({ event: 'error', fatal: true, source: 'session', message: 'captura não reinicia' });
    expect(session.state).toBe('recording');
    await session.stop();
    expect(session.state).toBe('idle');
  } finally {
    vi.useRealTimers();
  }
});

test('mic-device do helper (Windows) vira o evento aditivo "mic" da sessão; qualquer outro evento não emite e a captura segue igual', async () => {
  const { session, captures } = await setup();
  const mics: unknown[] = [];
  const raw: string[] = [];
  session.on('mic', (m) => mics.push(m));
  session.on('capture-event', (e: { event: string }) => raw.push(e.event));
  await session.start({ title: 'A', trigger: 'manual' });
  captures[0]!.emit('event', { event: 'started', mic: true, sys: true });
  captures[0]!.emit('event', { event: 'mic-device', id: 'b', name: 'Microfone (FIFINE K669)', isDefault: false, chosen: true, reason: 'open' });
  captures[0]!.emit('event', { event: 'mic-device', id: 7, name: 'Sem id válido', reason: 'default-changed' });
  captures[0]!.emit('event', { event: 'mic-device', id: 'x' }); // sem nome: ignorado
  expect(mics).toEqual([
    { id: 'b', name: 'Microfone (FIFINE K669)', isDefault: false, chosen: true },
    { id: undefined, name: 'Sem id válido', isDefault: false, chosen: false },
  ]);
  expect(raw).toEqual(['started', 'mic-device', 'mic-device', 'mic-device']); // o repasse de capture-event continua
  expect(captures).toHaveLength(1); // nada reinicia
  await session.stop();
});

test('evento fatal com o processo vivo reinicia a captura', async () => {
  const { session, captures } = await setup();
  await session.start({ title: 'A', trigger: 'manual' });
  captures[0]!.emit('event', { event: 'error', source: 'sys', fatal: true, message: 'x' });
  await vi.waitFor(() => expect(captures).toHaveLength(2));
  await session.stop();
});

test('timestamps da captura reiniciada ficam deslocados e monotônicos', async () => {
  let nowMs = new Date(2026, 9, 8, 14, 0).getTime();
  const { session, captures, pipeline } = await setup({ now: () => new Date(nowMs) });
  await session.start({ title: 'A', trigger: 'manual' });
  captures[0]!.emitFrames(10, 0);
  nowMs += 5000;
  captures[0]!.crash();
  await vi.waitFor(() => expect(captures).toHaveLength(2));
  captures[1]!.emitFrames(5, 0);
  await session.stop();
  const mic = pipeline.frames.filter((f) => f.source === 'mic').map((f) => f.timestampMs);
  expect(mic).toHaveLength(15);
  expect(mic.slice(10).every((t) => t >= 5000)).toBe(true);
  expect([...mic].sort((a, b) => a - b)).toEqual(mic);
});

test('pipeline tardio: frames ficam em buffer e entram em ordem', async () => {
  let release!: (p: never) => void;
  const late = new Promise<never>((r) => (release = r));
  const { session, captures, pipeline } = await setup({ createPipeline: () => late });
  const dir = await session.start({ title: 'A', trigger: 'manual' });
  captures[0]!.emitFrames(10, 0);
  expect(pipeline.frames).toHaveLength(0);
  release(pipeline as never);
  await vi.waitFor(() => expect(pipeline.frames).toHaveLength(20));
  captures[0]!.emitFrames(2, 1000);
  expect(pipeline.frames).toHaveLength(24);
  expect(pipeline.frames.map((f) => f.timestampMs).filter((_, i) => i % 2 === 0).slice(0, 3)).toEqual([0, 100, 200]);
  await session.stop();
  expect((await readMeta(dir)).state).toBe('done');
});

macAudio('createPipeline rejeita: continua gravando, avisa failed e marca incompleta', async () => {
  const { session, captures } = await setup({ createPipeline: async () => { throw new Error('sem modelo'); } });
  const statuses: unknown[] = [];
  session.on('asr-status', (s) => statuses.push(s));
  const dir = await session.start({ title: 'A', trigger: 'manual' });
  await vi.waitFor(() => expect(statuses).toEqual([{ state: 'failed', queueSeconds: 0, error: 'sem modelo' }]));
  captures[0]!.emitFrames(5, 0);
  await session.stop();
  expect(await readdir(dir)).toContain('audio.m4a');
  expect(await readMeetingText(dir, 'transcript')).toContain('transcrição incompleta');
  expect((await readMeta(dir)).state).toBe('done');
});

test('retryAsr recria o pipeline quando createPipeline rejeitou', async () => {
  let calls = 0;
  const pipeline_ref: { current: unknown } = { current: null };
  const { session, captures, pipeline } = await setup({
    createPipeline: async () => {
      if (++calls === 1) throw new Error('sem modelo');
      return pipeline_ref.current as never;
    },
  });
  pipeline_ref.current = pipeline;
  const statuses: unknown[] = [];
  session.on('asr-status', (s) => statuses.push(s));
  const dir = await session.start({ title: 'A', trigger: 'manual' });
  await vi.waitFor(() => expect(statuses.length).toBe(1));
  captures[0]!.emitFrames(2, 0);
  expect(pipeline.frames.length).toBe(0);
  session.retryAsr();
  await vi.waitFor(() => expect(calls).toBe(2));
  await new Promise((r) => setTimeout(r, 10));
  captures[0]!.emitFrames(2, 1000);
  expect(pipeline.frames.length).toBe(4);
  await session.stop();
  expect(await readMeetingText(dir, 'transcript')).toContain('transcrição incompleta');
});

test('stop durante a espera do pipeline funciona', async () => {
  const { session } = await setup({ createPipeline: () => new Promise<never>(() => {}) });
  const dir = await session.start({ title: 'A', trigger: 'manual' });
  await session.stop();
  expect(session.state).toBe('idle');
  expect((await readMeta(dir)).state).toBe('done');
});

macAudio('pipeline.finish lança: meta done, idle e m4a gerado', async () => {
  const { session, captures, pipeline } = await setup();
  pipeline.finishError = new Error('boom');
  const warnings: unknown[] = [];
  session.on('session-warning', (w) => warnings.push(w));
  const dir = await session.start({ title: 'A', trigger: 'manual' });
  captures[0]!.emitFrames(10, 0);
  await session.stop();
  expect(session.state).toBe('idle');
  const meta = await readMeta(dir);
  expect(meta.state).toBe('done');
  expect(meta.endedAt).toBeDefined();
  expect(await readdir(dir)).toContain('audio.m4a');
  expect(warnings).toContainEqual({ message: 'boom' });
});

test('encodeM4a lança: meta done e audio.wav preservado', async () => {
  const { session, captures } = await setup({ encode: async () => { throw new Error('afconvert'); } });
  const dir = await session.start({ title: 'A', trigger: 'manual' });
  captures[0]!.emitFrames(10, 0);
  await session.stop();
  expect((await readMeta(dir)).state).toBe('done');
  const files = await readdir(dir);
  expect(files).toContain('audio.wav');
  expect(files).not.toContain('audio.m4a');
});

test('emite "frame" com cada frame capturado (usado pelo nível do nub)', async () => {
  const { session, captures } = await setup();
  const seen: AudioFrame[] = [];
  session.on('frame', (f: AudioFrame) => seen.push(f));
  await session.start({ title: 'x', trigger: 'manual' });
  captures[0]!.emitFrames(2, 0);
  expect(seen.map((f) => f.source)).toEqual(['mic', 'sys', 'mic', 'sys']);
  await session.stop();
});

test('start com dir de um draft grava nessa pasta, sem criar outra', async () => {
  const { session, root, captures } = await setup();
  const draft = await createMeeting(root, { title: 'Gi e Eu', startedAt: new Date(2026, 9, 8, 9, 0), trigger: 'manual', state: 'draft' });
  const dir = await session.start({ title: 'Reunião', trigger: 'manual', dir: draft.dir });
  expect(dir).toBe(draft.dir);
  expect(await readdir(root)).toHaveLength(1);
  const meta = await readMeta(dir);
  expect(meta.state).toBe('recording');
  expect(meta.title).toBe('Gi e Eu');
  expect(meta.startedAt).toBe('2026-10-08T14:00:00-03:00');
  expect(session.currentDir).toBe(dir);
  captures[0]!.emitFrames(1, 0);
  await session.stop();
  expect((await readMeta(dir)).state).toBe('done');
});

/** Reunião já gravada (state `state`), com `sessions` opcional para simular metas antigas. */
async function finished(root: string, state: 'done' | 'interrupted', withSessions = true) {
  const old = await createMeeting(root, { title: 'Velha', startedAt: new Date(2026, 9, 8, 9, 0), trigger: 'manual', templateId: 'retro' });
  const { sessions: _s, ...rest } = old.meta;
  await writeMeta(old.dir, {
    ...rest,
    state,
    notesStatus: 'done',
    ...(state === 'done' ? { endedAt: '2026-10-08T09:30:00-03:00' } : {}),
    ...(withSessions ? { sessions: [{ startedAt: '2026-10-08T09:00:00-03:00', ...(state === 'done' ? { endedAt: '2026-10-08T09:30:00-03:00' } : {}) }] } : {}),
  });
  await writeFile(join(old.dir, 'transcricao.md'), '# Transcrição — Velha\n\n**[09:00:01] Eu:** antes\n\n');
  return old.dir;
}

const fakeEncode = async (_wav: string, m4a: string) => writeFile(m4a, 'NOVO');
const fakeConcat = async (a: string, b: string, out: string) => writeFile(out, `${await readFile(a, 'utf8')}+${await readFile(b, 'utf8')}`);

test('retomar reunião done: append na transcrição com marcador, sessions[2], startedAt original e notas regeneradas', async () => {
  const { session, root, captures, generateNotes } = await setup({ encode: fakeEncode, concat: fakeConcat });
  const dir = await finished(root, 'done');
  await writeFile(join(dir, 'audio.m4a'), 'ANTIGO');
  expect(await session.start({ title: 'x', trigger: 'manual', dir })).toBe(dir);
  expect(await readdir(root)).toHaveLength(1);
  expect((await readMeta(dir)).state).toBe('recording');
  captures[0]!.emitFrames(10, 0);
  await session.stop();
  const text = await readMeetingText(dir, 'transcript');
  expect(text).toContain('**[09:00:01] Eu:** antes');
  expect(text.indexOf('*[gravação retomada às 14:00]*')).toBeGreaterThan(text.indexOf('antes'));
  expect(text.indexOf('*[gravação retomada às 14:00]*')).toBeLessThan(text.indexOf('**[14:00:00] Eu:** fala 10'));
  const meta = await readMeta(dir);
  expect(meta.state).toBe('done');
  expect(meta.startedAt).toBe('2026-10-08T09:00:00-03:00');
  expect(meta.endedAt).toBe('2026-10-08T14:00:00-03:00');
  expect(meta.sessions).toEqual([
    { startedAt: '2026-10-08T09:00:00-03:00', endedAt: '2026-10-08T09:30:00-03:00' },
    { startedAt: '2026-10-08T14:00:00-03:00', endedAt: '2026-10-08T14:00:00-03:00' },
  ]);
  expect(await readFile(join(dir, 'audio.m4a'), 'utf8')).toBe('ANTIGO+NOVO');
  expect((await readdir(dir)).filter((f) => f.includes('audio'))).toEqual(['audio.m4a']);
  await vi.waitFor(() => expect(generateNotes).toHaveBeenCalledWith(dir, { resume: true }));
});

test('retomar reunião interrupted (sem áudio anterior): grava audio.m4a e fecha a sessão aberta', async () => {
  const { session, root, captures } = await setup({ encode: fakeEncode, concat: fakeConcat });
  const dir = await finished(root, 'interrupted');
  await session.start({ title: 'x', trigger: 'manual', dir });
  captures[0]!.emitFrames(10, 0);
  await session.stop();
  const meta = await readMeta(dir);
  expect(meta.state).toBe('done');
  expect(meta.sessions).toHaveLength(2);
  expect(meta.sessions![1]!.endedAt).toBeDefined();
  expect(await readFile(join(dir, 'audio.m4a'), 'utf8')).toBe('NOVO');
});

test('retomar reunião em recording ou finishing dá erro e não altera nada', async () => {
  const { session, root } = await setup();
  const dir = await finished(root, 'done');
  await writeMeta(dir, { ...(await readMeta(dir)), state: 'recording' });
  await expect(session.start({ title: 'x', trigger: 'manual', dir })).rejects.toThrow('já está sendo gravada');
  expect(session.state).toBe('idle');
  await writeMeta(dir, { ...(await readMeta(dir)), state: 'finishing' });
  await expect(session.start({ title: 'x', trigger: 'manual', dir })).rejects.toThrow('já está sendo gravada');
  expect((await readMeta(dir)).state).toBe('finishing');
});

test('meta antiga sem sessions: a primeira sessão é migrada de startedAt/endedAt', async () => {
  const { session, root, captures } = await setup({ encode: fakeEncode });
  const dir = await finished(root, 'done', false);
  expect((await readMeta(dir)).sessions).toBeUndefined();
  await session.start({ title: 'x', trigger: 'manual', dir });
  captures[0]!.emitFrames(1, 0);
  await session.stop();
  expect((await readMeta(dir)).sessions![0]).toEqual({ startedAt: '2026-10-08T09:00:00-03:00', endedAt: '2026-10-08T09:30:00-03:00' });
});

test('concatenar falha: a nova gravação vira audio-2.m4a, o anterior fica e há aviso', async () => {
  const { session, root, captures } = await setup({ encode: fakeEncode, concat: async () => { throw new Error('sem afconvert'); } });
  const dir = await finished(root, 'done');
  await writeFile(join(dir, 'audio.m4a'), 'ANTIGO');
  const warnings: Array<{ message: string }> = [];
  session.on('session-warning', (w) => warnings.push(w));
  await session.start({ title: 'x', trigger: 'manual', dir });
  captures[0]!.emitFrames(1, 0);
  await session.stop();
  expect(await readFile(join(dir, 'audio.m4a'), 'utf8')).toBe('ANTIGO');
  expect(await readFile(join(dir, 'audio-2.m4a'), 'utf8')).toBe('NOVO');
  expect(warnings.some((w) => w.message.includes('audio-2.m4a'))).toBe(true);
});

test('retomada com keepAudio=false não mexe no áudio anterior', async () => {
  const { session, root, captures } = await setup({ keepAudio: false, encode: fakeEncode, concat: fakeConcat });
  const dir = await finished(root, 'done');
  await writeFile(join(dir, 'audio.m4a'), 'ANTIGO');
  await session.start({ title: 'x', trigger: 'manual', dir });
  captures[0]!.emitFrames(1, 0);
  await session.stop();
  expect(await readFile(join(dir, 'audio.m4a'), 'utf8')).toBe('ANTIGO');
  expect((await readdir(dir)).filter((f) => f.endsWith('.wav'))).toEqual([]);
});

test('retomada sem segmentos não gera marcador nem regera notas', async () => {
  const { session, root, generateNotes } = await setup({ encode: fakeEncode });
  const dir = await finished(root, 'done');
  await session.start({ title: 'x', trigger: 'manual', dir });
  await session.stop();
  expect(await readMeetingText(dir, 'transcript')).not.toContain('retomada');
  expect(generateNotes).not.toHaveBeenCalled();
});

macAudio('rename do áudio junto falha: a parte nova não é apagada, vira audio-2.m4a e há aviso', async () => {
  const { mkdir } = await import('node:fs/promises');
  const { session, root, captures } = await setup({ encode: fakeEncode, concat: async (_a, _b, out) => { await mkdir(out); } }); // rename de pasta sobre arquivo falha
  const dir = await finished(root, 'done');
  await writeFile(join(dir, 'audio.m4a'), 'ANTIGO');
  const warnings: Array<{ message: string }> = [];
  session.on('session-warning', (w) => warnings.push(w));
  await session.start({ title: 'x', trigger: 'manual', dir });
  captures[0]!.emitFrames(1, 0);
  await session.stop();
  expect(await readFile(join(dir, 'audio.m4a'), 'utf8')).toBe('ANTIGO');
  expect(await readFile(join(dir, 'audio-2.m4a'), 'utf8')).toBe('NOVO');
  expect(warnings.some((w) => w.message.includes('audio-2.m4a'))).toBe(true);
  expect((await readdir(dir)).filter((f) => f.startsWith('.audio'))).toEqual([]);
});

test('begin falha após adotar a reunião: meta volta ao estado anterior, sem sessão aberta nem WAV, e dá para tentar de novo', async () => {
  let fail = true;
  const { session, root, captures } = await setup({
    encode: fakeEncode,
    makeCapture: () => {
      if (fail) throw new Error('sem microfone');
      return new FakeCapture();
    },
  });
  const dir = await finished(root, 'done');
  const before = await readMeta(dir);
  await expect(session.start({ title: 'x', trigger: 'manual', dir })).rejects.toThrow('sem microfone');
  const after = await readMeta(dir);
  expect(after.state).toBe('done');
  expect(after.sessions).toEqual(before.sessions);
  expect(after.startedAt).toBe(before.startedAt);
  expect((await readdir(dir)).filter((f) => f.endsWith('.wav'))).toEqual([]);
  expect(session.state).toBe('idle');
  fail = false;
  await session.start({ title: 'x', trigger: 'manual', dir }); // não é recusada como "já gravando"
  expect(captures).toHaveLength(1);
  await session.stop();
});

test('idioma da transcrição: padrão das configurações no começo; meta.language vale por reunião, também ao retomar', async () => {
  const seen: string[] = [];
  const { session, root, captures } = await setup({ encode: fakeEncode, defaultLanguage: () => 'auto', createPipelineSpy: (l) => seen.push(l) });
  const first = await session.start({ title: 'x', trigger: 'manual' }); // sem meta.language: padrão
  await session.stop();
  expect(seen).toEqual(['auto']);
  await writeMeta(first, { ...(await readMeta(first)), language: 'en' });
  await session.start({ title: 'x', trigger: 'manual', dir: first }); // retomada: meta.language
  captures[1]!.emitFrames(10, 0);
  await session.stop();
  expect(seen).toEqual(['auto', 'en']);
  const draft = await createMeeting(root, { title: 'D', startedAt: new Date(2026, 9, 8, 9, 0), trigger: 'manual', state: 'draft' });
  await writeMeta(draft.dir, { ...draft.meta, language: 'pt' });
  await session.start({ title: 'x', trigger: 'manual', dir: draft.dir });
  await session.stop();
  expect(seen).toEqual(['auto', 'en', 'pt']);
});

test('sem configuração de idioma o padrão é pt', async () => {
  const seen: string[] = [];
  const { session } = await setup({ encode: fakeEncode, createPipelineSpy: (l) => seen.push(l) });
  await session.start({ title: 'x', trigger: 'manual' });
  await session.stop();
  expect(seen).toEqual(['pt']);
});

test('marcador de retomada sai em inglês quando a reunião é em inglês', async () => {
  const { session, root, captures } = await setup({ encode: fakeEncode, concat: fakeConcat });
  const dir = await finished(root, 'done');
  await writeMeta(dir, { ...(await readMeta(dir)), language: 'en' });
  await session.start({ title: 'x', trigger: 'manual', dir });
  captures[0]!.emitFrames(10, 0);
  await session.stop();
  expect(await readMeetingText(dir, 'transcript')).toContain('*[recording resumed at 14:00]*');
});

test('pipeline que fica pronto depois do fim da gravação é devolvido (finish) para o ASR poder descer', async () => {
  const pipeline = new FakePipeline();
  let ready!: () => void;
  const gate = new Promise<void>((resolve) => (ready = resolve));
  const { session } = await setup({ createPipeline: async () => { await gate; return pipeline as never; } });
  await session.start({ title: 'A', trigger: 'manual' });
  await session.stop();
  expect(pipeline.finished).toBe(false);
  ready();
  await vi.waitFor(() => expect(pipeline.finished).toBe(true));
});

test('o vocabulário da reunião chega ao pipeline; se falhar, grava mesmo assim sem ele', async () => {
  const seen: Array<string | undefined> = [];
  const ok = await setup({ vocabulary: async () => 'Uirapuru Tecnologia, OKR.', createPipelineSpy: (_l, v) => seen.push(v) });
  await ok.session.start({ title: 'Daily', trigger: 'manual' });
  await vi.waitFor(() => expect(seen).toEqual(['Uirapuru Tecnologia, OKR.']));
  await ok.session.stop();
  const bad = await setup({ vocabulary: async () => { throw new Error('meta sumiu'); }, createPipelineSpy: (_l, v) => seen.push(v) });
  await bad.session.start({ title: 'Daily', trigger: 'manual' });
  await vi.waitFor(() => expect(seen).toEqual(['Uirapuru Tecnologia, OKR.', '']));
  await bad.session.stop();
});

test('o identificador de pessoas chega ao pipeline; se falhar, grava mesmo assim sem ele', async () => {
  const seen: unknown[][] = [];
  const who = { identify: async () => 1, close: async () => {} };
  const ok = await setup({ speakers: async () => who, createPipelineSpyAll: (...a) => seen.push(a) });
  await ok.session.start({ title: 'Daily', trigger: 'manual' });
  await vi.waitFor(() => expect(seen).toHaveLength(1));
  expect(seen[0]![2]).toBe(who);
  await ok.session.stop();
  const bad = await setup({ speakers: async () => { throw new Error('modelo'); }, createPipelineSpyAll: (...a) => seen.push(a) });
  await bad.session.start({ title: 'Daily', trigger: 'manual' });
  await vi.waitFor(() => expect(seen).toHaveLength(2));
  expect(seen[1]![2]).toBeUndefined();
  await bad.session.stop();
});

test('quem falava na chamada (Discord) dá nome ao trecho de "Outros": vira Pessoa N com o nome no meta', async () => {
  let t = 0;
  const { session, pipeline } = await setup({ now: () => new Date(2026, 9, 8, 14, 0, 0, t) });
  const live: Array<{ speaker?: number; speakerName?: string }> = [];
  session.on('segment', ({ segment }: { segment: { speaker?: number; speakerName?: string } }) => live.push(segment));
  const dir = await session.start({ title: 'Discord', trigger: 'mic', app: 'Discord' });
  await vi.waitFor(() => expect(pipeline.listenerCount('segment')).toBeGreaterThan(0));
  t = 1000;
  session.markSpeaker('Ana', true);
  t = 4000;
  session.markSpeaker('Ana', false);
  pipeline.emit('segment', { id: 'a', source: 'Outros', startMs: 1200, endMs: 3800, text: 'oi, tudo bem?' });
  pipeline.emit('segment', { id: 'b', source: 'Outros', startMs: 6000, endMs: 8000, text: 'alguém fora do Discord' });
  await session.stop();
  const transcript = await readMeetingText(dir, 'transcript');
  expect(transcript).toContain('**[14:00:01] Pessoa 1:** oi, tudo bem?');
  expect(transcript).toContain('**[14:00:06] Outros:** alguém fora do Discord');
  expect((await readMeta(dir)).speakers).toEqual({ '1': 'Ana' });
  expect(live[0]).toMatchObject({ speaker: 1, speakerName: 'Ana' });
  expect(live[1]!.speaker).toBeUndefined();
});

// ---- R-25/R-26: disco cheio e pasta indisponível ----
const enospc = () => Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });

/** FS do WAV que dá ENOSPC enquanto `full` for verdadeiro (o cabeçalho inicial passa). */
function flakyWavFs() {
  const state = { full: false };
  const fs = {
    open: async () => {
      let first = true;
      return {
        write: async (_d: Buffer, _o: number, length: number) => {
          if (first) { first = false; return { bytesWritten: length }; }
          if (state.full) throw enospc();
          return { bytesWritten: length };
        },
        close: async () => {},
      } as never;
    },
    mkdir: async () => {},
  };
  return { state, fs };
}

test('pouco espaço livre: avisa ao iniciar e o aviso some quando o espaço volta; a gravação começa mesmo assim', async () => {
  let free = 400 * 1024 ** 2;
  const { session } = await setup({ deps: { freeBytes: async () => free, diskCheckMs: 20 } });
  await session.start({ title: 'Daily', trigger: 'manual' });
  expect(session.alerts.list()).toEqual([expect.objectContaining({ id: 'storage:low', level: 'warn', action: expect.objectContaining({ kind: 'open-storage' }) })]);
  expect(session.alerts.list()[0]!.message).toContain('400 MB');
  free = 5 * 1024 ** 3;
  await vi.waitFor(() => expect(session.alerts.has('storage:low')).toBe(false));
  await session.stop();
});

test('disco cheio durante a gravação: aviso persistente na hora, transcrição segue, lacuna registrada ao voltar o espaço', async () => {
  const wav = flakyWavFs();
  const { session, captures } = await setup({ deps: { wavFs: wav.fs, wavRetryMs: 0, freeBytes: async () => null } });
  const dir = await session.start({ title: 'Daily', trigger: 'manual' });
  captures[0]!.emitFrames(10, 0); // 1 s ok
  wav.state.full = true;
  captures[0]!.emitFrames(30, 1000); // 3 s sem espaço
  await vi.waitFor(() => expect(session.alerts.has('storage:audio')).toBe(true));
  const alert = session.alerts.list().find((a) => a.id === 'storage:audio')!;
  expect(alert.level).toBe('error');
  expect(alert.message).toContain('Disco cheio');
  expect(alert.action?.kind).toBe('open-storage');
  // a transcrição continua sendo gravada com o disco "cheio" só para o áudio
  captures[0]!.emitFrames(10, 4000);
  wav.state.full = false; // o usuário liberou espaço
  captures[0]!.emitFrames(30, 5000);
  await vi.waitFor(() => expect(session.alerts.has('storage:audio')).toBe(false));
  await session.stop();
  const meta = await readMeta(dir);
  expect(meta.gaps).toEqual([expect.objectContaining({ reason: 'disk-full' })]);
  expect(meta.gaps[0]!.toMs).toBeGreaterThan(meta.gaps[0]!.fromMs);
  expect(await readMeetingText(dir, 'transcript')).toContain('**[14:00:');
  expect(await readMeetingText(dir, 'transcript')).toMatch(/áudio interrompido/);
});

test('transcrição que não grava: aviso persistente, texto retido na memória e gravado quando a pasta volta', async () => {
  let broken = false;
  const files = new Map<string, string>();
  const sinkFs = {
    appendFile: async (path: string, data: string) => {
      if (broken && !path.includes('spool')) throw enospc();
      files.set(path, (files.get(path) ?? '') + data);
    },
    mkdir: async () => {},
    rm: async (path: string) => { files.delete(path); },
  };
  const { session, captures, root } = await setup({ deps: { sinkFs, sinkRetryMs: 10, spoolDir: () => '/spool', freeBytes: async () => null } });
  const dir = await session.start({ title: 'Daily', trigger: 'manual' });
  captures[0]!.emitFrames(10, 0);
  await vi.waitFor(() => expect([...files.keys()].some((k) => k.endsWith('transcricao.md') && !k.includes('spool'))).toBe(true));
  broken = true;
  captures[0]!.emitFrames(10, 1000);
  await vi.waitFor(() => expect(session.alerts.has('storage:transcript')).toBe(true));
  expect(session.alerts.list().find((a) => a.id === 'storage:transcript')!.message).toContain('Disco cheio');
  expect([...files.entries()].find(([k]) => k.includes('spool'))![1]).toContain('fala 20');
  broken = false;
  await vi.waitFor(() => expect(session.alerts.has('storage:transcript')).toBe(false));
  await session.stop();
  const dest = [...files.entries()].find(([k]) => k === join(dir, 'transcricao.md'))![1];
  expect(dest).toContain('fala 10');
  expect(dest).toContain('fala 20');
  expect(root).toBeTruthy();
});

test('pasta indisponível até o fim: a transcrição fica na cópia local e o aviso diz onde', async () => {
  const files = new Map<string, string>();
  const sinkFs = {
    appendFile: async (path: string, data: string) => {
      if (!path.includes('spool')) throw Object.assign(new Error('EIO'), { code: 'EIO' });
      files.set(path, (files.get(path) ?? '') + data);
    },
    mkdir: async () => { throw Object.assign(new Error('EIO'), { code: 'EIO' }); },
    rm: async () => {},
  };
  const { session, captures } = await setup({ deps: { sinkFs, sinkRetryMs: 10_000, spoolDir: () => '/spool', freeBytes: async () => null } });
  await session.start({ title: 'Daily', trigger: 'manual' });
  captures[0]!.emitFrames(10, 0);
  await vi.waitFor(() => expect(session.alerts.has('storage:transcript')).toBe(true));
  await session.stop();
  const alert = session.alerts.list().find((a) => a.id === 'storage:transcript')!;
  expect(alert.message).toMatch(/[\\/]spool[\\/]/);
  expect(alert.dismissible).toBe(true);
});

// ---- R-19: Mac dorme e acorda ----
test('repouso de 10 min: lacuna com o horário real, marcador, captura reconstruída e linha do tempo pelo relógio de parede', async () => {
  let clock = new Date(2026, 9, 8, 14, 0, 0).getTime();
  const { session, captures, pipeline } = await setup({ now: () => new Date(clock), deps: { freeBytes: async () => null } });
  const dir = await session.start({ title: 'Daily', trigger: 'manual' });
  captures[0]!.emitFrames(30, 0); // 3 s
  clock += 3000;
  session.suspend(); // tampa fechada
  expect(captures[0]!.stopped).toBe(1); // a captura antiga para na hora
  clock += 10 * 60_000; // 10 minutos dormindo
  session.resume();
  expect(captures).toHaveLength(2);
  expect(captures[1]!.started).toBe(1);
  // a captura nova recomeça do zero, mas a reunião segue o relógio de parede (3 s + 10 min)
  captures[1]!.emitFrames(2, 0);
  const lastFrame = pipeline.frames.at(-1)!;
  expect(lastFrame.timestampMs).toBeGreaterThanOrEqual(10 * 60_000 + 3000);
  await vi.waitFor(async () => expect((await readMeta(dir)).gaps.length).toBe(1));
  const gap = (await readMeta(dir)).gaps[0]!;
  expect(gap.reason).toBe('sleep');
  expect(gap.fromMs).toBe(3000);
  expect(gap.toMs).toBe(3000 + 10 * 60_000);
  const alert = session.alerts.list().find((a) => a.id === 'sleep')!;
  expect(alert.message).toContain('14:00');
  expect(alert.message).toContain('14:10');
  await session.stop();
  expect(await readMeetingText(dir, 'transcript')).toContain('gravação pausada de 14:00 a 14:10 — computador em repouso');
  expect((await readMeta(dir)).state).toBe('done'); // o repouso não encerra a reunião
});

test('repouso curto (menos de 2 s) só reconstrói a captura, sem lacuna; suspend/resume sem gravação não fazem nada', async () => {
  let clock = new Date(2026, 9, 8, 14, 0, 0).getTime();
  const { session, captures } = await setup({ now: () => new Date(clock), deps: { freeBytes: async () => null } });
  session.suspend();
  session.resume();
  const dir = await session.start({ title: 'Daily', trigger: 'manual' });
  captures[0]!.emitFrames(10, 0);
  clock += 1000;
  session.suspend();
  clock += 500;
  session.resume();
  expect(captures).toHaveLength(2);
  await session.stop();
  expect((await readMeta(dir)).gaps).toEqual([]);
});

test('dois suspend seguidos e resume sem suspend são ignorados (nada de captura duplicada)', async () => {
  let clock = new Date(2026, 9, 8, 14, 0, 0).getTime();
  const { session, captures } = await setup({ now: () => new Date(clock), deps: { freeBytes: async () => null } });
  await session.start({ title: 'Daily', trigger: 'manual' });
  session.resume(); // sem suspend
  expect(captures).toHaveLength(1);
  session.suspend();
  session.suspend();
  clock += 60_000;
  session.resume();
  session.resume();
  expect(captures).toHaveLength(2);
  await session.stop();
});

// ---- R-10/R-07: vigia das fontes e permissão ----
async function watched(extra: Record<string, unknown> = {}) {
  let clock = new Date(2026, 9, 8, 14, 0, 0).getTime();
  const ctx = await setup({ now: () => new Date(clock), restartDelayMs: 1, deps: { watchdogMs: 5, freeBytes: async () => null, ...extra } });
  return { ...ctx, advance: (ms: number) => { clock += ms; }, clock: () => clock };
}
/** Só o microfone entrega blocos (o sistema "travou"). */
const micOnly = (c: FakeCapture, n: number, from: number) => {
  for (let i = 0; i < n; i++) c.emit('frame', { source: 'mic', timestampMs: from + i * 100, pcm: Buffer.alloc(3200, 1) } satisfies AudioFrame);
};

test('sistema para de entregar blocos: aviso em ~7 s, captura reiniciada, e ao voltar o aviso some e a lacuna é registrada', async () => {
  const { session, captures, advance } = await watched();
  const dir = await session.start({ title: 'Daily', trigger: 'manual' });
  captures[0]!.emitFrames(10, 0);
  for (let s = 0; s < 9; s++) { advance(1000); micOnly(captures[0]!, 10, 1000 + s * 1000); } // 9 s só com o mic
  await vi.waitFor(() => expect(session.alerts.has('source:sys')).toBe(true));
  expect(session.alerts.list().find((a) => a.id === 'source:sys')!.message).toContain('áudio do sistema');
  await vi.waitFor(() => expect(captures.length).toBeGreaterThanOrEqual(2)); // reiniciou
  captures.at(-1)!.emitFrames(10, 0); // a captura nova entrega as duas fontes
  await vi.waitFor(() => expect(session.alerts.has('source:sys')).toBe(false));
  await session.stop();
  const gaps = (await readMeta(dir)).gaps;
  expect(gaps).toEqual([expect.objectContaining({ reason: 'source-sys' })]);
  expect(gaps[0]!.toMs - gaps[0]!.fromMs).toBeGreaterThanOrEqual(2000);
});

test('fonte que nunca volta: depois dos reinícios o aviso vira persistente com o atalho da permissão; para ao parar a gravação', async () => {
  const { session, captures, advance } = await watched();
  await session.start({ title: 'Daily', trigger: 'manual' });
  captures[0]!.emitFrames(10, 0);
  for (let s = 0; s < 120; s++) {
    advance(1000);
    for (const c of captures) if (c === captures.at(-1)) micOnly(c, 1, s * 1000);
    await new Promise((r) => setTimeout(r, 8));
  }
  await vi.waitFor(() => {
    const a = session.alerts.list().find((x) => x.id === 'source:sys');
    expect(a?.level).toBe('error');
    expect(a?.action?.kind).toBe('open-audio-privacy');
  });
  expect(captures.length).toBeLessThanOrEqual(7); // teto de reinícios: nada de laço infinito
  await session.stop();
  expect(session.alerts.list().filter((a) => a.id.startsWith('source:'))).toEqual([]);
});

test('permissão do microfone revogada no meio: aviso com atalho, sem reiniciar em laço; ao conceder de novo, retoma', async () => {
  let status = 'granted';
  const { session, captures, advance } = await watched({ micPermission: () => status });
  await session.start({ title: 'Daily', trigger: 'manual' });
  captures[0]!.emitFrames(10, 0);
  const sysOnly = () => captures.at(-1)!.emit('frame', { source: 'sys', timestampMs: 0, pcm: Buffer.alloc(3200, 1) } satisfies AudioFrame);
  status = 'denied';
  for (let i = 0; i < 6; i++) { advance(1000); sysOnly(); await new Promise((r) => setTimeout(r, 12)); }
  await vi.waitFor(() => expect(session.alerts.list().find((a) => a.id === 'source:mic')?.action?.kind).toBe('open-mic-privacy'));
  expect(session.alerts.list().find((a) => a.id === 'source:mic')!.message).toContain('perdeu a permissão');
  const countDuring = captures.length;
  for (let i = 0; i < 20; i++) { advance(1000); sysOnly(); await new Promise((r) => setTimeout(r, 12)); }
  expect(captures.length).toBe(countDuring); // não reabre contra uma permissão negada
  status = 'granted';
  await vi.waitFor(() => expect(session.alerts.has('source:mic')).toBe(false));
  await vi.waitFor(() => expect(captures.length).toBe(countDuring + 1));
  await session.stop();
});

// ---- R-34/R-35: inatividade e gravação esquecida ----
async function timed(deps: Record<string, unknown> = {}) {
  let clock = new Date(2026, 9, 8, 14, 0, 0).getTime();
  const ctx = await setup({ now: () => new Date(clock), restartDelayMs: 1, deps: { watchdogMs: 5, freeBytes: async () => null, ...deps } });
  /** Avança o relógio simulado sem que o vigia das fontes reaja (a captura falsa entrega as duas fontes). */
  const advance = async (ms: number, step = 60_000) => {
    for (let left = ms; left > 0; left -= step) {
      clock += Math.min(step, left);
      ctx.captures.at(-1)!.emitFrames(1, 0);
      await new Promise((r) => setTimeout(r, 12));
    }
  };
  return { ...ctx, advance, clock: () => clock };
}

test('sem fala por 15 min: "Ainda gravando?" com manter/parar; falar de novo some o aviso; ignorar para sozinho com opção de retomar', async () => {
  const { session, captures, advance, pipeline } = await timed({ inactivityMs: () => 15 * 60_000, inactivityGraceMs: 2 * 60_000 });
  const attention: string[] = [];
  session.on('attention', (a: { kind: string }) => attention.push(a.kind));
  const dir = await session.start({ title: 'Daily', trigger: 'manual' });
  captures[0]!.emitFrames(10, 0); // gera uma fala (o pipeline falso transcreve a cada 10 blocos do mic)
  pipeline.speak = false;
  await advance(14 * 60_000);
  expect(session.alerts.has('idle')).toBe(false);
  await advance(2 * 60_000);
  await vi.waitFor(() => expect(session.alerts.has('idle')).toBe(true));
  const idle = session.alerts.list().find((a) => a.id === 'idle')!;
  expect(idle.action?.kind).toBe('keep-recording');
  expect(idle.secondary?.kind).toBe('stop-recording');
  expect(attention).toContain('idle');
  expect(session.state).toBe('recording'); // ainda não parou: espera a resposta
  session.keepRecording();
  expect(session.alerts.has('idle')).toBe(false);
  // de novo sem fala e sem resposta: para sozinho depois do prazo
  await advance(16 * 60_000);
  await vi.waitFor(() => expect(session.alerts.has('idle')).toBe(true));
  await advance(3 * 60_000);
  await vi.waitFor(() => expect(session.state).toBe('idle'));
  const stopped = session.alerts.list().find((a) => a.id === 'auto-stopped')!;
  expect(stopped.action?.kind).toBe('resume-recording');
  expect(stopped.dir).toBe(dir);
  expect(stopped.dismissible).toBe(true);
  expect(attention).toContain('auto-stopped');
  await session.drain();
  expect((await readMeta(dir)).state).toBe('done');
});

test('inatividade desligada (0): nunca pergunta nem para', async () => {
  const { session, captures, advance, pipeline } = await timed({ inactivityMs: () => 0 });
  await session.start({ title: 'Daily', trigger: 'manual' });
  captures[0]!.emitFrames(10, 0);
  pipeline.speak = false;
  await advance(60 * 60_000);
  expect(session.alerts.has('idle')).toBe(false);
  expect(session.state).toBe('recording');
  await session.stop();
});

test('gravação esquecida (3 h): lembra a cada 1 h, nunca para sozinha', async () => {
  const { session, captures, advance, pipeline } = await timed({ inactivityMs: () => 0 });
  const reminders: string[] = [];
  session.on('attention', (a: { kind: string; message: string }) => a.kind === 'long' && reminders.push(a.message));
  await session.start({ title: 'Daily', trigger: 'manual' });
  captures[0]!.emitFrames(10, 0);
  pipeline.speak = false;
  await advance(2 * 3_600_000 + 59 * 60_000);
  expect(reminders).toHaveLength(0);
  await advance(2 * 60_000);
  await vi.waitFor(() => expect(reminders).toHaveLength(1));
  expect(reminders[0]).toContain('3 h');
  session.keepRecording();
  expect(session.alerts.has('long')).toBe(false);
  await advance(61 * 60_000);
  await vi.waitFor(() => expect(reminders).toHaveLength(2));
  expect(session.state).toBe('recording');
  await session.stop();
  expect(session.alerts.has('long')).toBe(false);
});

// ---- R-45/R-37: prazo da fila e nova reunião durante a finalização ----
test('fila de transcrição que nunca esvazia: o prazo corta, marca o trecho final como incompleto e a reunião fecha', async () => {
  const { session, captures, pipeline } = await setup({ deps: { finishDeadlineMs: 50, freeBytes: async () => null } });
  pipeline.finish = () => new Promise<void>(() => {}); // o whisper travou
  const warnings: string[] = [];
  session.on('session-warning', (w: { message: string }) => warnings.push(w.message));
  const dir = await session.start({ title: 'Daily', trigger: 'manual' });
  captures[0]!.emitFrames(10, 0);
  await vi.waitFor(() => expect(pipeline.frames.length).toBeGreaterThan(0));
  const t0 = Date.now();
  await session.stop();
  expect(Date.now() - t0).toBeLessThan(3000);
  expect((await readMeta(dir)).state).toBe('done');
  expect(await readMeetingText(dir, 'transcript')).toMatch(/transcrição incompleta/);
  expect(warnings.some((w) => w.includes('cortada'))).toBe(true);
});

test('saída do app (quick): usa prazo curto mesmo com o padrão de 30 s', async () => {
  const { session, captures, pipeline } = await setup({ deps: { finishDeadlineMs: 60_000, freeBytes: async () => null } });
  pipeline.finish = () => new Promise<void>(() => {});
  await session.start({ title: 'Daily', trigger: 'manual' });
  captures[0]!.emitFrames(10, 0);
  const t0 = Date.now();
  await session.stop({ quick: true });
  expect(Date.now() - t0).toBeLessThan(10_000);
});

test('nova reunião começa enquanto a anterior ainda finaliza (nunca bloqueia) e drain espera as duas', async () => {
  let release!: () => void;
  const { session, captures, pipeline } = await setup({ deps: { freeBytes: async () => null } });
  pipeline.finish = () => new Promise<void>((resolve) => { release = resolve; }); // fila lenta da primeira reunião
  const first = await session.start({ title: 'Primeira', trigger: 'manual' });
  captures[0]!.emitFrames(10, 0);
  const stopping = session.stop();
  await vi.waitFor(() => expect(session.state).toBe('idle')); // já ocioso: a captura parou
  expect((await readMeta(first)).state).toBe('finishing'); // a lista mostra "finalizando"
  const second = await session.start({ title: 'Segunda', trigger: 'manual' });
  expect(second).not.toBe(first);
  expect(session.state).toBe('recording');
  expect(captures).toHaveLength(2);
  release();
  pipeline.finish = async () => {}; // a segunda reunião esvazia a fila normalmente
  await stopping;
  expect((await readMeta(first)).state).toBe('done');
  expect((await readMeta(second)).state).toBe('recording'); // a segunda segue gravando, intacta
  await session.stop();
  await session.drain();
  expect((await readMeta(second)).state).toBe('done');
});

test('retomar a mesma reunião que ainda finaliza espera só essa finalização', async () => {
  let release!: () => void;
  const { session, captures, pipeline } = await setup({ deps: { freeBytes: async () => null } });
  pipeline.finish = () => new Promise<void>((resolve) => { release = resolve; });
  const dir = await session.start({ title: 'Daily', trigger: 'manual' });
  captures[0]!.emitFrames(10, 0);
  const stopping = session.stop();
  await vi.waitFor(() => expect(session.state).toBe('idle'));
  const resumed = session.start({ title: 'Daily', trigger: 'manual', dir });
  await new Promise((r) => setTimeout(r, 30));
  expect(session.state).toBe('recording'); // reservou a sessão, mas ainda espera a finalização
  expect(captures).toHaveLength(1);
  release();
  pipeline.finish = async () => {};
  await stopping;
  expect(await resumed).toBe(dir);
  await session.stop();
});

// ---- vigia: silêncio exato do sistema é o caso normal ----
const frameOf = (source: 'mic' | 'sys', value: number): AudioFrame => ({ source, timestampMs: 0, pcm: Buffer.alloc(3200, value) });

test('10 min com o sistema em zeros exatos e o mic falando: zero reinícios, zero avisos, zero lacunas', async () => {
  const { session, captures, advance } = await watched({ inactivityMs: () => 0 });
  const dir = await session.start({ title: 'Presencial', trigger: 'manual' });
  for (let s = 0; s < 600; s++) {
    advance(1000);
    const c = captures.at(-1)!;
    c.emit('frame', { ...frameOf('mic', 3), timestampMs: s * 1000 });
    c.emit('frame', { ...frameOf('sys', 0), timestampMs: s * 1000 });
    if (s % 20 === 0) await new Promise((r) => setTimeout(r, 8)); // deixa o vigia (5 ms) rodar
  }
  await new Promise((r) => setTimeout(r, 20));
  expect(captures).toHaveLength(1); // nenhum reinício da captura (o microfone nunca é cortado)
  expect(session.alerts.list()).toEqual([]);
  await session.stop();
  expect((await readMeta(dir)).gaps).toEqual([]);
  expect(await readMeetingText(dir, 'transcript')).not.toMatch(/interrompido/);
});

test('microfone em zeros exatos (volume 0/mudo): no máximo 1 reinício e depois só um aviso discreto, não vermelho nem persistente', async () => {
  const { session, captures, advance } = await watched({ inactivityMs: () => 0 });
  await session.start({ title: 'Mudo', trigger: 'manual' });
  for (let s = 0; s < 400; s++) {
    advance(1000);
    const c = captures.at(-1)!;
    c.emit('frame', { ...frameOf('mic', 0), timestampMs: s * 1000 });
    c.emit('frame', { ...frameOf('sys', 3), timestampMs: s * 1000 });
    if (s % 10 === 0) await new Promise((r) => setTimeout(r, 8));
  }
  await new Promise((r) => setTimeout(r, 20));
  expect(captures.length).toBeLessThanOrEqual(2); // a captura original + no máximo 1 reinício
  const alert = session.alerts.list().find((a) => a.id === 'source:mic')!;
  expect(alert.level).toBe('info');
  expect(alert.dismissible).toBe(true);
  expect(alert.action).toBeUndefined();
  await session.stop();
});

test('microfone que para de entregar blocos com o sistema saudável: a lacuna é só do microfone (nenhuma do sistema)', async () => {
  const { session, captures, advance } = await watched({ inactivityMs: () => 0 });
  const dir = await session.start({ title: 'Daily', trigger: 'manual' });
  const sysOnly = (c: FakeCapture, ts: number) => c.emit('frame', { source: 'sys', timestampMs: ts, pcm: Buffer.alloc(3200, 3) } satisfies AudioFrame);
  captures[0]!.emitFrames(10, 0);
  for (let s = 0; s < 10; s++) { advance(1000); sysOnly(captures[0]!, 1000 + s * 1000); await new Promise((r) => setTimeout(r, 8)); }
  await vi.waitFor(() => expect(session.alerts.has('source:mic')).toBe(true));
  await vi.waitFor(() => expect(captures.length).toBeGreaterThanOrEqual(2));
  captures.at(-1)!.emitFrames(10, 0); // a captura nova entrega as duas fontes
  await vi.waitFor(() => expect(session.alerts.has('source:mic')).toBe(false));
  await session.stop();
  expect((await readMeta(dir)).gaps.map((g) => g.reason)).toEqual(['source-mic']);
});

// ---- Pausa (sem parar) ----
const at = (h: number, m: number, sec = 0) => new Date(2026, 9, 8, h, m, sec).getTime();

test('pausa: a captura para (nada gravado nem transcrito), o marcador sai com o horário e depois da pausa os offsets seguem o relógio', async () => {
  let clock = at(14, 3, 0);
  const { session, captures, pipeline } = await setup({ now: () => new Date(clock), deps: { freeBytes: async () => null } });
  const dir = await session.start({ title: 'Daily', trigger: 'manual' });
  const events: boolean[] = [];
  session.on('pause', (e: { paused: boolean }) => events.push(e.paused));
  captures[0]!.emitFrames(20, 0); // 2 s
  clock += 2000;
  session.pause();
  expect(session.paused).toBe(true);
  expect(session.state).toBe('recording'); // pausar não é parar
  expect(captures[0]!.stopped).toBe(1);
  expect(pipeline.flushes).toBe(1); // a fala em andamento fecha na hora
  const before = pipeline.frames.length;
  captures[0]!.emitFrames(30, 2000); // quadro atrasado da captura que parou: descartado
  clock += 4 * 60_000 - 2000; // 14:03 → 14:07
  expect(pipeline.frames.length).toBe(before);
  session.unpause();
  expect(session.paused).toBe(false);
  expect(captures).toHaveLength(2);
  expect(captures[1]!.started).toBe(1);
  captures[1]!.emitFrames(2, 0);
  expect(pipeline.frames.at(-1)!.timestampMs).toBeGreaterThanOrEqual(4 * 60_000); // horário real: 4 min depois do começo
  await vi.waitFor(async () => expect((await readMeta(dir)).gaps).toHaveLength(1));
  const gap = (await readMeta(dir)).gaps[0]!;
  expect(gap).toMatchObject({ reason: 'paused', fromMs: 2000, toMs: 4 * 60_000 });
  expect(events).toEqual([true, false]);
  await session.stop();
  const text = await readMeetingText(dir, 'transcript');
  expect(text).toContain('*[gravação pausada de 14:03 a 14:07]*');
  expect((await readMeta(dir)).state).toBe('done');
});

test('pausar e continuar sem gravar, duas vezes seguidas ou durante o repouso do Mac não faz nada de estranho', async () => {
  let clock = at(14, 0);
  const { session, captures } = await setup({ now: () => new Date(clock), deps: { freeBytes: async () => null } });
  session.pause();
  session.unpause();
  await session.start({ title: 'Daily', trigger: 'manual' });
  session.unpause(); // sem pausa
  expect(captures).toHaveLength(1);
  session.pause();
  session.pause();
  expect(captures[0]!.stopped).toBe(1);
  session.suspend(); // o Mac dorme pausado: nada a fazer
  clock += 60_000;
  session.resume();
  expect(captures).toHaveLength(1); // acordar não religa a captura de uma gravação pausada
  session.unpause();
  expect(captures).toHaveLength(2);
  await session.stop();
});

test('pausado: sem aviso de inatividade nem parada automática; ao continuar, o silêncio da pausa não conta', async () => {
  let clock = at(14, 0);
  const { session, captures } = await setup({ now: () => new Date(clock), deps: { freeBytes: async () => null, inactivityMs: () => 60_000, inactivityGraceMs: 1000, watchdogMs: 5 } });
  await session.start({ title: 'Daily', trigger: 'manual' });
  captures[0]!.emitFrames(10, 0);
  session.pause();
  clock += 20 * 60_000; // 20 min pausado, bem além do limite de inatividade
  await new Promise((r) => setTimeout(r, 60));
  expect(session.alerts.has('idle')).toBe(false);
  expect(session.state).toBe('recording');
  expect(session.paused).toBe(true);
  session.unpause();
  await new Promise((r) => setTimeout(r, 60));
  expect(session.alerts.has('idle')).toBe(false); // lastSpeechAt foi renovado
  expect(session.state).toBe('recording');
  await session.stop();
});

test('depois de 30 min pausado, pergunta se quer parar (nunca para sozinho); continuar tira o aviso', async () => {
  let clock = at(14, 0);
  const { session } = await setup({ now: () => new Date(clock), deps: { freeBytes: async () => null, watchdogMs: 5 } });
  const attention: Array<{ kind: string }> = [];
  session.on('attention', (e: { kind: string }) => attention.push(e));
  await session.start({ title: 'Daily', trigger: 'manual' });
  session.pause();
  clock += 29 * 60_000;
  await new Promise((r) => setTimeout(r, 40));
  expect(session.alerts.has('paused-long')).toBe(false);
  clock += 2 * 60_000; // 31 min
  await vi.waitFor(() => expect(session.alerts.has('paused-long')).toBe(true));
  const alert = session.alerts.list().find((a) => a.id === 'paused-long')!;
  expect(alert.message).toContain('31 min');
  expect([alert.action?.kind, alert.secondary?.kind]).toEqual(['stop-recording', 'unpause-recording']);
  expect(attention.map((a) => a.kind)).toEqual(['paused']);
  await new Promise((r) => setTimeout(r, 40));
  expect(attention).toHaveLength(1); // um aviso só
  expect(session.state).toBe('recording');
  session.unpause();
  expect(session.alerts.has('paused-long')).toBe(false);
  await session.stop();
});

test('parar pausado fecha a pausa (marcador até o fim) e finaliza a reunião normalmente', async () => {
  let clock = at(14, 0);
  const { session, captures } = await setup({ now: () => new Date(clock), deps: { freeBytes: async () => null } });
  const dir = await session.start({ title: 'Daily', trigger: 'manual' });
  captures[0]!.emitFrames(30, 0);
  clock += 3000;
  session.pause();
  clock += 5 * 60_000;
  await session.stop();
  expect(session.state).toBe('idle');
  expect(session.paused).toBe(false);
  expect(await readMeetingText(dir, 'transcript')).toContain('*[gravação pausada de 14:00 a 14:05]*');
  const meta = await readMeta(dir);
  expect(meta.state).toBe('done');
  expect(meta.gaps[0]).toMatchObject({ reason: 'paused', fromMs: 3000 });
});

test('queda durante a pausa: "Recuperar reunião" continua funcionando (o áudio fica alinhado com a linha do tempo)', async () => {
  let clock = at(14, 0);
  const { session, captures } = await setup({ now: () => new Date(clock), deps: { freeBytes: async () => null } });
  const dir = await session.start({ title: 'Daily', trigger: 'manual' });
  captures[0]!.emitFrames(30, 0);
  clock += 3000;
  session.pause();
  clock += 2 * 60_000;
  session.unpause();
  captures[1]!.emitFrames(30, 0);
  clock += 3000;
  await new Promise((r) => setTimeout(r, 300)); // os blocos do WAV chegam ao disco
  await updateMeta(dir, (m) => ({ ...m, state: 'interrupted' })); // o app caiu: ninguém chamou stop()
  const frames: AudioFrame[] = [];
  const result = await recoverMeeting(dir, {
    createPipeline: async () => Object.assign(new EventEmitter(), { pushFrame: (f: AudioFrame) => frames.push(f), finish: async () => {} }) as never,
    generateNotes: async () => {},
    language: async () => 'pt' as const,
    keepAudio: () => true,
    encode: async (_w: string, m4a: string) => { await writeFile(m4a, 'm4a'); },
  });
  expect(result.audioRecovered).toBe(true);
  expect((await readMeta(dir)).state).toBe('done');
  expect(Math.max(...frames.map((f) => f.timestampMs), 0)).toBeGreaterThan(2 * 60_000); // o áudio de depois da pausa está na linha do tempo certa
});

test('o marcador de pausa segue o estilo dos outros marcadores discretos (repouso, retomada) e vem de t() nos dois idiomas', async () => {
  const { gapMarkerLine } = await import('../../src/main/store/meeting-files');
  const start = new Date(2026, 9, 8, 14, 0, 0);
  const line = (language: 'pt-BR' | 'en', key: string) => gapMarkerLine(start, 3 * 60_000, 7 * 60_000, language, key).trim();
  expect(line('pt-BR', 'marker.paused')).toBe('*[gravação pausada de 14:03 a 14:07]*');
  expect(line('en', 'marker.paused')).toBe('*[recording paused from 14:03 to 14:07]*');
  // mesma forma do marcador de repouso: asteriscos + colchetes, "gravação pausada de … a …"
  expect(line('pt-BR', 'marker.sleep')).toMatch(/^\*\[gravação pausada de 14:03 a 14:07 — /);
  expect(line('en', 'marker.sleep')).toMatch(/^\*\[recording paused from 14:03 to 14:07 — /);
});

describe('escolha do microfone (Mac)', () => {
  it('prepareCapture roda ANTES de abrir a captura; falha dele não impede de gravar', async () => {
    const order: string[] = [];
    const { session, captures } = await setup({ deps: { prepareCapture: async () => { await new Promise((r) => setTimeout(r, 30)); order.push('prepare'); } }, makeCapture: () => { order.push('capture'); return new FakeCapture(); } });
    await session.start({ title: 'Mic', trigger: 'manual' });
    expect(order).toEqual(['prepare', 'capture']);
    expect(captures[0]!.started).toBe(1);
    await session.stop();
    const failing = await setup({ deps: { prepareCapture: async () => { throw new Error('detector fora'); } } });
    await failing.session.start({ title: 'Mic 2', trigger: 'manual' });
    expect(failing.captures[0]!.started).toBe(1);
    await failing.session.stop();
  });

  it('switchMic repassa a troca à captura em andamento (vazio = padrão do macOS) e não faz nada parado', async () => {
    const { session, captures } = await setup(true);
    session.switchMic('uid-x'); // parado: nada
    await session.start({ title: 'Mic', trigger: 'manual' });
    session.switchMic('uid-fifine');
    session.switchMic(undefined);
    expect(captures[0]!.micDevices).toEqual(['uid-fifine', undefined]);
    await session.stop();
  });
});

describe('parar nunca trava (prazos duros e nenhum helper órfão)', () => {
  const fast = { captureStopMs: 60, stepDeadlineMs: 80, writesDeadlineMs: 80, finishDeadlineMs: 80 };

  it('captura que não responde ao stop: stop() resolve no prazo, avisa e a reunião fecha', async () => {
    const warnings: string[] = [];
    const { session, captures } = await setup({ deps: fast, makeCapture: () => { const c = new FakeCapture(); c.stop = () => new Promise<void>(() => {}); return c; } });
    session.on('session-warning', (w: string) => warnings.push(String(w)));
    session.on('warning', (w: string) => warnings.push(String(w)));
    const dir = await session.start({ title: 'Trava captura', trigger: 'manual' });
    const t0 = Date.now();
    await session.stop();
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(captures[0]!.killed).toBeGreaterThan(0); // e o helper é morto na marra
    expect((await readMeta(dir)).state).toBe('done');
  });

  it('TODA captura criada na gravação é parada e morta ao parar (reiniciadas ou que escaparam), inclusive uma que o stop normal não alcança', async () => {
    const { session, captures } = await setup({ restartDelayMs: 1, deps: fast });
    await session.start({ title: 'Órfãos', trigger: 'manual' });
    session.suspend();
    session.resume(); // 2ª captura; a 1ª já foi mandada parar, mas pode seguir viva
    session.suspend();
    session.resume(); // 3ª
    expect(captures.length).toBeGreaterThanOrEqual(3);
    await session.stop();
    for (const c of captures) expect(c.killed).toBeGreaterThan(0);
  });

  it('frames que chegam depois de parar são descartados (nem WAV nem pipeline)', async () => {
    const { session, captures, pipeline } = await setup(true);
    await session.start({ title: 'Depois do stop', trigger: 'manual' });
    captures[0]!.emitFrames(3, 0);
    await session.stop();
    const before = pipeline.frames.length;
    captures[0]!.emitFrames(50, 5000); // um helper que escapou continua mandando
    expect(pipeline.frames.length).toBe(before);
  });

  it('escrita da transcrição que nunca termina não trava o stop(): estoura o prazo, marca incompleta e fecha', async () => {
    const { session, captures } = await setup({ deps: fast });
    const dir = await session.start({ title: 'Escrita travada', trigger: 'manual' });
    const internals = session as unknown as { active: { writes: Promise<void> } };
    internals.active.writes = new Promise<void>(() => {}); // uma escrita que nunca resolve
    captures[0]!.emitFrames(2, 0);
    const t0 = Date.now();
    await session.stop();
    expect(Date.now() - t0).toBeLessThan(3000);
    expect((await readMeta(dir)).state).toBe('done');
  });

  it('codificação do áudio que trava (afconvert) tem prazo: o WAV fica e o stop() resolve', async () => {
    const { session } = await setup({ keepAudio: true, deps: { ...fast, encodeDeadlineMs: 100 }, encode: () => new Promise<void>(() => {}) });
    const dir = await session.start({ title: 'Encode travado', trigger: 'manual' });
    const t0 = Date.now();
    await session.stop();
    expect(Date.now() - t0).toBeLessThan(3000);
    expect((await readMeta(dir)).state).toBe('done');
  }, 15000);
});
