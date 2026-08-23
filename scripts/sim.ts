// Simulate N games with random actors to sanity-check the engine.
import { createGame, submit, applyTimeouts, viewFor, publicView, type Seat } from '../src/game/engine';

const seats: Seat[] = Array.from({ length: 7 }, (_, i) => ({ id: `b${i}`, botName: `bot${i}`, house: i % 2 === 0, model: 'x' }));
let wolfWins = 0, villageWins = 0, totalDays = 0, maxEvents = 0;
const N = 300;
for (let g = 0; g < N; g++) {
  const s = createGame(`g${g}`, seats);
  let steps = 0;
  while (s.phase !== 'ended' && steps++ < 10_000) {
    const pend = Object.entries(s.pending);
    if (!pend.length) throw new Error('no pending but not ended: ' + s.phase);
    // occasionally time out instead of acting
    if (Math.random() < 0.05) {
      for (const [, p] of pend) p.deadline = 0;
      applyTimeouts(s);
      continue;
    }
    const [pid, p] = pend[Math.floor(Math.random() * pend.length)];
    const view = viewFor(s, pid);
    if (!view.action_required) throw new Error('view missing action');
    const a = p.type === 'speak' ? { type: 'speak' as const, text: `hello from ${view.you.name} (${view.you.role})` }
      : { type: p.type, target: p.options[Math.floor(Math.random() * p.options.length)] };
    const err = submit(s, pid, a);
    if (err) throw new Error(`submit error: ${err}`);
    if (s.phase !== 'ended' && publicView(s, false).events.some((e) => e.private)) throw new Error('public view leaked private event mid-game');
  }
  if (s.phase !== 'ended') throw new Error('game did not end');
  if (s.winner === 'wolves') wolfWins++; else villageWins++;
  totalDays += s.day;
  maxEvents = Math.max(maxEvents, s.events.length);
  for (const p of s.players) {
    const v = viewFor(s, p.id);
    for (const e of v.transcript) if (e.private && p.role !== 'werewolf' && !s.events[e.i].vis.startsWith('b')) throw new Error('leak');
  }
}
console.log(`games=${N} wolves=${wolfWins} village=${villageWins} avgDays=${(totalDays / N).toFixed(2)} maxEvents=${maxEvents}`);
const s = createGame('demo', seats);
console.log(publicView(s).events.map((e) => e.text).join('\n'));
console.log(JSON.stringify(viewFor(s, s.players.find((p) => p.role === 'werewolf')!.id), null, 1).slice(0, 1500));
