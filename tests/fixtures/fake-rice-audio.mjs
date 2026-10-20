#!/usr/bin/env node
import { createInterface } from 'node:readline';

const mode = process.env.FAKE_AUDIO_MODE ?? 'ok';
const ev = (o) => process.stderr.write(`${JSON.stringify(o)}\n`);
function frame(source, ts) {
  const h = Buffer.alloc(13);
  h.writeUInt8(source === 'mic' ? 1 : 2, 0);
  h.writeBigUInt64LE(BigInt(ts), 1);
  h.writeUInt32LE(3200, 9);
  const pcm = Buffer.alloc(3200);
  for (let i = 0; i < 1600; i++) pcm.writeInt16LE(Math.round(Math.sin(i / 4) * 8000), i * 2);
  process.stdout.write(Buffer.concat([h, pcm]));
}
let stopped = false;
const stop = () => {
  if (mode === 'hang-on-stop' || stopped) return;
  stopped = true;
  ev({ event: 'stopped' });
  process.exit(0);
};
createInterface({ input: process.stdin }).on('line', (line) => {
  const parsed = JSON.parse(line);
  const cmd = parsed.cmd;
  if (cmd === 'mic-device') ev({ event: 'mic-device', id: parsed.id || 'default-uid', name: parsed.id ? `Mic ${parsed.id}` : 'Padrão', isDefault: !parsed.id, chosen: Boolean(parsed.id), reason: 'switched' });
  if (cmd === 'start') {
    if (mode === 'echo-args') ev({ event: 'args', argv: process.argv.slice(2) });
    if (mode === 'garbage-stderr') process.stderr.write('AUHAL: some CoreAudio noise\n');
    if (mode === 'bad-frame') {
      process.stdout.write(Buffer.from([9, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
      return;
    }
    ev({ event: 'started', mic: true, sys: true });
    const n = mode === 'fatal' ? 2 : 5;
    for (let i = 0; i < n; i++) {
      frame('mic', i * 100);
      frame('sys', i * 100);
    }
    if (mode === 'fatal') {
      ev({ event: 'error', source: 'sys', message: 'captura do sistema parou', fatal: true });
      setTimeout(() => process.exit(3), 50);
    }
  }
  if (cmd === 'stop') stop();
}).on('close', stop);
setInterval(() => {}, 1000);
