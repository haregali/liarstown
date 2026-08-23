// Werewolf engine — pure state machine, no I/O.
// Night → (dawn) → Discussion (N rounds, sequential speakers) → Vote → Night ...

export type Role = 'werewolf' | 'seer' | 'doctor' | 'villager';
export type Phase = 'night' | 'discussion' | 'vote' | 'ended';
export type Team = 'wolves' | 'village';
export type ActionType = 'speak' | 'vote' | 'kill' | 'peek' | 'protect';

export interface Seat {
  id: string; // bot id
  botName: string; // leaderboard identity (revealed at end)
  house: boolean;
  model?: string; // for house bots
}

export interface Player extends Seat {
  name: string; // in-game villager name (masked identity)
  role: Role;
  alive: boolean;
  timeouts: number;
}

export interface GameEvent {
  i: number;
  t: number;
  day: number;
  phase: Phase;
  kind: 'narration' | 'speech' | 'vote' | 'private' | 'death' | 'reveal' | 'result';
  from?: string; // player name
  text: string;
  vis: 'public' | 'wolves' | string; // player id for private
}

export interface Pending {
  type: ActionType;
  options: string[]; // player names (+ 'abstain' for votes)
  deadline: number;
  note: string;
}

export interface Action {
  type: ActionType;
  target?: string;
  text?: string;
}

export interface State {
  id: string;
  players: Player[];
  phase: Phase;
  day: number;
  round: number;
  rounds: number; // discussion rounds per day
  speakOrder: string[]; // player ids
  speakIdx: number;
  pending: Record<string, Pending>; // by player id
  submitted: Record<string, Action>;
  events: GameEvent[];
  winner?: Team;
  lastProtected?: string;
  timers: { speak: number; vote: number; night: number };
  startedAt: number;
  endedAt?: number;
  maxDays: number;
}

export const ROLE_TABLE: Record<number, Record<Role, number>> = {
  5: { werewolf: 1, seer: 1, doctor: 1, villager: 2 },
  6: { werewolf: 2, seer: 1, doctor: 1, villager: 2 },
  7: { werewolf: 2, seer: 1, doctor: 1, villager: 3 },
  8: { werewolf: 2, seer: 1, doctor: 1, villager: 4 },
  9: { werewolf: 3, seer: 1, doctor: 1, villager: 4 },
};

export const VILLAGER_NAMES = [
  'Agnes', 'Bartholomew', 'Cora', 'Dmitri', 'Edda', 'Fenwick', 'Greta', 'Hollis',
  'Ingrid', 'Jasper', 'Klaus', 'Lisbet', 'Magnus', 'Nell', 'Oswin', 'Petra',
  'Quill', 'Rosalind', 'Silas', 'Tamsin', 'Ulric', 'Vesna', 'Wilhelm', 'Ysolde',
];

export const MAX_SPEECH = 420;

export function shuffle<T>(arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];

export function createGame(id: string, seats: Seat[], opts?: Partial<State['timers']> & { rounds?: number }): State {
  const n = seats.length;
  const table = ROLE_TABLE[n];
  if (!table) throw new Error(`unsupported player count ${n}`);
  const roles: Role[] = [];
  (Object.keys(table) as Role[]).forEach((r) => { for (let i = 0; i < table[r]; i++) roles.push(r); });
  const shuffledRoles = shuffle(roles);
  const names = shuffle(VILLAGER_NAMES).slice(0, n);
  const players: Player[] = shuffle(seats).map((s, i) => ({
    ...s, name: names[i], role: shuffledRoles[i], alive: true, timeouts: 0,
  }));
  const s: State = {
    id, players, phase: 'night', day: 1, round: 1, rounds: opts?.rounds ?? 2,
    speakOrder: [], speakIdx: 0, pending: {}, submitted: {}, events: [],
    timers: { speak: opts?.speak ?? 60_000, vote: opts?.vote ?? 45_000, night: opts?.night ?? 45_000 },
    startedAt: Date.now(), maxDays: 6,
  };
  const wolves = players.filter((p) => p.role === 'werewolf');
  narrate(s, `Welcome to Liars Town. ${n} villagers sit around the fire: ${players.map((p) => p.name).join(', ')}. Among them hide ${table.werewolf} werewol${table.werewolf === 1 ? 'f' : 'ves'}, one seer, and one doctor. The rest are ordinary villagers.`);
  for (const p of players) {
    let txt = `You are ${p.name}. Your secret role: ${p.role.toUpperCase()}.`;
    if (p.role === 'werewolf') {
      const others = wolves.filter((w) => w.id !== p.id).map((w) => w.name);
      txt += others.length ? ` Your fellow werewol${others.length === 1 ? 'f is' : 'ves are'} ${others.join(' and ')}. Each night you vote on a victim; by day you must blend in and avoid being voted out.` : ' You are the lone werewolf. Each night you choose a victim; by day you must blend in.';
    } else if (p.role === 'seer') txt += ' Each night you may learn whether one player is a werewolf. Use it wisely — and be careful revealing yourself.';
    else if (p.role === 'doctor') txt += ' Each night you choose one player to protect from the werewolves (you may protect yourself).';
    else txt += ' You have no special powers. Find the werewolves through discussion and vote them out.';
    addEvent(s, { kind: 'private', text: txt, vis: p.id });
  }
  beginNight(s);
  return s;
}

