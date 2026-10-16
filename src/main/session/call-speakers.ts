/**
 * Quem estava falando na chamada (Windows + Discord): o detector avisa `speaker-active` quando o nome de alguém acende no
 * Discord; aqui isso vira intervalos no tempo da gravação e cada trecho de "Outros" fica com quem falou a maior parte dele.
 * Só nomes, só em memória durante a gravação; o que fica na reunião é o nome em `meta.speakers` (o usuário pode trocar).
 */

/** Fração mínima do trecho coberta pela fala de alguém para levar o nome (o anel do Discord atrasa/adianta um pouco). */
const MIN_COVER = 0.3;

export class SpeakerTimeline {
  private readonly open = new Map<string, number>();
  private readonly spans: Array<{ name: string; from: number; to: number }> = [];

  mark(name: string, speaking: boolean, ms: number): void {
    const from = this.open.get(name);
    if (speaking) {
      if (from === undefined) this.open.set(name, ms);
      return;
    }
    if (from === undefined) return;
    this.open.delete(name);
    if (ms > from) this.spans.push({ name, from, to: ms });
  }

  /** Quem mais falou dentro de [startMs, endMs]; `null` se ninguém cobriu pelo menos 30% do trecho. */
  whoSpoke(startMs: number, endMs: number): string | null {
    const length = endMs - startMs;
    if (length <= 0) return null;
    const cover = new Map<string, number>();
    const add = (name: string, from: number, to: number) => {
      const overlap = Math.min(to, endMs) - Math.max(from, startMs);
      if (overlap > 0) cover.set(name, (cover.get(name) ?? 0) + overlap);
    };
    // ponytail: varre todos os intervalos a cada trecho (O(n)); numa reunião de horas são poucos milhares, se pesar indexar por tempo
    for (const s of this.spans) add(s.name, s.from, s.to);
    for (const [name, from] of this.open) add(name, from, Infinity);
    let best: string | null = null;
    let most = MIN_COVER * length;
    for (const [name, ms] of cover) {
      if (ms >= most) {
        best = name;
        most = ms;
      }
    }
    return best;
  }
}

/**
 * Nome da chamada -> número da "Pessoa N" (o mesmo esquema da identificação de vozes, para o renomear continuar valendo).
 * Com a identificação ligada, a primeira voz (grupo N) que aparece com um nome fica com ele; senão o nome ganha um número novo.
 */
export class SpeakerLabels {
  private readonly ids = new Map<string, number>();
  private readonly used = new Set<number>();

  /** `fresh`: o nome acabou de ganhar o número (quem chama grava em `meta.speakers`). */
  label(name: string | null, cluster?: number): { speaker?: number; fresh: boolean } {
    if (cluster !== undefined) this.used.add(cluster);
    if (!name) return { ...(cluster !== undefined ? { speaker: cluster } : {}), fresh: false };
    const known = this.ids.get(name);
    if (known !== undefined) return { speaker: known, fresh: false };
    const taken = new Set(this.ids.values());
    // ponytail: um número novo pode coincidir com um grupo que a identificação de vozes ainda vai criar; só afeta trechos sem nome do Discord
    const speaker = cluster !== undefined && !taken.has(cluster) ? cluster : Math.max(0, ...this.used) + 1;
    this.ids.set(name, speaker);
    this.used.add(speaker);
    return { speaker, fresh: true };
  }
}
