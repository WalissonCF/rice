import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import { FrameDecoder } from '../../shared/frames';

export type AudioEvent = { event: string; [k: string]: unknown };

/** Um processo rice-audio = uma gravação. */
export class AudioCapture extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private stopping: Promise<void> | null = null;
  private expectedExit = false;

  /** `excludePids`: além do próprio Rice (players de música). Vão antes do Rice: o Windows só exclui a árvore do primeiro. */
  constructor(private readonly binary: string, private readonly excludePids: readonly number[] = []) {
    super();
  }

  start(): void {
    if (this.child) throw new Error('AudioCapture já iniciado');
    // O tap do áudio do sistema ignora o próprio Rice (o rice-audio já se exclui) e os players de música.
    const args = [...this.excludePids, process.pid].flatMap((pid) => ['--exclude-pid', String(pid)]);
    const child = spawn(this.binary, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.child = child;
    const decoder = new FrameDecoder();
    child.stdout.on('data', (chunk: Buffer) => {
      let frames;
      try {
        frames = decoder.push(chunk);
      } catch (err) {
        this.emit('decode-error', err as Error);
        child.kill('SIGKILL');
        return;
      }
      for (const frame of frames) this.emit('frame', frame);
    });
    createInterface({ input: child.stderr, crlfDelay: Infinity }).on('line', (line) => {
      const text = line.trim();
      if (!text.startsWith('{')) return;
      try {
        const parsed = JSON.parse(text) as AudioEvent;
        if (typeof parsed.event === 'string') this.emit('event', parsed);
      } catch {
        // linhas de frameworks da Apple — ignorar
      }
    });
    child.stdin.on('error', () => {});
    child.on('error', (err) => this.emit('event', { event: 'error', source: 'cli', message: err.message, fatal: true }));
    child.on('close', (code, signal) => {
      this.child = null;
      this.emit('exit', { code, signal, expected: this.expectedExit });
    });
    child.stdin.write('{"cmd":"start"}\n');
  }

  /** Mata o processo helper agora (rede de segurança do fim da gravação: nunca sobra órfão). */
  kill(): void {
    this.child?.kill('SIGKILL');
  }

  /** Troca o microfone durante a gravação (Mac): `uid` vazio/undefined = entrada padrão do macOS. O helper reabre a entrada pelo caminho da troca de dispositivo. */
  setMicDevice(uid?: string): void {
    this.child?.stdin.write(`${JSON.stringify({ cmd: 'mic-device', id: uid ?? '' })}\n`);
  }

  stop(timeoutMs = 5000): Promise<void> {
    if (this.stopping) return this.stopping;
    const child = this.child;
    if (!child) return Promise.resolve();
    this.expectedExit = true;
    this.stopping = new Promise<void>((resolve) => {
      let hard: NodeJS.Timeout | undefined;
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        // processo que nem o SIGKILL derruba (travado no kernel): o stop() resolve mesmo assim, nunca fica pendurado
        hard = setTimeout(resolve, 2000);
        hard.unref?.();
      }, timeoutMs);
      child.once('close', () => {
        clearTimeout(timer);
        clearTimeout(hard);
        resolve();
      });
      child.stdin.write('{"cmd":"stop"}\n');
      child.stdin.end();
    });
    return this.stopping;
  }
}