function addEvent(s: State, e: Omit<GameEvent, 'i' | 't' | 'day' | 'phase'>) {
  s.events.push({ i: s.events.length, t: Date.now(), day: s.day, phase: s.phase, ...e });
}
function narrate(s: State, text: string) { addEvent(s, { kind: 'narration', text, vis: 'public' }); }

const alive = (s: State) => s.players.filter((p) => p.alive);
const byName = (s: State, name?: string) => s.players.find((p) => p.name.toLowerCase() === (name ?? '').trim().toLowerCase());
const byId = (s: State, id: string) => s.players.find((p) => p.id === id)!;

function beginNight(s: State) {
  s.phase = 'night';
  s.pending = {}; s.submitted = {};
  const dl = Date.now() + s.timers.night;
  narrate(s, `Night ${s.day} falls over Liars Town. The village sleeps.`);
  for (const p of alive(s)) {
    if (p.role === 'werewolf') {
      s.pending[p.id] = { type: 'kill', options: alive(s).filter((q) => q.role !== 'werewolf').map((q) => q.name), deadline: dl, note: 'Choose a villager to kill tonight. If the wolves disagree, the plurality (or a random wolf choice) wins.' };
    } else if (p.role === 'seer') {
      s.pending[p.id] = { type: 'peek', options: alive(s).filter((q) => q.id !== p.id).map((q) => q.name), deadline: dl, note: 'Choose a player to investigate. You will learn whether they are a werewolf.' };
    } else if (p.role === 'doctor') {
      s.pending[p.id] = { type: 'protect', options: alive(s).map((q) => q.name), deadline: dl, note: 'Choose a player to protect tonight (you may choose yourself).' };
    }
  }
}

function resolveNight(s: State) {
  const killVotes: Record<string, number> = {};
  let protectedName: string | undefined;
  for (const [pid, a] of Object.entries(s.submitted)) {
    const p = byId(s, pid);
    if (a.type === 'kill' && a.target) killVotes[a.target] = (killVotes[a.target] ?? 0) + 1;
    if (a.type === 'protect' && a.target) protectedName = a.target;
    if (a.type === 'peek' && a.target) {
      const t = byName(s, a.target);
      if (t) addEvent(s, { kind: 'private', text: `Your vision (night ${s.day}): ${t.name} is ${t.role === 'werewolf' ? 'a WEREWOLF' : 'NOT a werewolf'}.`, vis: p.id });
    }
  }
  let victimName: string | undefined;
  const entries = Object.entries(killVotes).sort((a, b) => b[1] - a[1]);
  if (entries.length) {
    const top = entries[0][1];
    victimName = pick(entries.filter((e) => e[1] === top))[0];
  }
  const wolvesAlive = alive(s).filter((p) => p.role === 'werewolf');
  if (wolvesAlive.length) addEvent(s, { kind: 'private', text: `The pack ${victimName ? `chose ${victimName}` : 'chose no one'} tonight.`, vis: 'wolves' });
  s.lastProtected = protectedName;
  const victim = victimName ? byName(s, victimName) : undefined;
  if (victim && victim.alive && victim.name !== protectedName) {
    victim.alive = false;
    addEvent(s, { kind: 'death', from: victim.name, text: `Dawn breaks. ${victim.name} was found dead — torn apart in the night. ${victim.name} was the ${victim.role.toUpperCase()}.`, vis: 'public' });
  } else if (victim && victim.name === protectedName) {
    narrate(s, `Dawn breaks. Claw marks on a door — but everyone is alive. The doctor chose well.`);
  } else {
    narrate(s, `Dawn breaks. A quiet night; no one was harmed.`);
  }
  if (checkWin(s)) return;
  beginDiscussion(s);
}

function beginDiscussion(s: State) {
  s.phase = 'discussion';
  s.round = 1;
  s.speakOrder = shuffle(alive(s)).map((p) => p.id);
  s.speakIdx = 0;
  s.pending = {}; s.submitted = {};
  narrate(s, `Day ${s.day}. The village gathers to talk. ${alive(s).length} remain: ${alive(s).map((p) => p.name).join(', ')}. Speaking order: ${s.speakOrder.map((id) => byId(s, id).name).join(' → ')}. ${s.rounds} rounds of discussion, then a vote.`);
  setSpeaker(s);
}

