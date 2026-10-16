import { execFile, execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, test } from 'vitest';
import { FrameDecoder, type AudioFrame } from '../../src/shared/frames';
import { AudioCapture } from '../../src/main/session/audio-capture';
import { DetectorClient } from '../../src/main/session/detector-client';
import { listWindowsWin } from '../../src/main/screenshots/win-windows';
import { parseMicDeviceEvent, parseMicInputs } from '../../src/main/platform/mic-input';
import { chooseTarget, findWindowSource } from '../../src/main/screenshots/target';

// Os helpers C++ (native/win) contra o contrato gravado do Swift. No CI do Windows, RICE_WIN_BIN_DIR aponta para os .exe
// compilados com MSVC; nos demais sistemas o teste compila a parte portável com o c++ do sistema (e pula se não houver).
const run = promisify(execFile);
const WIN = resolve(__dirname, '../../native/win');
const FIX = resolve(__dirname, '../fixtures/protocol');
const exe = process.platform === 'win32' ? '.exe' : '';

let audio = '';
let detector = '';
let skip = false;

beforeAll(async () => {
  const dir = process.env.RICE_WIN_BIN_DIR;
  if (dir) {
    audio = join(dir, `rice-audio${exe}`);
    detector = join(dir, `rice-detector${exe}`);
    return;
  }
  try {
    execFileSync('c++', ['--version'], { stdio: 'ignore' });
  } catch {
    skip = true;
    return;
  }
  const out = mkdtempSync(join(tmpdir(), 'rice-win-bin-')); // fica entre os testes
  const common = ['common/json', 'common/events', 'common/framing', 'common/chunker', 'common/resampler'].map((f) => `${WIN}/${f}.cpp`);
  const flags = ['-std=c++17', '-O1', '-pthread'];
  audio = join(out, 'rice-audio');
  detector = join(out, 'rice-detector');
  const core = ['echo_canceller', 'recorder', 'selftests', 'sinks', 'simulated_platform', 'output_classify', 'mic_device', 'main'].map((f) => `${WIN}/audio/${f}.cpp`);
  await run('c++', [...flags, ...common, ...core, '-o', audio], { maxBuffer: 64 * 1024 * 1024 });
  const det = ['app_matcher', 'mic_watcher', 'mic_monitor', 'window_list', 'discord_voice', 'main'].map((f) => `${WIN}/detector/${f}.cpp`);
  await run('c++', [...flags, ...common, ...det, '-o', detector], { maxBuffer: 64 * 1024 * 1024 });
}, 300_000);

const bytes = (name: string) => readFileSync(join(FIX, name));
const samples = (frames: AudioFrame[]) => {
  const all = Buffer.concat(frames.map((f) => f.pcm));
  return new Int16Array(all.buffer.slice(all.byteOffset, all.byteOffset + all.length));
};
const rms = (s: Int16Array) => Math.sqrt(s.reduce((a, v) => a + v * v, 0) / s.length);

describe('testes C++ do núcleo portável', () => {
  // No Windows quem roda isto é o ctest do CI (build/win/rice_tests).
  test.skipIf(skip || process.platform === 'win32')('native/win/run-tests.sh passa', async () => {
    const { stderr } = await run('bash', [join(WIN, 'run-tests.sh')], { maxBuffer: 16 * 1024 * 1024 }).catch((e) => {
      throw new Error(String(e.stderr ?? e));
    });
    expect(stderr).toMatch(/\d+ testes, 0 falhas/);
  }, 180_000);
});

