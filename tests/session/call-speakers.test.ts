import { describe, expect, test } from 'vitest';
import { SpeakerLabels, SpeakerTimeline } from '../../src/main/session/call-speakers';

// Linha do tempo de uma chamada: Ana fala 0–4 s, Bruno 3,5–9 s (os dois juntos por meio segundo), Ana de novo a partir de 12 s (sem fim ainda).
const timeline = () => {
  const t = new SpeakerTimeline();
  t.mark('Ana', true, 0);
  t.mark('Bruno', true, 3500);
  t.mark('Ana', false, 4000);
  t.mark('Bruno', false, 9000);
  t.mark('Ana', true, 12_000);
  return t;
};

describe('SpeakerTimeline', () => {
  test('o trecho fica com quem falou a maior parte dele', () => {
    const t = timeline();
    expect(t.whoSpoke(200, 3800)).toBe('Ana');
    expect(t.whoSpoke(3600, 8800)).toBe('Bruno');
    expect(t.whoSpoke(2000, 7000)).toBe('Bruno'); // Ana 2 s, Bruno 3,5 s
  });

  test('fala ainda aberta conta até o fim do trecho', () => {
    expect(timeline().whoSpoke(12_500, 15_000)).toBe('Ana');
  });

  test('sem cobertura suficiente (silêncio no Discord, ou só um toque) não dá nome', () => {
    const t = timeline();
    expect(t.whoSpoke(9500, 11_500)).toBeNull();
    expect(t.whoSpoke(8500, 11_900)).toBeNull(); // Bruno cobre 0,5 de 3,4 s (< 30%)
    expect(t.whoSpoke(5000, 5000)).toBeNull();
  });

  test('ignora fim sem começo e começo repetido', () => {
    const t = new SpeakerTimeline();
    t.mark('Ana', false, 100);
    t.mark('Ana', true, 1000);
    t.mark('Ana', true, 1500);
    t.mark('Ana', false, 2000);
    expect(t.whoSpoke(0, 900)).toBeNull();
    expect(t.whoSpoke(1000, 2000)).toBe('Ana');
  });
});

describe('SpeakerLabels', () => {
  test('sem identificação de vozes, cada nome ganha uma Pessoa N estável', () => {
    const l = new SpeakerLabels();
    expect(l.label('Ana')).toEqual({ speaker: 1, fresh: true });
    expect(l.label('Bruno')).toEqual({ speaker: 2, fresh: true });
    expect(l.label('Ana')).toEqual({ speaker: 1, fresh: false });
    expect(l.label(null)).toEqual({ fresh: false }); // continua "Outros"
  });

  test('com identificação, o grupo da voz adota o nome; grupo já com outro nome não é reaproveitado', () => {
    const l = new SpeakerLabels();
    expect(l.label('Ana', 1)).toEqual({ speaker: 1, fresh: true });
    expect(l.label('Bruno', 1)).toEqual({ speaker: 2, fresh: true }); // o agrupamento juntou as duas vozes: o nome manda
    expect(l.label(null, 3)).toEqual({ speaker: 3, fresh: false }); // sem nome, fica o grupo
    expect(l.label('Caio', 3)).toEqual({ speaker: 3, fresh: true });
    expect(l.label('Dani', 1)).toEqual({ speaker: 4, fresh: true });
    expect(l.label('Ana', 2)).toEqual({ speaker: 1, fresh: false });
  });
});
