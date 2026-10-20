import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/**
 * Players de música cujo áudio não entra no `sys` (vão como `--exclude-pid` ao rice-audio). Só o Spotify por enquanto.
 * Lido no começo da gravação: um player aberto depois disso continua sendo gravado.
 */
const execFileAsync = promisify(execFile);

/** PIDs do `tasklist /fo csv /nh` (`"Spotify.exe","1234",…`); a linha de "nenhuma tarefa" não tem aspas e cai fora. */
export function parseTasklistPids(text: string): number[] {
  return text.split(/\r?\n/).flatMap((line) => {
    const pid = Number(/^"[^"]*","(\d+)"/.exec(line.trim())?.[1]);
    return pid > 0 ? [pid] : [];
  });
}

/** Qualquer falha (sem o comando, nenhum processo: o `pgrep` sai com 1) = lista vazia. */
export async function musicPlayerPids(platform: NodeJS.Platform = process.platform): Promise<number[]> {
  try {
    if (platform === 'win32') {
      const { stdout } = await execFileAsync('tasklist', ['/fi', 'imagename eq Spotify.exe', '/fo', 'csv', '/nh'], { timeout: 3000, windowsHide: true });
      return parseTasklistPids(stdout);
    }
    if (platform === 'darwin') {
      const { stdout } = await execFileAsync('pgrep', ['-x', 'Spotify'], { timeout: 3000 });
      return stdout.split('\n').map(Number).filter((pid) => pid > 0);
    }
  } catch {
    // sem player aberto (ou sem o comando): nada a excluir
  }
  return [];
}