describe('rice-audio (C++) contra o Swift', () => {
  test.skipIf(skip)('--selftest-gap é idêntico bit a bit, com o mesmo evento no stderr', async () => {
    const { stdout, stderr } = await run(audio, ['--selftest-gap'], { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 });
    expect(Buffer.compare(stdout, bytes('gap.bin'))).toBe(0);
    expect(stderr.toString().trim()).toBe(bytes('gap.stderr').toString().trim());
  });

  test.skipIf(skip)('--selftest-tone: mesma estrutura de frames e o mesmo sinal que o Swift', async () => {
    const { stdout } = await run(audio, ['--selftest-tone'], { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 });
    const mine = new FrameDecoder().push(stdout);
    const swift = new FrameDecoder().push(bytes('tone.bin'));
    for (const source of ['mic', 'sys'] as const) {
      const a = mine.filter((f) => f.source === source);
      const b = swift.filter((f) => f.source === source);
      expect(a.length).toBe(b.length);
      a.forEach((f, i) => expect(f.timestampMs).toBe(i * 100));
      for (const f of a.slice(0, -1)) expect(f.pcm.length).toBe(3200);
      const x = samples(a);
      const y = samples(b);
      let max = 0;
      for (let i = 100; i < Math.min(x.length, y.length) - 200; i++) max = Math.max(max, Math.abs(x[i]! - y[i]!));
      expect(max).toBeLessThan(330);
      expect(Math.abs(rms(x) - 11585)).toBeLessThan(400);
    }
  });

  test.skipIf(skip)('comandos inválidos e desconhecidos geram erro no stderr e stop sai com 0', async () => {
    const { spawn } = await import('node:child_process');
    const child = spawn(audio, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    child.stdin.write('lixo\n{"cmd":"dançar"}\n');
    await new Promise((r) => setTimeout(r, 300));
    expect(child.exitCode).toBeNull();
    const exited = new Promise<number | null>((res) => child.once('exit', (c) => res(c)));
    child.stdin.write('{"cmd":"stop"}\n');
    expect(await exited).toBe(0);
    expect(stderr).toContain('"message":"invalid command line"');
    expect(stderr).toContain('unknown command: dançar');
  });

  test.skipIf(skip)('o AudioCapture real do main grava com o helper simulado: frames das duas fontes, started/stopped, saída esperada', async () => {
    process.env.RICE_AUDIO_SIMULATE = '1';
    const capture = new AudioCapture(audio);
    const frames: AudioFrame[] = [];
    const events: string[] = [];
    capture.on('frame', (f: AudioFrame) => frames.push(f));
    capture.on('event', (e: { event: string }) => events.push(e.event));
    const exit = new Promise<{ code: number | null; expected: boolean }>((res) => capture.once('exit', res));
    capture.start();
    await new Promise((r) => setTimeout(r, 1500));
    await capture.stop();
    const result = await exit;
    delete process.env.RICE_AUDIO_SIMULATE;
    expect(result).toMatchObject({ code: 0, expected: true });
    expect(events).toContain('started');
    expect(events).toContain('stopped');
    for (const source of ['mic', 'sys'] as const) {
      const ts = frames.filter((f) => f.source === source).map((f) => f.timestampMs);
      expect(ts.length).toBeGreaterThanOrEqual(10);
      ts.slice(1).forEach((t, i) => expect(t - ts[i]!).toBe(100));
    }
  });
});

describe('rice-detector (C++) contra o Swift', () => {
  const doc = JSON.parse(readFileSync(join(FIX, 'detector.json'), 'utf8')) as {
    match: Array<{ input: string; output: { app: string | null } }>;
    simulateMic: Array<{ input: string[][]; output: unknown[] }>;
  };

  test.skipIf(skip)('--match dá o mesmo app para cada id gravado do Swift', async () => {
    for (const c of doc.match) {
      const { stdout } = await run(detector, ['--match', c.input]);
      expect(JSON.parse(stdout), c.input).toEqual(c.output);
    }
  });

  test.skipIf(skip)('--simulate-mic gera exatamente os eventos do Swift', async () => {
    for (const c of doc.simulateMic) {
      const { stdout } = await run(detector, ['--simulate-mic', JSON.stringify(c.input)]);
      expect(stdout.trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))).toEqual(c.output);
    }
  });

  test.skipIf(skip)('o DetectorClient real recebe mic-in-use/ended do helper simulado; agenda e lembretes respondem vazio', async () => {
    process.env.RICE_DETECTOR_FAKE_MIC_STEPS = '[["chrome.exe"],["chrome.exe"],[]]';
    process.env.RICE_DETECTOR_FAKE_MIC_INTERVAL_MS = '100';
    const client = new DetectorClient(detector, { releaseDebounceMs: 50 });
    const seen: string[] = [];
    client.on('meeting-app-started', (e: { app: string }) => seen.push(`started:${e.app}`));
    client.on('meeting-app-ended', (e: { app: string }) => seen.push(`ended:${e.app}`));
    client.start();
    try {
      await new Promise((r) => setTimeout(r, 800));
      expect(seen).toEqual(['started:Google Chrome', 'ended:Google Chrome']);
      expect(await client.currentEvent()).toBeNull();
      expect(await client.listEvents(new Date(), new Date(Date.now() + 86_400_000))).toEqual([]);
      expect(await client.listReminders()).toEqual([]);
      expect(await client.completeReminder('x')).toBe(false);
    } finally {
      client.stop();
      delete process.env.RICE_DETECTOR_FAKE_MIC_STEPS;
      delete process.env.RICE_DETECTOR_FAKE_MIC_INTERVAL_MS;
    }
  });
});

