import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';

export type CalendarEvent = { id: string; title: string; start: string; end: string; url: string | null };
/** Evento da lista do Início: também traz dia inteiro, calendário, cor e nº de participantes. */
export type ListedEvent = CalendarEvent & { allDay: boolean; calendar: string; color?: string; attendees: number };

/** Lembrete do app Lembretes (EKReminder) de hoje ou atrasado. Fica só neste Mac: nunca vai para a IA. */
export type ReminderItem = { id: string; title: string; due: string; hasTime: boolean; overdue: boolean; list: string; color?: string };

type Line = { event: string; [k: string]: unknown };

const ACCESS_STATUSES = new Set(['granted', 'denied', 'notDetermined']);
const DEFAULT_BACKOFF = [1000, 3000, 9000];
const STABLE_AFTER_MS = 60_000;

const toCalendarEvent = (l: Line): CalendarEvent => ({
  id: String(l.id),
  title: String(l.title ?? ''),
  start: String(l.start),
  end: String(l.end),
  url: typeof l.url === 'string' ? l.url : null,
});

const hasEventFields = (l: Line): boolean => [l.id, l.start, l.end].every((v) => typeof v === 'string' && v !== '');

/** Entrada de áudio padrão do sistema (evento opcional `default-input` do detector do Mac). */
export type InputDeviceInfo = { id: string; name: string };

