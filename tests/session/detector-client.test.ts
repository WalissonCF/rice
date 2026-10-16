import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { DetectorClient } from '../../src/main/session/detector-client';

const FAKE = resolve(__dirname, '../fixtures/fake-rice-detector.mjs');
const clients: DetectorClient[] = [];
afterEach(() => {
  clients.splice(0).forEach((c) => c.stop());
  delete process.env.FAKE_DETECTOR_SCRIPT;
  delete process.env.FAKE_DETECTOR_CURRENT;
  delete process.env.FAKE_DETECTOR_LIST;
  delete process.env.FAKE_DETECTOR_EXIT_AFTER_MS;
});

function client(script: Array<{ at: number; line: object }>, current?: object, debounce = 300, backoff?: number[]) {
  process.env.FAKE_DETECTOR_SCRIPT = JSON.stringify(script);
  if (current) process.env.FAKE_DETECTOR_CURRENT = JSON.stringify(current);
  const c = new DetectorClient(FAKE, { releaseDebounceMs: debounce, restartBackoffMs: backoff });
  clients.push(c);
  const seen: Array<[string, unknown, number]> = [];
  for (const name of ['meeting-app-started', 'meeting-app-ended', 'upcoming', 'calendar-access', 'default-input', 'exit']) c.on(name, (p) => seen.push([name, p, Date.now()]));
  c.start();
  return { c, seen };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const zoomIn = { event: 'mic-in-use', app: 'Zoom', bundleId: 'us.zoom.xos' };
const zoomOut = { event: 'mic-released', app: 'Zoom', bundleId: 'us.zoom.xos' };
const sentinel = (at: number) => ({ at, line: { event: 'calendar-access', status: 'granted' } });
const names = (seen: Array<[string, unknown, number]>) => seen.map(([n]) => n).filter((n) => n !== 'calendar-access');
const waitSentinel = (seen: Array<[string, unknown, number]>) =>
  vi.waitFor(() => expect(seen.some(([n]) => n === 'calendar-access')).toBe(true), { timeout: 5000 });

test('in-use repetido (restart do detector) não duplica', async () => {
  const { seen } = client([{ at: 10, line: zoomIn }, { at: 30, line: zoomIn }, sentinel(50)]);
  await waitSentinel(seen);
  expect(names(seen)).toEqual(['meeting-app-started']);
  expect(seen[0]!.slice(0, 2)).toEqual(['meeting-app-started', { app: 'Zoom', bundleId: 'us.zoom.xos' }]);
});

test('released só vira ended após o debounce', async () => {
  const { seen } = client([{ at: 10, line: zoomIn }, { at: 30, line: zoomOut }, sentinel(31)], undefined, 300);
  await waitSentinel(seen);
  expect(names(seen)).toEqual(['meeting-app-started']);
  const observed = seen.find(([n]) => n === 'calendar-access')![2];
  await vi.waitFor(() => expect(names(seen)).toEqual(['meeting-app-started', 'meeting-app-ended']), { timeout: 5000 });
  const ended = seen.find(([n]) => n === 'meeting-app-ended')![2];
  expect(ended - observed).toBeGreaterThanOrEqual(290);
});

test('released seguido de in-use dentro do debounce cancela o fim', async () => {
  const { seen } = client([{ at: 10, line: zoomIn }, { at: 30, line: zoomOut }, { at: 80, line: zoomIn }, sentinel(100)], undefined, 300);
  await waitSentinel(seen);
  await sleep(450);
  expect(names(seen)).toEqual(['meeting-app-started']);
});

test('upcoming deduplicado por id, inválidos descartados, e currentEvent', async () => {
  const ev = { event: 'upcoming-event', id: 'e1', title: 'Daily', start: 's', end: 'e', url: null };
  const bad = { event: 'upcoming-event', id: 'e2', title: 'x' };
  const { c, seen } = client([{ at: 10, line: ev }, { at: 20, line: ev }, { at: 25, line: bad }, sentinel(40)], {
    event: 'current-event', id: 'e1', title: 'Daily', start: 's', end: 'e', url: null,
  });
  await waitSentinel(seen);
  expect(seen.filter(([n]) => n === 'upcoming')).toHaveLength(1);
  const [a, b] = await Promise.all([c.currentEvent(), c.currentEvent()]);
  expect(a).toEqual({ id: 'e1', title: 'Daily', start: 's', end: 'e', url: null });
  expect(b).toEqual(a);
});

test('calendar-access com status inválido é ignorado', async () => {
  const { seen } = client([{ at: 10, line: { event: 'calendar-access', status: 'bogus' } }, sentinel(30)]);
  await waitSentinel(seen);
  expect(seen.filter(([n]) => n === 'calendar-access')).toHaveLength(1);
});

test('currentEvent sem evento devolve null', async () => {
  const { c } = client([]);
  expect(await c.currentEvent()).toBeNull();
});

test('stop() seguido de start() usa o novo processo', async () => {
  const { c } = client([], { event: 'current-event', id: 'e1', title: 'D', start: 's', end: 'e', url: null });
  c.stop();
  c.start();
  expect(await c.currentEvent()).toEqual({ id: 'e1', title: 'D', start: 's', end: 'e', url: null });
});

test('stop() resolve currentEvent pendente com null', async () => {
  const { c } = client([]);
  const p = c.currentEvent();
  c.stop();
  expect(await p).toBeNull();
});

test('crash emite exit, reinicia com backoff e mantém dedupe', async () => {
  process.env.FAKE_DETECTOR_EXIT_AFTER_MS = '150';
  const { seen } = client([{ at: 10, line: zoomIn }], undefined, 300, [30]);
  await vi.waitFor(() => expect(seen.filter(([n]) => n === 'exit').length).toBeGreaterThanOrEqual(2), { timeout: 5000 });
  expect(seen.find(([n]) => n === 'exit')![1]).toEqual({ code: 1 });
  expect(seen.filter(([n]) => n === 'meeting-app-started')).toHaveLength(1);
});

test('listEvents: devolve os eventos da lista, com dia inteiro, calendário e cor; "calendar-changed" é repassado', async () => {
  process.env.FAKE_DETECTOR_LIST = JSON.stringify([
    { id: 'a@1', title: 'Treinar', start: '2026-10-17T03:00:00Z', end: '2026-10-18T03:00:00Z', allDay: true, calendar: 'Pessoal', color: '#33AA66', attendees: 0 },
    { id: 'b@1', title: 'Daily', start: '2026-10-17T12:00:00Z', end: '2026-10-17T12:30:00Z', url: 'https://meet.google.com/x', allDay: false, calendar: 'Trabalho', attendees: 3 },
    { id: '', title: 'sem id' },
  ]);
  const { c, seen } = client([{ at: 100, line: { event: 'calendar-changed' } }]);
  await waitSentinel(seen).catch(() => {});
  const events = await c.listEvents(new Date('2026-10-17T00:00:00Z'), new Date('2026-10-24T00:00:00Z'));
  expect(events.map((e) => [e.id, e.allDay, e.calendar, e.color ?? null, e.attendees, e.url])).toEqual([
    ['a@1', true, 'Pessoal', '#33AA66', 0, null],
    ['b@1', false, 'Trabalho', null, 3, 'https://meet.google.com/x'],
  ]);
});

test('listEvents sem detector rodando devolve lista vazia', async () => {
  const c = new DetectorClient(FAKE);
  expect(await c.listEvents(new Date(), new Date())).toEqual([]);
});

test('listEvents manda from/to sem milissegundos (o detector nativo não lia "…:00.000Z" e começava a lista em "agora", escondendo o dia inteiro de hoje)', async () => {
  process.env.FAKE_DETECTOR_LIST = '[]';
  const { c } = client([]);
  let sent = '';
  const child = (c as any).child;
  const write = child.stdin.write.bind(child.stdin);
  child.stdin.write = (chunk: string) => ((sent += chunk), write(chunk));
  await c.listEvents(new Date('2026-10-10T03:00:00.000Z'), new Date('2026-10-18T03:00:00.000Z'));
  expect(JSON.parse(sent)).toEqual({ cmd: 'list-events', from: '2026-10-10T03:00:00Z', to: '2026-10-18T03:00:00Z' });
});

test('default-input (opcional, só Mac): guarda o nome do microfone e avisa a cada troca; sem o evento nada muda', async () => {
  const fixture = JSON.parse(readFileSync(resolve(__dirname, '../fixtures/protocol/default-input.json'), 'utf8')) as { events: object[] };
  const { c, seen } = client([...fixture.events.map((line, i) => ({ at: 10 + i * 20, line })), sentinel(100)]);
  const devices: unknown[] = [];
  c.on('default-input', (d) => devices.push(d));
  expect(c.inputDevice).toBeNull();
  await waitSentinel(seen);
  expect(devices).toEqual([
    { id: 'BuiltInMicrophoneDevice', name: 'Microfone do MacBook Pro' },
    { id: 'AppleUSBAudioEngine:Unknown Manufacturer:fifine Microphone:3100000:2', name: 'fifine Microphone' },
    null,
  ]);
  expect(c.inputDevice).toBeNull(); // o último evento tinha nulos
});

test('listInputs: as entradas do CoreAudio chegam pelo evento inputs; sem resposta, null depois do prazo', async () => {
  process.env.FAKE_DETECTOR_INPUTS = JSON.stringify([{ id: 'u1', name: 'MacBook Pro Microphone', transport: 'builtin', isDefault: true, inUse: false }]);
  const { c, seen } = client([sentinel(10)]);
  await waitSentinel(seen);
  expect(await c.listInputs(2000)).toEqual({ event: 'inputs', inputs: [{ id: 'u1', name: 'MacBook Pro Microphone', transport: 'builtin', isDefault: true, inUse: false }] });
  delete process.env.FAKE_DETECTOR_INPUTS;
});

test('listInputs sem resposta do detector devolve null (o início da gravação não espera)', async () => {
  const { c, seen } = client([sentinel(10)]);
  await waitSentinel(seen);
  const t0 = Date.now();
  expect(await c.listInputs(300)).toBeNull();
  expect(Date.now() - t0).toBeLessThan(1000);
});

test('listInputs repetido (com e sem resposta) não deixa ouvintes pendurados', async () => {
  process.env.FAKE_DETECTOR_INPUTS = JSON.stringify([{ id: 'u1', name: 'Mic', transport: 'builtin', isDefault: true, inUse: false }]);
  const { c, seen } = client([sentinel(10)]);
  await waitSentinel(seen);
  for (let i = 0; i < 30; i++) await c.listInputs(2000);
  expect(c.listenerCount('inputs')).toBe(0);
  delete process.env.FAKE_DETECTOR_INPUTS;
  const { c: silent, seen: seen2 } = client([sentinel(10)]);
  await waitSentinel(seen2);
  for (let i = 0; i < 5; i++) expect(await silent.listInputs(50)).toBeNull();
  expect(silent.listenerCount('inputs')).toBe(0);
});

test('speaker-active (Discord no Windows) vira evento com nome e estado; linhas sem nome são descartadas', async () => {
  const { c, seen } = client([
    { at: 10, line: { event: 'speaker-active', app: 'Discord', name: 'Ana', speaking: true } },
    { at: 20, line: { event: 'speaker-active', app: 'Discord', name: '', speaking: true } },
    { at: 30, line: { event: 'speaker-active', app: 'Discord', name: 'Ana', speaking: false } },
    sentinel(40),
  ]);
  const speakers: unknown[] = [];
  c.on('speaker-active', (p) => speakers.push(p));
  await waitSentinel(seen);
  expect(speakers).toEqual([{ app: 'Discord', name: 'Ana', speaking: true }, { app: 'Discord', name: 'Ana', speaking: false }]);
});