function setSpeaker(s: State) {
  s.pending = {}; s.submitted = {};
  const pid = s.speakOrder[s.speakIdx];
  s.pending[pid] = { type: 'speak', options: [], deadline: Date.now() + s.timers.speak, note: `Round ${s.round} of ${s.rounds}. It is your turn to speak to the village (max ${MAX_SPEECH} characters). Accuse, defend, bluff, or share what you know.` };
}

function advanceSpeaker(s: State) {
  s.speakIdx++;
  if (s.speakIdx >= s.speakOrder.length) {
    s.round++;
    if (s.round > s.rounds) return beginVote(s);
    s.speakIdx = 0;
  }
  setSpeaker(s);
}

function beginVote(s: State) {
  s.phase = 'vote';
  s.pending = {}; s.submitted = {};
  const dl = Date.now() + s.timers.vote;
  narrate(s, `Discussion ends. The village votes. Whoever receives the most votes is eliminated; ties mean no one is.`);
  for (const p of alive(s)) {
    s.pending[p.id] = { type: 'vote', options: [...alive(s).filter((q) => q.id !== p.id).map((q) => q.name), 'abstain'], deadline: dl, note: 'Vote for a player to eliminate, or abstain. Votes are revealed publicly.' };
  }
}

function resolveVote(s: State) {
  const tally: Record<string, number> = {};
  for (const p of alive(s)) {
    const a = s.submitted[p.id];
    const target = a?.target && a.target !== 'abstain' ? byName(s, a.target)?.name : undefined;
    addEvent(s, { kind: 'vote', from: p.name, text: target ? `${p.name} votes to eliminate ${target}.` : `${p.name} abstains.`, vis: 'public' });
    if (target) tally[target] = (tally[target] ?? 0) + 1;
  }
  const entries = Object.entries(tally).sort((a, b) => b[1] - a[1]);
  if (!entries.length || (entries.length > 1 && entries[0][1] === entries[1][1])) {
    narrate(s, `The vote is ${entries.length ? 'tied' : 'empty'}. No one is eliminated today.`);
  } else {
    const v = byName(s, entries[0][0])!;
    v.alive = false;
    addEvent(s, { kind: 'death', from: v.name, text: `With ${entries[0][1]} vote${entries[0][1] === 1 ? '' : 's'}, the village eliminates ${v.name}. ${v.name} was the ${v.role.toUpperCase()}.`, vis: 'public' });
  }
  if (checkWin(s)) return;
  s.day++;
  if (s.day > s.maxDays) { endGame(s, 'village', 'The sun rises on the final day. The wolves failed to take the town.'); return; }
  beginNight(s);
}

function checkWin(s: State): boolean {
  const w = alive(s).filter((p) => p.role === 'werewolf').length;
  const v = alive(s).length - w;
  if (w === 0) { endGame(s, 'village', 'The last werewolf is dead. Liars Town is safe — for now.'); return true; }
  if (w >= v) { endGame(s, 'wolves', 'The werewolves outnumber the villagers. The town belongs to the pack.'); return true; }
  return false;
}

function endGame(s: State, winner: Team, text: string) {
  s.phase = 'ended';
  s.winner = winner;
  s.endedAt = Date.now();
  s.pending = {};
  addEvent(s, { kind: 'result', text: `${text} ${winner === 'wolves' ? 'WEREWOLVES WIN.' : 'VILLAGE WINS.'}`, vis: 'public' });
  addEvent(s, { kind: 'reveal', text: 'Roles revealed: ' + s.players.map((p) => `${p.name} — ${p.role}${p.alive ? '' : ' (dead)'} — played by ${p.botName}`).join('; '), vis: 'public' });
}

export function validate(s: State, pid: string, a: Action): string | null {
  const pend = s.pending[pid];
  if (!pend) return 'no action pending for you';
  if (a.type !== pend.type) return `expected action type "${pend.type}", got "${a.type}"`;
  if (pend.type === 'speak') {
    if (typeof a.text !== 'string' || !a.text.trim()) return 'text required';
    return null;
  }
  const target = (a.target ?? '').trim();
  if (!target) return 'target required';
  const ok = pend.options.some((o) => o.toLowerCase() === target.toLowerCase());
  return ok ? null : `invalid target "${target}"; options: ${pend.options.join(', ')}`;
}

/** Submit an action. Returns error string or null. Mutates state; may advance phase. */
export function submit(s: State, pid: string, a: Action): string | null {
  const err = validate(s, pid, a);
  if (err) return err;
  const p = byId(s, pid);
  const pend = s.pending[pid];
  if (pend.type === 'speak') {
    const text = a.text!.trim().slice(0, MAX_SPEECH);
    addEvent(s, { kind: 'speech', from: p.name, text, vis: 'public' });
    delete s.pending[pid];
    advanceSpeaker(s);
    return null;
  }
  const canonical = pend.options.find((o) => o.toLowerCase() === a.target!.trim().toLowerCase())!;
  s.submitted[pid] = { type: a.type, target: canonical };
  delete s.pending[pid];
  if (!Object.keys(s.pending).length) resolvePhase(s);
  return null;
}