export class DetectorClient extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private wanted = false;
  private readonly active = new Set<string>();
  private readonly releaseTimers = new Map<string, NodeJS.Timeout>();
  private readonly announced = new Set<string>();
  private input: InputDeviceInfo | null = null;
  /** App cujos falantes o detector está lendo (`watch-speakers`, só Windows); reenviado se o detector reinicia. */
  private speakersApp: string | null = null;
  private pending: ((e: CalendarEvent | null) => void) | null = null;
  private inflight: Promise<CalendarEvent | null> | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private stableTimer: NodeJS.Timeout | null = null;
  private attempt = 0;
  private readonly debounce: number;
  private readonly backoff: number[];

  constructor(
    private readonly binary: string,
    opts: { releaseDebounceMs?: number; restartBackoffMs?: number[] } = {},
  ) {
    super();
    this.debounce = opts.releaseDebounceMs ?? 120_000;
    this.backoff = opts.restartBackoffMs?.length ? opts.restartBackoffMs : DEFAULT_BACKOFF;
  }

  start(): void {
    this.wanted = true;
    this.spawnChild();
  }

  private spawnChild(): void {
    if (this.child) return;
    const child = spawn(this.binary, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.child = child;
    child.stdin.on('error', () => {});
    child.stderr.resume();
    if (this.speakersApp) child.stdin.write(`${JSON.stringify({ cmd: 'watch-speakers', app: this.speakersApp })}\n`);
    child.on('error', () => {});
    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on('line', (text) => {
      if (this.child !== child) return;
      let line: Line;
      try {
        line = JSON.parse(text) as Line;
      } catch {
        return;
      }
      this.handle(line);
    });
    this.stableTimer = setTimeout(() => {
      this.attempt = 0;
    }, STABLE_AFTER_MS);
    this.stableTimer.unref();
    child.on('close', (code) => {
      rl.close();
      if (this.child !== child) return;
      this.child = null;
      if (this.stableTimer) clearTimeout(this.stableTimer);
      this.stableTimer = null;
      this.settle(null);
      if (!this.wanted) return;
      this.emit('exit', { code });
      const delay = this.backoff[Math.min(this.attempt, this.backoff.length - 1)];
      this.attempt++;
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        if (this.wanted) this.spawnChild();
      }, delay);
    });
  }

  private settle(value: CalendarEvent | null): void {
    const p = this.pending;
    this.pending = null;
    p?.(value);
  }

  private handle(line: Line): void {
    const app = String(line.app ?? '');
    switch (line.event) {
      case 'mic-in-use': {
        const timer = this.releaseTimers.get(app);
        if (timer) {
          clearTimeout(timer);
          this.releaseTimers.delete(app);
        }
        if (!this.active.has(app)) {
          this.active.add(app);
          this.emit('meeting-app-started', { app, bundleId: String(line.bundleId ?? '') });
        }
        break;
      }
      case 'mic-released': {
        if (!this.active.has(app) || this.releaseTimers.has(app)) break;
        this.releaseTimers.set(
          app,
          setTimeout(() => {
            this.releaseTimers.delete(app);
            this.active.delete(app);
            this.emit('meeting-app-ended', { app });
          }, this.debounce),
        );
        break;
      }
      case 'upcoming-event': {
        if (!hasEventFields(line)) break;
        const ev = toCalendarEvent(line);
        if (this.announced.has(ev.id)) break;
        this.announced.add(ev.id);
        this.emit('upcoming', ev);
        break;
      }
      case 'current-event':
        this.settle(hasEventFields(line) ? toCalendarEvent(line) : null);
        break;
      case 'events-list': {
        const raw = Array.isArray(line.events) ? (line.events as Line[]) : [];
        this.settleList(raw.filter(hasEventFields).map((l) => ({ ...toCalendarEvent(l), allDay: l.allDay === true, calendar: String(l.calendar ?? ''), ...(typeof l.color === 'string' ? { color: l.color } : {}), attendees: typeof l.attendees === 'number' ? l.attendees : 0 })));
        break;
      }
      case 'reminders-list': {
        const raw = Array.isArray(line.reminders) ? (line.reminders as Line[]) : [];
        this.settleReminders(raw.filter((l) => typeof l.id === 'string' && typeof l.due === 'string').map((l) => ({ id: String(l.id), title: String(l.title ?? ''), due: String(l.due), hasTime: l.hasTime === true, overdue: l.overdue === true, list: String(l.list ?? ''), ...(typeof l.color === 'string' ? { color: l.color } : {}) })));
        break;
      }
      case 'reminders-access':
        if (typeof line.status === 'string' && ACCESS_STATUSES.has(line.status)) this.emit('reminders-access', line.status);
        break;
      case 'reminders-changed':
        this.emit('reminders-changed');
        break;
      case 'reminder-completed': {
        const done = this.pendingComplete.get(String(line.id));
        this.pendingComplete.delete(String(line.id));
        done?.(line.ok === true);
        break;
      }
      case 'inputs': {
        // resposta do `list-inputs` (escolha do microfone ao gravar e menu do chip)
        this.emit('inputs', line);
        break;
      }
      case 'default-input': {
        // Opcional (só o detector do Mac): o nome do microfone em uso. Nulos = sem entrada.
        this.input = typeof line.id === 'string' && typeof line.name === 'string' ? { id: line.id, name: line.name } : null;
        this.emit('default-input', this.input);
        break;
      }
      case 'speaker-active':
        // só Windows (Discord): o nome de quem começou/parou de falar na chamada
        if (typeof line.name === 'string' && line.name && typeof line.speaking === 'boolean') this.emit('speaker-active', { app, name: line.name, speaking: line.speaking });
        break;
      case 'calendar-changed':
        this.emit('calendar-changed');
        break;
      case 'calendar-access':
        if (typeof line.status === 'string' && ACCESS_STATUSES.has(line.status)) this.emit('calendar-access', line.status);
        break;
    }
  }

  private pendingReminders: ((items: ReminderItem[]) => void) | null = null;
  private readonly pendingComplete = new Map<string, (ok: boolean) => void>();

  private settleReminders(items: ReminderItem[]): void {
    const pending = this.pendingReminders;
    this.pendingReminders = null;
    pending?.(items);
  }

  /** Lembretes de hoje e atrasados. Sem acesso ou sem detector: lista vazia. */
  listReminders(): Promise<ReminderItem[]> {
    const child = this.child;
    if (!child) return Promise.resolve([]);
    this.settleReminders([]);
    return new Promise<ReminderItem[]>((resolve) => {
      const timer = setTimeout(() => this.settleReminders([]), 5000);
      this.pendingReminders = (items) => {
        clearTimeout(timer);
        resolve(items);
      };
      child.stdin.write('{"cmd":"list-reminders"}\n');
    });
  }

  requestRemindersAccess(): void {
    this.child?.stdin.write('{"cmd":"request-reminders-access"}\n');
  }

  /** Conclui no app Lembretes (só a pedido do usuário). */
  completeReminder(id: string): Promise<boolean> {
    const child = this.child;
    if (!child) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingComplete.delete(id);
        resolve(false);
      }, 5000);
      this.pendingComplete.set(id, (ok) => {
        clearTimeout(timer);
        resolve(ok);
      });
      child.stdin.write(`${JSON.stringify({ cmd: 'complete-reminder', id })}\n`);
    });
  }

  private pendingList: ((events: ListedEvent[]) => void) | null = null;

  private settleList(events: ListedEvent[]): void {
    const pending = this.pendingList;
    this.pendingList = null;
    pending?.(events);
  }

  /** Eventos (com os de dia inteiro) entre `from` e `to`, para a lista do Início. Sem acesso ou sem detector: lista vazia. */
  listEvents(from: Date, to: Date): Promise<ListedEvent[]> {
    const child = this.child;
    if (!child) return Promise.resolve([]);
    this.settleList([]); // um pedido novo substitui o anterior
    return new Promise<ListedEvent[]>((resolve) => {
      const timer = setTimeout(() => this.settleList([]), 5000);
      this.pendingList = (events) => {
        clearTimeout(timer);
        resolve(events);
      };
      child.stdin.write(`${JSON.stringify({ cmd: 'list-events', from: from.toISOString().replace(/\.\d{3}Z$/, 'Z'), to: to.toISOString().replace(/\.\d{3}Z$/, 'Z') })}\n`);
    });
  }

  currentEvent(): Promise<CalendarEvent | null> {
    if (this.inflight) return this.inflight;
    const child = this.child;
    if (!child) return Promise.resolve(null);
    const p = new Promise<CalendarEvent | null>((resolve) => {
      const timer = setTimeout(() => this.settle(null), 3000);
      this.pending = (e) => {
        clearTimeout(timer);
        resolve(e);
      };
      child.stdin.write('{"cmd":"current-event"}\n');
    });
    this.inflight = p;
    void p.then(() => {
      if (this.inflight === p) this.inflight = null;
    });
    return p;
  }

  /** Última entrada de áudio padrão informada pelo detector (null se ainda não veio ou não há). */
  get inputDevice(): InputDeviceInfo | null {
    return this.input;
  }

  /** As entradas de áudio (CoreAudio) com transporte, padrão e "em uso"; vazio se o detector não responder a tempo. */
  listInputs(timeoutMs = 1200): Promise<unknown> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.off('inputs', onInputs);
        resolve(null);
      }, timeoutMs);
      const onInputs = (payload: unknown) => {
        clearTimeout(timer);
        resolve(payload);
      };
      this.once('inputs', onInputs);
      this.child?.stdin.write('{"cmd":"list-inputs"}\n');
    });
  }

  /** Pede ao detector (Mac) para repetir o `default-input`. */
  requestCurrentInput(): void {
    this.child?.stdin.write('{"cmd":"current-input"}\n');
  }

  /** Começa (app) ou para (null) de ler quem fala na chamada; eventos `speaker-active`. Só o detector do Windows conhece o comando. */
  watchSpeakers(app: string | null): void {
    if (app === this.speakersApp) return;
    this.speakersApp = app;
    this.child?.stdin.write(app ? `${JSON.stringify({ cmd: 'watch-speakers', app })}\n` : '{"cmd":"stop-speakers"}\n');
  }

  requestCalendarAccess(): void {
    this.child?.stdin.write('{"cmd":"request-calendar-access"}\n');
  }

  stop(): void {
    this.wanted = false;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    if (this.stableTimer) clearTimeout(this.stableTimer);
    this.stableTimer = null;
    for (const t of this.releaseTimers.values()) clearTimeout(t);
    this.releaseTimers.clear();
    this.settle(null);
    this.settleList([]);
    this.settleReminders([]);
    const child = this.child;
    this.child = null;
    if (!child) return;
    const kill = setTimeout(() => child.kill('SIGKILL'), 2000);
    kill.unref();
    child.once('close', () => clearTimeout(kill));
    child.stdin.end();
  }
}