describe('rice-audio (C++): microfone escolhido', () => {
  test.skipIf(skip)('--list-inputs imprime a lista de entradas que o app lê (simulado: uma entrada padrão)', async () => {
    const { stdout } = await run(audio, ['--list-inputs', '--simulate-capture']);
    expect(parseMicInputs(stdout)).toEqual([{ id: 'sim-default', name: 'Microfone simulado', isDefault: true, state: 'active' }]);
  });

  test.skipIf(skip)('o AudioCapture real recebe mic-device ao abrir; RICE_MIC_DEVICE desconhecido cai no padrão; sem a variável segue o padrão', async () => {
    process.env.RICE_AUDIO_SIMULATE = '1';
    const run1 = async (device: string | undefined) => {
      if (device) process.env.RICE_MIC_DEVICE = device;
      else delete process.env.RICE_MIC_DEVICE;
      const capture = new AudioCapture(audio);
      const seen: Array<ReturnType<typeof parseMicDeviceEvent>> = [];
      const events: string[] = [];
      capture.on('event', (e: { event: string }) => {
        events.push(e.event);
        seen.push(parseMicDeviceEvent(e));
      });
      capture.start();
      await new Promise((r) => setTimeout(r, 600));
      await capture.stop();
      return { mic: seen.filter(Boolean), events };
    };
    try {
      for (const device of [undefined, 'um-id-que-nao-existe']) {
        const r = await run1(device);
        expect(r.mic).toEqual([{ id: 'sim-default', name: 'Microfone simulado', isDefault: true, chosen: false, reason: 'open' }]);
        expect(r.events).toContain('started'); // os eventos existentes continuam
      }
    } finally {
      delete process.env.RICE_AUDIO_SIMULATE;
      delete process.env.RICE_MIC_DEVICE;
    }
  });
});

describe('rice-audio (C++): AEC', () => {
  // No CI do Windows (RICE_EXPECT_AEC=1) o .exe TEM de trazer o AEC3; nos outros ambientes sem o APM, o selftest avisa em JSON.
  test.skipIf(skip)('--selftest-aec: com AEC o eco sintético cai >= 15 dB e a voz fica; sem AEC, erro explícito', async () => {
    const { stdout } = await run(audio, ['--selftest-aec']);
    const r = JSON.parse(stdout.trim().split(/\r?\n/).pop()!) as { error?: string; reductionDb?: number; voiceLossDb?: number };
    if (r.error) {
      expect(process.env.RICE_EXPECT_AEC, `AEC esperado neste build, mas: ${r.error}`).toBeUndefined();
      expect(r.error).toMatch(/AEC3 não incluído/);
      return;
    }
    expect(r.reductionDb!).toBeGreaterThanOrEqual(15);
    expect(r.voiceLossDb!).toBeLessThan(6);
  });
});