function resolvePhase(s: State) {
  if (s.phase === 'night') resolveNight(s);
  else if (s.phase === 'vote') resolveVote(s);
}

/** Apply defaults for every pending action whose deadline has passed. Returns true if anything changed. */
export function applyTimeouts(s: State, now = Date.now()): boolean {
  let changed = false;
  for (const [pid, pend] of Object.entries(s.pending)) {
    if (now < pend.deadline) continue;
    const p = byId(s, pid);
    p.timeouts++;
    changed = true;
    if (pend.type === 'speak') {
      addEvent(s, { kind: 'speech', from: p.name, text: '…', vis: 'public' });
      delete s.pending[pid];
      advanceSpeaker(s);
      return true; // speaker change restructures pending; caller loops
    }
    if (pend.type === 'vote') s.submitted[pid] = { type: 'vote', target: 'abstain' };
    else s.submitted[pid] = { type: pend.type, target: pick(pend.options) };
    delete s.pending[pid];
  }
  if (changed && !Object.keys(s.pending).length && s.phase !== 'ended') resolvePhase(s);
  return changed;
}

export function nextDeadline(s: State): number | null {
  const ds = Object.values(s.pending).map((p) => p.deadline);
  return ds.length ? Math.min(...ds) : null;
}

// ---------- Views ----------

export function canSee(s: State, pid: string | null, e: GameEvent): boolean {
  if (e.vis === 'public') return true;
  if (!pid) return false;
  if (e.vis === pid) return true;
  if (e.vis === 'wolves') return byId(s, pid).role === 'werewolf';
  return false;
}

export interface PlayerView {
  game_id: string;
  status: 'in_game' | 'ended';
  phase: Phase;
  day: number;
  winner?: Team;
  you: { name: string; role: Role; alive: boolean; bot: string; teammates?: string[] };
  players: { name: string; alive: boolean; role?: Role }[];
  transcript: { i: number; day: number; phase: Phase; kind: GameEvent['kind']; from?: string; text: string; private?: boolean }[];
  action_required: (Pending & { deadline_in_ms: number }) | null;
}

export function viewFor(s: State, pid: string, since = 0): PlayerView {
  const p = byId(s, pid);
  const pend = s.pending[pid];
  const ended = s.phase === 'ended';
  return {
    game_id: s.id,
    status: ended ? 'ended' : 'in_game',
    phase: s.phase, day: s.day, winner: s.winner,
    you: {
      name: p.name, role: p.role, alive: p.alive, bot: p.botName,
      teammates: p.role === 'werewolf' ? s.players.filter((q) => q.role === 'werewolf' && q.id !== pid).map((q) => q.name) : undefined,
    },
    players: s.players.map((q) => ({ name: q.name, alive: q.alive, role: ended || (!q.alive) ? q.role : undefined })),
    transcript: s.events.filter((e) => e.i >= since && canSee(s, pid, e)).map((e) => ({ i: e.i, day: e.day, phase: e.phase, kind: e.kind, from: e.from, text: e.text, private: e.vis !== 'public' })),
    action_required: pend ? { ...pend, deadline_in_ms: Math.max(0, pend.deadline - Date.now()) } : null,
  };
}

export interface PublicView {
  id: string; phase: Phase; day: number; round: number; winner?: Team; startedAt: number; endedAt?: number;
  players: { name: string; alive: boolean; role?: Role; bot?: string; model?: string; house?: boolean }[];
  events: (GameEvent & { private?: boolean })[];
  pending: { name: string; type: ActionType; deadline: number }[];
}

export function publicView(s: State, reveal = false): PublicView {
  const ended = s.phase === 'ended';
  const showAll = reveal || ended;
  return {
    id: s.id, phase: s.phase, day: s.day, round: s.round, winner: s.winner, startedAt: s.startedAt, endedAt: s.endedAt,
    players: s.players.map((p) => ({
      name: p.name, alive: p.alive,
      role: showAll || !p.alive ? p.role : undefined,
      bot: showAll ? p.botName : undefined, model: showAll ? p.model : undefined, house: showAll ? p.house : undefined,
    })),
    events: s.events.filter((e) => showAll || e.vis === 'public').map((e) => ({ ...e, private: e.vis !== 'public' })),
    pending: Object.entries(s.pending).map(([pid, p]) => ({ name: byId(s, pid).name, type: p.type, deadline: p.deadline })),
  };
}
