import { expect, test } from 'vitest';
import { musicPlayerPids, parseTasklistPids } from '../../src/main/platform/music-players';

test('tasklist csv: pega os PIDs e ignora a linha de "nenhuma tarefa"', () => {
  const out = '"Spotify.exe","9120","Console","1","120.512 K"\r\n"Spotify.exe","9188","Console","1","40.100 K"\r\n';
  expect(parseTasklistPids(out)).toEqual([9120, 9188]);
  expect(parseTasklistPids('INFORMAÇÕES: nenhuma tarefa em execução correspondente aos critérios especificados.\r\n')).toEqual([]);
});

test('plataforma sem suporte: nada a excluir', async () => {
  expect(await musicPlayerPids('linux')).toEqual([]);
});