describe('rice-detector (C++): lista de janelas', () => {
  const FAKE = JSON.stringify([
    { id: 101, owner: 'x', pid: 10, exe: 'chrome.exe', title: 'Docs - Google Chrome', x: 0, y: 0, w: 1000, h: 700, monitor: 1, mx: 0, my: 0, mw: 1920, mh: 1080 },
    { id: 102, owner: 'x', pid: 10, exe: 'chrome.exe', title: 'Meet - abc-defg-hij - Google Chrome', x: 2000, y: 40, w: 1400, h: 900, monitor: 2, mx: 1920, my: 0, mw: 2560, mh: 1440 },
    { id: 103, owner: 'x', pid: 20, exe: 'Code.exe', title: 'main.cpp', x: 0, y: 0, w: 800, h: 600, monitor: 1, mx: 0, my: 0, mw: 1920, mh: 1080 },
    { id: 104, owner: 'x', pid: 30, exe: 'Zoom.exe', title: 'Zoom Meeting', x: 100, y: 100, w: 1280, h: 720, monitor: 1, mx: 0, my: 0, mw: 1920, mh: 1080 },
  ]);

  test.skipIf(skip)('--list-windows --app filtra pelo nome do app do detector e preserva a ordem (da frente para trás)', async () => {
    const { stdout } = await run(detector, ['--list-windows', '--app', 'Google Chrome', '--fake-windows', FAKE]);
    const list = JSON.parse(stdout) as Array<{ id: number; owner: string; title: string; w: number }>;
    expect(list.map((w) => w.id)).toEqual([101, 102]);
    expect(list.every((w) => w.owner === 'Google Chrome')).toBe(true);
    expect(list[1]).toMatchObject({ title: 'Meet - abc-defg-hij - Google Chrome', w: 1400, monitor: 2, mx: 1920 });
  });

  test.skipIf(skip)('--list-windows aceita --exe e --pid, e sem filtro devolve todas', async () => {
    const byExe = JSON.parse((await run(detector, ['--list-windows', '--exe', 'zoom.exe', '--fake-windows', FAKE])).stdout);
    expect(byExe.map((w: { id: number }) => w.id)).toEqual([104]);
    const byPid = JSON.parse((await run(detector, ['--list-windows', '--pid', '20', '--fake-windows', FAKE])).stdout);
    expect(byPid.map((w: { id: number }) => w.id)).toEqual([103]);
    const all = JSON.parse((await run(detector, ['--list-windows', '--fake-windows', FAKE])).stdout);
    expect(all).toHaveLength(4);
  });

  test.skipIf(skip)('o comando list-windows no stdin responde windows-list sem mexer nos eventos existentes', async () => {
    const child = spawn(detector, [], { env: { ...process.env, RICE_DETECTOR_FAKE_WINDOWS: FAKE, RICE_DETECTOR_FAKE_MIC_STEPS: '[]' }, stdio: ['pipe', 'pipe', 'ignore'] });
    const lines: Array<Record<string, unknown>> = [];
    let buffer = '';
    child.stdout.on('data', (d: Buffer) => {
      buffer += d.toString();
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) lines.push(JSON.parse(line));
      }
    });
    try {
      child.stdin.write('{"cmd":"list-windows","apps":["Zoom"]}\n');
      for (let i = 0; i < 50 && !lines.some((l) => l.event === 'windows-list'); i++) await new Promise((r) => setTimeout(r, 50));
      const reply = lines.find((l) => l.event === 'windows-list') as { windows: Array<{ id: number }> };
      expect(reply.windows.map((w) => w.id)).toEqual([104]);
      expect(lines.filter((l) => l.event !== 'windows-list').map((l) => l.event).sort()).toEqual(['calendar-access', 'reminders-access']);
    } finally {
      child.stdin.end();
      child.kill();
    }
  });

  test.skipIf(skip)('listWindowsWin (o que o grab usa) lê o helper real e converte para DIP; o helper ausente cai em lista vazia', async () => {
    process.env.RICE_DETECTOR_FAKE_WINDOWS = FAKE;
    try {
      const wins = await listWindowsWin(['Google Chrome'], detector, (r) => ({ x: r.x / 2, y: r.y / 2, width: r.width / 2, height: r.height / 2 }));
      expect(wins.map((w) => w.id)).toEqual([101, 102]);
      expect(wins[1]!.bounds).toEqual({ x: 1000, y: 20, width: 700, height: 450 });
      // ...e a escolha: com outra pessoa mostrando algo, a janela da aba da chamada, na tela 2 (já em DIP).
      const target = chooseTarget({
        windows: wins,
        displays: [{ id: 1, bounds: { x: 0, y: 0, width: 960, height: 540 } }, { id: 2, bounds: { x: 960, y: 0, width: 1280, height: 720 } }],
        apps: ['Google Chrome'], cursorDisplayId: 1, primaryDisplayId: 1, preferWindow: true,
      });
      expect(target).toEqual({ kind: 'window', windowId: 102, displayId: 2 });
      expect(findWindowSource([{ id: 'window:101:0', name: 'a' }, { id: 'window:102:0', name: 'b' }], { id: 102, title: 'x' })?.name).toBe('b');
      expect(await listWindowsWin([], detector, (r) => r)).toEqual([]);
      expect(await listWindowsWin(['Zoom'], join(tmpdir(), 'nao-existe-rice-detector'), (r) => r)).toEqual([]);
    } finally {
      delete process.env.RICE_DETECTOR_FAKE_WINDOWS;
    }
  });
});
