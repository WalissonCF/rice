import { resolve } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { AudioCapture } from '../../src/main/session/audio-capture';
import type { AudioFrame } from '../../src/shared/frames';

const FAKE = resolve(__dirname, '../fixtures/fake-rice-audio.mjs');
const live: AudioCapture[] = [];
afterEach(async () => {
  await Promise.all(live.splice(0).map((c) => c.stop(500)));
  delete process.env.FAKE_AUDIO_MODE;
});

function capture(mode: string) {
  process.env.FAKE_AUDIO_MODE = mode;
  const c = new AudioCapture(FAKE);
  live.push(c);
  const frames: AudioFrame[] = [];
  const events: Array<Record<string, unknown>> = [];
  const exits: Array<{ code: number | null; expected: boolean }> = [];
  c.on('frame', (f: AudioFrame) => frames.push(f));
  c.on('event', (e: Record<string, unknown>) => events.push(e));
  c.on('exit', (e: { code: number | null; expected: boolean }) => exits.push(e));
  return { c, frames, events, exits };
}

const until = async (cond: () => boolean, ms = 3000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
};

test('decodifica frames das duas fontes e repassa eventos', async () => {
  const { c, frames, events, exits } = capture('ok');
  c.start();
  await until(() => frames.length === 10);
  expect(frames.filter((f) => f.source === 'mic')).toHaveLength(5);
  expect(events[0]).toEqual({ event: 'started', mic: true, sys: true });
  await c.stop();
  expect(events.at(-1)).toEqual({ event: 'stopped' });
  expect(exits).toEqual([expect.objectContaining({ code: 0, expected: true })]);
});

test('ignora linhas de stderr que não são JSON', async () => {
  const { c, events } = capture('garbage-stderr');
  c.start();
  await until(() => events.length > 0);
  expect(events[0]!.event).toBe('started');
});

test('fatal + saída inesperada são reportados', async () => {
  const { c, events, exits } = capture('fatal');
  c.start();
  await until(() => exits.length === 1);
  expect(events.some((e) => e.fatal === true)).toBe(true);
  expect(exits[0]).toEqual(expect.objectContaining({ code: 3, expected: false }));
});

test('frame inválido emite decode-error e encerra o processo', async () => {
  const { c, exits } = capture('bad-frame');
  const errors: Error[] = [];
  c.on('decode-error', (e: Error) => errors.push(e));
  c.start();
  await until(() => errors.length === 1 && exits.length === 1);
  expect(errors[0]!.message).toContain('invalid frame source byte');
});

test('stop mata com SIGKILL se o processo ignorar o stop', async () => {
  const { c, exits } = capture('hang-on-stop');
  c.start();
  const t0 = Date.now();
  await c.stop(300);
  expect(Date.now() - t0).toBeLessThan(2000);
  expect(exits[0]).toEqual(expect.objectContaining({ expected: true }));
});

test('stop é idempotente e funciona sem start', async () => {
  const { c } = capture('ok');
  await c.stop();
  await c.stop();
});

test('setMicDevice troca o microfone no meio: o comando mic-device chega ao helper (uid vazio = padrão) e o evento volta', async () => {
  const { c, events } = capture('ok');
  c.start();
  await until(() => events.some((e) => e.event === 'started'));
  c.setMicDevice('uid-fifine');
  await until(() => events.some((e) => e.event === 'mic-device'));
  expect(events.find((e) => e.event === 'mic-device')).toMatchObject({ id: 'uid-fifine', chosen: true, reason: 'switched' });
  c.setMicDevice();
  await until(() => events.filter((e) => e.event === 'mic-device').length === 2);
  expect(events.filter((e) => e.event === 'mic-device')[1]).toMatchObject({ isDefault: true, chosen: false });
  await c.stop();
});

test('trocar o microfone várias vezes não acumula ouvintes (nem no capture nem no stdin do helper)', async () => {
  const { c, events } = capture('ok');
  c.start();
  await until(() => events.some((e) => e.event === 'started'));
  const listeners = c.eventNames().map((n) => c.listenerCount(n));
  for (let i = 0; i < 40; i++) c.setMicDevice(i % 2 ? 'uid-a' : undefined);
  await until(() => events.filter((e) => e.event === 'mic-device').length >= 40, 5000);
  expect(c.eventNames().map((n) => c.listenerCount(n))).toEqual(listeners);
  await c.stop();
});

test('players de música vão como --exclude-pid antes do Rice (o Windows só exclui o primeiro)', async () => {
  process.env.FAKE_AUDIO_MODE = 'echo-args';
  const c = new AudioCapture(FAKE, [4321, 4322]);
  live.push(c);
  const events: Array<Record<string, unknown>> = [];
  c.on('event', (e: Record<string, unknown>) => events.push(e));
  c.start();
  await until(() => events.some((e) => e.event === 'args'));
  expect(events.find((e) => e.event === 'args')!.argv).toEqual(['--exclude-pid', '4321', '--exclude-pid', '4322', '--exclude-pid', String(process.pid)]);
});
