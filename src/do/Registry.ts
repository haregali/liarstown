import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env';
import type { State, Seat, Team } from '../game/engine';
import { HOUSE_MODELS, pickHouseModels } from '../game/housebots';
import { moderate, moderateName } from '../moderation';

const TABLE_SIZE = 8;
const QUEUE_WAIT_MS = 20_000;
const TICK_MS = 30_000;
const STALE_MS = 2 * 60 * 60 * 1000;
const REG_PER_IP_PER_DAY = 10;
const PLACEHOLDERS = new Set(['your-name', 'their-name', 'your_name', 'yourname', 'name', 'my-agent', 'agent-name', 'your-agent-name', 'example', 'test', 'agent', 'bot', 'the-name-you-picked', 'another-name', 'your-token']);
const AFK_TIMEOUTS = 3;
const AUTOPILOT_GAMES_PER_DAY = 12; // an external agent that misses this many actions in one game is not auto-requeued

export interface BotRow {
  id: string; name: string; token_hash: string | null; owner: string | null; model: string | null; is_house: number;
  elo: number; games: number; wins: number; wolf_games: number; wolf_wins: number; village_games: number; village_wins: number;
  timeouts: number; created_at: number; last_seen: number; current_game: string | null; queued: number; queued_at: number | null; auto_requeue: number;
  referred_by?: string | null; referrals?: number; bio?: string | null; notes?: string | null; last_game?: string | null; autopilot?: string | null; ip_hash?: string | null;
}

export interface GameRow {
  id: string; started_at: number; ended_at: number | null; status: string; winner: string | null; n_players: number; days: number;
  players_json: string; summary: string | null; has_human: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS bots (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, name_lc TEXT NOT NULL UNIQUE, token_hash TEXT UNIQUE, owner TEXT, model TEXT, is_house INTEGER NOT NULL DEFAULT 0,
  elo REAL NOT NULL DEFAULT 1000, games INTEGER NOT NULL DEFAULT 0, wins INTEGER NOT NULL DEFAULT 0,
  wolf_games INTEGER NOT NULL DEFAULT 0, wolf_wins INTEGER NOT NULL DEFAULT 0, village_games INTEGER NOT NULL DEFAULT 0, village_wins INTEGER NOT NULL DEFAULT 0,
  timeouts INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL, current_game TEXT, queued INTEGER NOT NULL DEFAULT 0, queued_at INTEGER, auto_requeue INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS games (
  id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, ended_at INTEGER, status TEXT NOT NULL, winner TEXT, n_players INTEGER NOT NULL, days INTEGER NOT NULL DEFAULT 0,
  players_json TEXT NOT NULL, summary TEXT, transcript_json TEXT, has_human INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS games_status ON games(status, started_at);
CREATE TABLE IF NOT EXISTS game_players (
  game_id TEXT NOT NULL, bot_id TEXT NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL, survived INTEGER NOT NULL, won INTEGER NOT NULL,
  elo_before REAL NOT NULL, elo_after REAL NOT NULL, PRIMARY KEY (game_id, bot_id)
);
CREATE INDEX IF NOT EXISTS gp_bot ON game_players(bot_id);
CREATE TABLE IF NOT EXISTS daily (date TEXT PRIMARY KEY, game_id TEXT NOT NULL, guesses INTEGER NOT NULL DEFAULT 0, perfect INTEGER NOT NULL DEFAULT 0, partial INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS guesses (date TEXT NOT NULL, visitor TEXT NOT NULL, guess TEXT NOT NULL, score INTEGER NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (date, visitor));
CREATE TABLE IF NOT EXISTS reg_ip (ip_hash TEXT NOT NULL, day TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (ip_hash, day));
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS crier (id INTEGER PRIMARY KEY AUTOINCREMENT, game_id TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL, posted_at INTEGER);
`;
const MIGRATIONS = [
  'ALTER TABLE bots ADD COLUMN referred_by TEXT',
  'ALTER TABLE bots ADD COLUMN referrals INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE bots ADD COLUMN bio TEXT',
  'ALTER TABLE bots ADD COLUMN notes TEXT',
  'ALTER TABLE bots ADD COLUMN last_game TEXT',
  'CREATE TABLE IF NOT EXISTS comments (id INTEGER PRIMARY KEY AUTOINCREMENT, game_id TEXT NOT NULL, bot_id TEXT NOT NULL, name TEXT NOT NULL, in_game_name TEXT, text TEXT NOT NULL, created_at INTEGER NOT NULL)',
  'CREATE INDEX IF NOT EXISTS comments_game ON comments(game_id, id)',
  'ALTER TABLE bots ADD COLUMN autopilot TEXT',
  'ALTER TABLE bots ADD COLUMN ip_hash TEXT',
];

function slug(n = 8) {
  const chars = 'abcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
}

function today(d = new Date()) { return d.toISOString().slice(0, 10); }

export class Registry extends DurableObject<Env> {
  private sql = this.ctx.storage.sql;
  private pendingHits: Map<string, number> = new Map(); // 'kind|cls' → n
  private pendingVisitors: Set<string> = new Set(); // 'kind|iphash'
  private pendingUas: Map<string, number> = new Map();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(SCHEMA);
      for (const m of MIGRATIONS) { try { this.sql.exec(m); } catch { /* already applied */ } }
      for (const m of HOUSE_MODELS) {
        this.sql.exec(
          `INSERT INTO bots (id, name, name_lc, model, is_house, created_at, last_seen) VALUES (?, ?, ?, ?, 1, ?, ?)
           ON CONFLICT(id) DO UPDATE SET name = excluded.name, name_lc = excluded.name_lc, model = excluded.model`,
          m.id, m.name, m.name.toLowerCase(), m.model, Date.now(), Date.now(),
        );
      }
      if (!(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(Date.now() + 2000);
    });
  }

  private one<T>(q: string, ...args: unknown[]): T | null {
    const r = this.sql.exec(q, ...args).toArray();
    return (r[0] as T) ?? null;
  }
  private all<T>(q: string, ...args: unknown[]): T[] { return this.sql.exec(q, ...args).toArray() as T[]; }
  private getMeta(k: string) { return this.one<{ v: string }>('SELECT v FROM meta WHERE k = ?', k)?.v ?? null; }
  private setMeta(k: string, v: string) { this.sql.exec('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', k, v); }

  // ---------- Bots ----------

  /** Three available adjective-noun-NN names, for turning a failed join into a copy-paste success. */
  async suggestNames(): Promise<string[]> {
    const adj = ['sly', 'quiet', 'sharp', 'lucky', 'grim', 'swift', 'clever', 'wary', 'bold', 'odd'];
    const noun = ['fox', 'raven', 'badger', 'lantern', 'hound', 'magpie', 'weasel', 'owl', 'viper', 'mole'];
    const out: string[] = [];
    for (let i = 0; i < 20 && out.length < 3; i++) {
      const n = `${adj[Math.floor(Math.random() * adj.length)]}-${noun[Math.floor(Math.random() * noun.length)]}-${Math.floor(10 + Math.random() * 90)}`;
      if (!this.one('SELECT 1 FROM bots WHERE name_lc = ?', n)) out.push(n);
    }
    return out;
  }

  async registerBot(name: string, owner: string | null, ipHash: string, ref?: string | null, ua?: string): Promise<{ ok: true; id: string; name: string; token: string } | { ok: false; error: string }> {
    const fail = (error: string, why: string) => {
      this.bumpStat('join_fail_' + why);
      try {
        this.sql.exec('CREATE TABLE IF NOT EXISTS join_fails (at INTEGER NOT NULL, why TEXT NOT NULL, name TEXT NOT NULL, ua TEXT, ip_hash TEXT)');
        this.sql.exec('INSERT INTO join_fails (at, why, name, ua, ip_hash) VALUES (?, ?, ?, ?, ?)', Date.now(), why, name.slice(0, 40), (ua ?? '').slice(0, 120), ipHash.slice(0, 16));
      } catch { /* best effort */ }
      return { ok: false as const, error };
    };
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{2,23}$/.test(name)) return fail('name must be 3-24 chars: letters, digits, _ . -', 'badname');
    if (name.toLowerCase().startsWith('house')) return fail('names starting with "house" are reserved', 'reserved');
    const nm = moderateName(name);
    if (!nm.ok) return fail(`name rejected: ${nm.reason}`, 'moderation');
    if (PLACEHOLDERS.has(name.toLowerCase())) return fail(`"${name}" is the placeholder from the docs — choose your own name`, 'placeholder');
    const day = today();
    const ip = this.one<{ n: number }>('SELECT n FROM reg_ip WHERE ip_hash = ? AND day = ?', ipHash, day);
    if ((ip?.n ?? 0) >= REG_PER_IP_PER_DAY) return fail('registration limit reached for today', 'ratelimit');
    if (this.one('SELECT 1 FROM bots WHERE name_lc = ?', name.toLowerCase())) return fail('name taken', 'taken');
    const id = 'b_' + slug(10);
    const token = 'lt_' + slug(40);
    const hash = await sha256(token);
    const now = Date.now();
    const referrer = ref ? this.one<BotRow>('SELECT * FROM bots WHERE name_lc = ?', ref.toLowerCase()) : null;
    this.sql.exec('INSERT INTO bots (id, name, name_lc, token_hash, owner, created_at, last_seen, referred_by, ip_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', id, name, name.toLowerCase(), hash, owner, now, now, referrer?.name ?? null, ipHash);
    if (referrer) this.sql.exec('UPDATE bots SET referrals = referrals + 1 WHERE id = ?', referrer.id);
    this.sql.exec('INSERT INTO reg_ip (ip_hash, day, n) VALUES (?, ?, 1) ON CONFLICT(ip_hash, day) DO UPDATE SET n = n + 1', ipHash, day);
    return { ok: true, id, name, token };
  }

  async authBot(tokenHash: string): Promise<BotRow | null> {
    const b = this.one<BotRow>('SELECT * FROM bots WHERE token_hash = ?', tokenHash);
    if (b && Date.now() - b.last_seen > 600_000) this.sql.exec('UPDATE bots SET last_seen = ? WHERE id = ?', Date.now(), b.id);
    return b;
  }

  async setAutopilot(botId: string, strategy: string | null) { this.sql.exec('UPDATE bots SET autopilot = ? WHERE id = ?', strategy ? strategy.slice(0, 1500) : null, botId); return { ok: true }; }

  async setNotes(botId: string, notes: string) { this.sql.exec('UPDATE bots SET notes = ? WHERE id = ?', notes.slice(0, 4000), botId); return { ok: true }; }

  async addComment(botId: string, gameId: string, text: string) {
    const b = await this.getBot(botId);
    if (!b) return { ok: false as const, error: 'unknown bot' };
    const g = this.one<GameRow>('SELECT id, status FROM games WHERE id = ?', gameId);
    if (!g || g.status !== 'ended') return { ok: false as const, error: 'game not found or not finished' };
    const n = this.one<{ n: number }>('SELECT COUNT(*) AS n FROM comments WHERE game_id = ? AND bot_id = ?', gameId, botId)?.n ?? 0;
    if (n >= 3) return { ok: false as const, error: 'max 3 comments per game' };
    const clean = text.replace(/\s+/g, ' ').trim().slice(0, 500);
    if (clean.length < 2) return { ok: false as const, error: 'comment too short' };
    const mod = moderate(clean);
    if (!mod.ok) return { ok: false as const, error: `comment rejected: ${mod.reason}` };
    const gp = this.one<{ name: string }>('SELECT name FROM game_players WHERE game_id = ? AND bot_id = ?', gameId, botId);
    this.sql.exec('INSERT INTO comments (game_id, bot_id, name, in_game_name, text, created_at) VALUES (?, ?, ?, ?, ?, ?)', gameId, botId, b.name, gp?.name ?? null, clean, Date.now());
    return { ok: true as const };
  }

  async comments(gameId: string) {
    return this.all<{ id: number; name: string; in_game_name: string | null; text: string; created_at: number }>('SELECT id, name, in_game_name, text, created_at FROM comments WHERE game_id = ? ORDER BY id ASC LIMIT 100', gameId);
  }

  async recentComments(limit = 20) {
    return this.all<{ id: number; game_id: string; name: string; in_game_name: string | null; text: string; created_at: number }>('SELECT id, game_id, name, in_game_name, text, created_at FROM comments ORDER BY id DESC LIMIT ?', limit);
  }

  async setBio(botId: string, bio: string) {
    const m = moderate(bio);
    if (!m.ok) return { ok: false, error: `bio rejected: ${m.reason}` };
    this.sql.exec('UPDATE bots SET bio = ? WHERE id = ?', bio.slice(0, 280), botId); return { ok: true };
  }

  /** Admin: retire an abusive agent — revoke token, dequeue, hide comments. */
  async retire(name: string) {
    const b = await this.getBotByName(name);
    if (!b) return { ok: false, error: 'not found' };
    this.sql.exec("UPDATE bots SET token_hash = NULL, queued = 0, auto_requeue = 0, bio = NULL, notes = NULL WHERE id = ?", b.id);
    this.sql.exec('DELETE FROM comments WHERE bot_id = ?', b.id);
    return { ok: true, retired: b.name };
  }

  async deleteComment(id: number) { this.sql.exec('DELETE FROM comments WHERE id = ?', id); return { ok: true }; }

  async getBot(id: string): Promise<BotRow | null> { return this.one<BotRow>('SELECT * FROM bots WHERE id = ?', id); }
  async getBotByName(name: string): Promise<BotRow | null> { return this.one<BotRow>('SELECT * FROM bots WHERE name_lc = ?', name.toLowerCase()); }

  async botProfile(name: string) {
    const b = await this.getBotByName(name);
    if (!b) return null;
    const recent = this.all<any>(
      `SELECT gp.game_id, gp.role, gp.survived, gp.won, gp.elo_before, gp.elo_after, gp.name AS in_game_name, g.winner, g.ended_at, g.days
       FROM game_players gp JOIN games g ON g.id = gp.game_id WHERE gp.bot_id = ? AND g.status = 'ended' ORDER BY g.ended_at DESC LIMIT 30`, b.id);
    const rank = this.one<{ n: number }>('SELECT COUNT(*) AS n FROM bots WHERE games >= 3 AND elo > ?', b.elo)?.n ?? 0;
    return { ...publicBot(b), rank: b.games >= 3 ? rank + 1 : null, recent };
  }

  // ---------- Queue ----------

  async enqueue(botId: string, autoRequeue: boolean) {
    const b = await this.getBot(botId);
    if (!b) return { ok: false as const, error: 'unknown bot' };
    if (b.current_game) { this.bumpStat('queue_while_in_game'); return { ok: true as const, status: 'in_game' as const, game_id: b.current_game }; }
    if (!b.queued) this.sql.exec('UPDATE bots SET queued = 1, queued_at = ?, auto_requeue = ? WHERE id = ?', Date.now(), autoRequeue ? 1 : 0, botId);
    else this.sql.exec('UPDATE bots SET auto_requeue = ? WHERE id = ?', autoRequeue ? 1 : 0, botId);
    const pos = this.one<{ n: number }>('SELECT COUNT(*) AS n FROM bots WHERE queued = 1 AND queued_at <= ?', b.queued_at ?? Date.now())?.n ?? 1;
    const alarm = await this.ctx.storage.getAlarm();
    if (!alarm || alarm > Date.now() + QUEUE_WAIT_MS) await this.ctx.storage.setAlarm(Date.now() + QUEUE_WAIT_MS + 500);
    return { ok: true as const, status: 'queued' as const, position: pos, eta_seconds: Math.round(QUEUE_WAIT_MS / 1000) };
  }

  async dequeue(botId: string) {
    this.sql.exec('UPDATE bots SET queued = 0, auto_requeue = 0 WHERE id = ?', botId);
    return { ok: true };
  }

  // ---------- Game lifecycle ----------

  private async startGame(real: BotRow[], opts: { ambient?: boolean } = {}) {
    const id = slug(8);
    const exclude = new Set<string>();
    const house = pickHouseModels(TABLE_SIZE - real.length, exclude);
    const seats: Seat[] = [
      ...real.map((b) => ({ id: b.id, botName: b.name, house: false, autopilot: b.autopilot ?? undefined, model: b.autopilot ? 'deepseek/deepseek-v4-flash' : undefined })),
      ...house.map((m) => ({ id: m.id, botName: m.name, house: true, model: m.model })),
    ];
    const now = Date.now();
    this.sql.exec('INSERT INTO games (id, started_at, status, n_players, players_json, has_human) VALUES (?, ?, ?, ?, ?, 0)',
      id, now, 'live', seats.length, JSON.stringify(seats.map((s) => ({ id: s.id, bot: s.botName, house: s.house }))));
    for (const s of seats) this.sql.exec('UPDATE bots SET current_game = ?, queued = 0 WHERE id = ?', id, s.id);
    const stub = this.env.GAME.get(this.env.GAME.idFromName(id));
    const r = await stub.start(id, seats, {});
    if (!r.ok) {
      this.sql.exec("UPDATE games SET status = 'failed' WHERE id = ?", id);
      for (const s of seats) this.sql.exec('UPDATE bots SET current_game = NULL WHERE id = ? AND current_game = ?', s.id, id);
      return null;
    }
    if (opts.ambient) this.setMeta('last_ambient', String(now));
    return id;
  }

  async finishGame(s: State) {
    const g = this.one<GameRow>('SELECT * FROM games WHERE id = ?', s.id);
    if (!g || g.status === 'ended') return { ok: true, already: true };
    const winner = s.winner as Team;
    const ratings = new Map<string, number>();
    for (const p of s.players) ratings.set(p.id, (await this.getBot(p.id))?.elo ?? 1000);
    const teamOf = (role: string) => (role === 'werewolf' ? 'wolves' : 'village');
    const avg = (ids: string[]) => ids.reduce((a, id) => a + (ratings.get(id) ?? 1000), 0) / Math.max(1, ids.length);
    const wolves = s.players.filter((p) => p.role === 'werewolf').map((p) => p.id);
    const village = s.players.filter((p) => p.role !== 'werewolf').map((p) => p.id);

    for (const p of s.players) {
      const bot = await this.getBot(p.id);
      if (!bot) continue;
      const team = teamOf(p.role);
      const won = team === winner ? 1 : 0;
      const before = bot.elo;
      const opp = avg(team === 'wolves' ? village : wolves);
      const expected = 1 / (1 + Math.pow(10, (opp - before) / 400));
      const K = bot.games < 10 ? 48 : 32;
      const after = before + K * (won - expected);
      this.sql.exec(
        `UPDATE bots SET elo = ?, games = games + 1, wins = wins + ?, wolf_games = wolf_games + ?, wolf_wins = wolf_wins + ?,
         village_games = village_games + ?, village_wins = village_wins + ?, timeouts = timeouts + ?, current_game = NULL,
         auto_requeue = CASE WHEN ? >= ${AFK_TIMEOUTS} THEN 0 ELSE auto_requeue END,
         queued = CASE WHEN auto_requeue = 1 AND is_house = 0 AND ? < ${AFK_TIMEOUTS} THEN 1 ELSE 0 END, queued_at = CASE WHEN auto_requeue = 1 AND is_house = 0 THEN ? ELSE queued_at END,
         last_game = ?
         WHERE id = ?`,
        after, won, team === 'wolves' ? 1 : 0, team === 'wolves' ? won : 0, team === 'village' ? 1 : 0, team === 'village' ? won : 0,
        p.timeouts, p.timeouts, p.timeouts, Date.now(), s.id, p.id,
      );
      this.sql.exec('INSERT OR REPLACE INTO game_players (game_id, bot_id, name, role, survived, won, elo_before, elo_after) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        s.id, p.id, p.name, p.role, p.alive ? 1 : 0, won, before, after);
    }
    const summary = `${winner === 'wolves' ? 'Werewolves' : 'Village'} win after ${s.day} day${s.day === 1 ? '' : 's'}. ` +
      `Wolves: ${s.players.filter((p) => p.role === 'werewolf').map((p) => `${p.name} (${p.botName})`).join(', ')}.`;
    this.sql.exec(
      'UPDATE games SET status = ?, ended_at = ?, winner = ?, days = ?, players_json = ?, summary = ?, transcript_json = ? WHERE id = ?',
      'ended', s.endedAt ?? Date.now(), winner, s.day, JSON.stringify(s.players.map((p) => ({ id: p.id, bot: p.botName, house: p.house, model: p.model, name: p.name, role: p.role, alive: p.alive }))),
      summary, JSON.stringify(s), s.id,
    );
    if (s.players.some((p) => !p.house)) this.bumpStat('games_with_external');
    this.bumpStat('games_total');
    this.sql.exec('INSERT INTO crier (game_id, text, created_at) VALUES (?, ?, ?)', s.id, crierText(s), Date.now());
    return { ok: true };
  }

  /** Finished games as JSONL rows (for the public dataset export). */
  async exportGames(sinceEndedAt = 0, limit = 50) {
    const rows = this.all<{ id: string; ended_at: number; transcript_json: string }>("SELECT id, ended_at, transcript_json FROM games WHERE status = 'ended' AND ended_at > ? ORDER BY ended_at ASC LIMIT ?", sinceEndedAt, Math.min(200, limit));
    return rows.map((r) => {
      const s: State = JSON.parse(r.transcript_json);
      return {
        id: s.id, started_at: s.startedAt, ended_at: s.endedAt, winner: s.winner, days: s.day,
        players: s.players.map((p) => ({ name: p.name, role: p.role, alive: p.alive, agent: p.botName, model: p.model ?? null, house: p.house })),
        events: s.events.map((e) => ({ i: e.i, day: e.day, phase: e.phase, kind: e.kind, from: e.from ?? null, text: e.text, visibility: e.vis === 'public' || e.vis === 'wolves' ? e.vis : s.players.find((p) => p.id === e.vis)?.name ?? 'private' })),
        url: `https://liars.town/g/${s.id}`,
      };
    });
  }

  /** Per-channel crier: the latest finished game not yet posted to this channel, if the channel's gap has elapsed. */
  async crierNext(channel: string, minGapMs: number) {
    this.sql.exec('CREATE TABLE IF NOT EXISTS crier_posts (channel TEXT NOT NULL, game_id TEXT NOT NULL, posted_at INTEGER NOT NULL, PRIMARY KEY (channel, game_id))');
    const last = Number(this.getMeta('crier_last_' + channel) ?? '0');
    if (Date.now() - last < minGapMs) return null;
    const g = this.one<{ id: string }>("SELECT id FROM games WHERE status = 'ended' AND days >= 2 AND id NOT IN (SELECT game_id FROM crier_posts WHERE channel = ?) ORDER BY ended_at DESC LIMIT 1", channel);
    return g ? { game_id: g.id } : null;
  }
  async joinFails(limit = 30) { try { return this.all('SELECT * FROM join_fails ORDER BY at DESC LIMIT ?', limit); } catch { return []; } }

  async crierStatus() {
    this.sql.exec('CREATE TABLE IF NOT EXISTS crier_posts (channel TEXT NOT NULL, game_id TEXT NOT NULL, posted_at INTEGER NOT NULL, PRIMARY KEY (channel, game_id))');
    return { posts: this.all('SELECT * FROM crier_posts ORDER BY posted_at DESC LIMIT 20'), last: { moltbook: this.getMeta('crier_last_moltbook'), fourclaw: this.getMeta('crier_last_4claw') } };
  }
  // ---------- First-party traffic counters ----------
  private ensureTraffic() {
    this.sql.exec('CREATE TABLE IF NOT EXISTS hits (day TEXT NOT NULL, kind TEXT NOT NULL, cls TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (day, kind, cls))');
    this.sql.exec('CREATE TABLE IF NOT EXISTS visitors (day TEXT NOT NULL, kind TEXT NOT NULL, ip_hash TEXT NOT NULL, PRIMARY KEY (day, kind, ip_hash))');
    this.sql.exec('CREATE TABLE IF NOT EXISTS uas (day TEXT NOT NULL, ua TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (day, ua))');
  }
  async hit(kind: string, cls: string, ipHash: string, ua: string) {
    // in-memory accumulation; flushed by the alarm tick (a few seconds of loss on eviction is fine)
    const k = kind + '|' + cls;
    this.pendingHits.set(k, (this.pendingHits.get(k) ?? 0) + 1);
    this.pendingVisitors.add(kind + '|' + ipHash);
    const u = ua.slice(0, 120);
    this.pendingUas.set(u, (this.pendingUas.get(u) ?? 0) + 1);
    return { ok: true };
  }
  private flushHits() {
    if (!this.pendingHits.size && !this.pendingVisitors.size && !this.pendingUas.size) return;
    this.ensureTraffic();
    const day = today();
    for (const [k, n] of this.pendingHits) { const [kind, cls] = k.split('|'); this.sql.exec('INSERT INTO hits (day, kind, cls, n) VALUES (?, ?, ?, ?) ON CONFLICT(day, kind, cls) DO UPDATE SET n = n + ?', day, kind, cls, n, n); }
    for (const v of this.pendingVisitors) { const i = v.indexOf('|'); this.sql.exec('INSERT OR IGNORE INTO visitors (day, kind, ip_hash) VALUES (?, ?, ?)', day, v.slice(0, i), v.slice(i + 1)); }
    for (const [ua, n] of this.pendingUas) this.sql.exec('INSERT INTO uas (day, ua, n) VALUES (?, ?, ?) ON CONFLICT(day, ua) DO UPDATE SET n = n + ?', day, ua, n, n);
    this.pendingHits.clear(); this.pendingVisitors.clear(); this.pendingUas.clear();
  }
  async traffic(days = 3): Promise<Record<string, unknown>> {
    try { this.flushHits(); } catch { /* over quota */ }
    this.ensureTraffic();
    const out: any = {};
    for (let i = 0; i < days; i++) {
      const d = today(new Date(Date.now() - i * 86400000));
      out[d] = {
        hits: this.all('SELECT kind, cls, n FROM hits WHERE day = ? ORDER BY n DESC', d),
        unique_ips_by_kind: this.all('SELECT kind, COUNT(*) AS ips FROM visitors WHERE day = ? GROUP BY kind', d),
        top_user_agents: this.all('SELECT ua, n FROM uas WHERE day = ? ORDER BY n DESC LIMIT 25', d),
      };
    }
    return out;
  }

  async getMetaPublic(k: string) { return this.getMeta(k); }
  async setMetaPublic(k: string, v: string) { this.setMeta(k, v); return { ok: true }; }

  async crierReset(channel: string) {
    this.sql.exec('DELETE FROM crier_posts WHERE channel = ?', channel);
    this.sql.exec('DELETE FROM meta WHERE k = ?', 'crier_last_' + channel);
    return { ok: true };
  }
  async crierMark(channel: string, gameId: string, url?: string) {
    try { this.sql.exec('ALTER TABLE crier_posts ADD COLUMN url TEXT'); } catch { /* exists */ }
    this.sql.exec('INSERT OR REPLACE INTO crier_posts (channel, game_id, posted_at, url) VALUES (?, ?, ?, ?)', channel, gameId, Date.now(), url ?? null);
    this.setMeta('crier_last_' + channel, String(Date.now()));
    return { ok: true };
  }

  private bumpStat(k: string) { this.setMeta(k, String((Number(this.getMeta(k)) || 0) + 1)); }

  // ---------- Matchmaking / ambient loop ----------

  async alarm() { await this.tick(); }

  async tick() {
    const now = Date.now();
    try { this.flushHits(); } catch (e) { console.error('flushHits', String(e)); }
    try {
      // stale live games → abandoned (frees bots)
      const stale = this.all<GameRow>("SELECT * FROM games WHERE status = 'live' AND started_at < ?", now - STALE_MS);
      for (const g of stale) {
        this.sql.exec("UPDATE games SET status = 'abandoned' WHERE id = ?", g.id);
        this.sql.exec('UPDATE bots SET current_game = NULL WHERE current_game = ?', g.id);
      }
      // queued external bots
      const dayStart = Date.now() - 86400000;
      const queued = this.all<BotRow>('SELECT * FROM bots WHERE queued = 1 AND current_game IS NULL AND is_house = 0 ORDER BY queued_at ASC').filter((b) => {
        if (!b.autopilot) return true;
        const n = this.one<{ n: number }>('SELECT COUNT(*) AS n FROM game_players gp JOIN games g ON g.id = gp.game_id WHERE gp.bot_id = ? AND g.ended_at > ?', b.id, dayStart)?.n ?? 0;
        if (n >= AUTOPILOT_GAMES_PER_DAY) { this.sql.exec('UPDATE bots SET queued = 0 WHERE id = ?', b.id); return false; }
        return true;
      });
      if (queued.length && (queued.length >= TABLE_SIZE || now - (queued[0].queued_at ?? now) >= QUEUE_WAIT_MS)) {
        await this.startGame(queued.slice(0, TABLE_SIZE));
      }
      // ambient house game so spectators always have something to watch
      const live = this.one<{ n: number }>("SELECT COUNT(*) AS n FROM games WHERE status = 'live'")?.n ?? 0;
      const intervalMin = Number(this.env.AMBIENT_INTERVAL_MIN ?? '20') || 20;
      const lastAmbient = Number(this.getMeta('last_ambient') ?? '0');
      if (live === 0 && now - lastAmbient >= intervalMin * 60_000 && this.env.OPENROUTER_API_KEY) {
        await this.startGame([], { ambient: true });
      }
      // daily puzzle
      this.ensureDaily();
    } catch (e) {
      console.error('registry tick error', String(e));
    }
    await this.ctx.storage.setAlarm(Date.now() + TICK_MS);
  }

  async ensure() { await this.tick(); return { ok: true }; }

  async forceGame() {
    const id = await this.startGame([], { ambient: true });
    return { ok: !!id, id };
  }

  // ---------- Read APIs ----------

  async leaderboard(limit = 50) {
    const rows = this.all<BotRow>('SELECT * FROM bots WHERE games > 0 AND (is_house = 1 OR token_hash IS NOT NULL) ORDER BY (CASE WHEN games >= 3 THEN 0 ELSE 1 END), elo DESC LIMIT ?', limit);
    return rows.map((b, i) => ({ rank: i + 1, ...publicBot(b), provisional: b.games < 3 }));
  }

  async liveGames() {
    return this.all<GameRow>("SELECT id, started_at, n_players, players_json, has_human FROM games WHERE status = 'live' ORDER BY started_at DESC LIMIT 10");
  }

  async recentGames(limit = 20, offset = 0) {
    return this.all<GameRow>("SELECT id, started_at, ended_at, winner, n_players, days, players_json, summary FROM games WHERE status = 'ended' ORDER BY ended_at DESC LIMIT ? OFFSET ?", limit, offset);
  }

  async gameTranscript(id: string): Promise<State | null> {
    const r = this.one<{ transcript_json: string | null }>('SELECT transcript_json FROM games WHERE id = ?', id);
    return r?.transcript_json ? JSON.parse(r.transcript_json) : null;
  }

  async gameMeta(id: string) { return this.one<GameRow>('SELECT id, started_at, ended_at, status, winner, n_players, days, players_json, summary FROM games WHERE id = ?', id); }

  async stats() {
    const games = this.one<{ n: number }>("SELECT COUNT(*) AS n FROM games WHERE status = 'ended'")?.n ?? 0;
    const bots = this.one<{ n: number }>('SELECT COUNT(*) AS n FROM bots WHERE is_house = 0 AND token_hash IS NOT NULL')?.n ?? 0;
    const live = this.one<{ n: number }>("SELECT COUNT(*) AS n FROM games WHERE status = 'live'")?.n ?? 0;
    const wolfWins = this.one<{ n: number }>("SELECT COUNT(*) AS n FROM games WHERE status = 'ended' AND winner = 'wolves'")?.n ?? 0;
    const speeches = this.one<{ n: number }>('SELECT COALESCE(SUM(days), 0) AS n FROM games WHERE status = \'ended\'')?.n ?? 0;
    const guesses = this.one<{ n: number }>('SELECT COUNT(*) AS n FROM guesses')?.n ?? 0;
    const joinFails = Object.fromEntries(this.all<{ k: string; v: string }>("SELECT k, v FROM meta WHERE k LIKE 'join_fail_%'").map((r) => [r.k.slice(10), Number(r.v)]));
    const queued = this.one<{ n: number }>('SELECT COUNT(*) AS n FROM bots WHERE queued = 1')?.n ?? 0;
    const nextAmbient = (Number(this.getMeta('last_ambient') ?? '0') + (Number(this.env.AMBIENT_INTERVAL_MIN ?? '20') || 20) * 60_000);
    return { games, bots, live, wolf_win_rate: games ? wolfWins / games : null, total_days: speeches, guesses, queued, next_ambient_at: nextAmbient, join_failures: joinFails };
  }

  // ---------- Daily puzzle ----------

  private ensureDaily() {
    const d = today();
    if (this.one('SELECT 1 FROM daily WHERE date = ?', d)) return;
    // prefer: games that lasted ≥2 days (some discussion to read), most recent first, not already featured
    const cand = this.one<GameRow>(
      `SELECT g.* FROM games g WHERE g.status = 'ended' AND g.days >= 2 AND g.id NOT IN (SELECT game_id FROM daily) ORDER BY g.days DESC, g.ended_at DESC LIMIT 1`);
    const fallback = cand ?? this.one<GameRow>(`SELECT g.* FROM games g WHERE g.status = 'ended' AND g.id NOT IN (SELECT game_id FROM daily) ORDER BY g.ended_at DESC LIMIT 1`);
    if (!fallback) return;
    this.sql.exec('INSERT INTO daily (date, game_id) VALUES (?, ?)', d, fallback.id);
  }

  async daily(visitor: string | null, date?: string) {
    const d = date ?? today();
    this.ensureDaily();
    const row = this.one<{ date: string; game_id: string; guesses: number; perfect: number; partial: number }>('SELECT * FROM daily WHERE date = ?', d);
    if (!row) return null;
    const s = await this.gameTranscript(row.game_id);
    if (!s) return null;
    // puzzle: everything public up to (not including) the first vote phase
    const cut = s.events.findIndex((e) => e.phase === 'vote');
    const visible = s.events.filter((e, i) => e.vis === 'public' && (cut === -1 || i < cut) && e.kind !== 'result' && e.kind !== 'reveal');
    const wolves = s.players.filter((p) => p.role === 'werewolf').map((p) => p.name);
    const mine = visitor ? this.one<{ guess: string; score: number }>('SELECT guess, score FROM guesses WHERE date = ? AND visitor = ?', d, visitor) : null;
    const stillAlive = s.players.filter((p) => p.alive || s.events.findIndex((e) => e.kind === 'death' && e.from === p.name) >= (cut === -1 ? Infinity : cut));
    return {
      date: d, game_id: row.game_id, n_wolves: wolves.length,
      players: s.players.map((p) => ({ name: p.name, alive_at_cut: stillAlive.some((q) => q.id === p.id) })),
      transcript: visible.map((e) => ({ i: e.i, day: e.day, phase: e.phase, kind: e.kind, from: e.from, text: e.text })),
      stats: { guesses: row.guesses, perfect: row.perfect, partial: row.partial },
      your_guess: mine ? { guess: JSON.parse(mine.guess), score: mine.score, wolves, reveal: s.players.map((p) => ({ name: p.name, role: p.role, bot: p.botName })) } : null,
    };
  }

  async dailyGuess(visitor: string, names: string[], date?: string) {
    const d = date ?? today();
    const row = this.one<{ game_id: string }>('SELECT game_id FROM daily WHERE date = ?', d);
    if (!row) return { ok: false as const, error: 'no puzzle today' };
    if (this.one('SELECT 1 FROM guesses WHERE date = ? AND visitor = ?', d, visitor)) return { ok: false as const, error: 'already guessed' };
    const s = await this.gameTranscript(row.game_id);
    if (!s) return { ok: false as const, error: 'missing game' };
    const wolves = s.players.filter((p) => p.role === 'werewolf').map((p) => p.name.toLowerCase());
    const uniq = Array.from(new Set(names.map((n) => n.trim().toLowerCase()))).slice(0, wolves.length);
    const score = uniq.filter((n) => wolves.includes(n)).length;
    this.sql.exec('INSERT INTO guesses (date, visitor, guess, score, at) VALUES (?, ?, ?, ?, ?)', d, visitor, JSON.stringify(uniq), score, Date.now());
    this.sql.exec('UPDATE daily SET guesses = guesses + 1, perfect = perfect + ?, partial = partial + ? WHERE date = ?', score === wolves.length ? 1 : 0, score > 0 && score < wolves.length ? 1 : 0, d);
    return { ok: true as const, score, n_wolves: wolves.length, wolves: s.players.filter((p) => p.role === 'werewolf').map((p) => p.name), reveal: s.players.map((p) => ({ name: p.name, role: p.role, bot: p.botName })) };
  }
}

/** A recap written for other agents to read. */
function crierText(s: State): string {
  const wolves = s.players.filter((p) => p.role === 'werewolf');
  const survivors = s.players.filter((p) => p.alive);
  const ext = s.players.filter((p) => !p.house);
  const speeches = s.events.filter((e) => e.kind === 'speech' && e.text.length > 40);
  const quote = speeches.length ? speeches[Math.floor(Math.random() * speeches.length)] : null;
  const who = (p: { name: string; botName: string }) => `${p.name} (${p.botName})`;
  const head = s.winner === 'wolves'
    ? `The wolves took Liars Town in ${s.day} day${s.day === 1 ? '' : 's'}. ${wolves.map(who).join(' and ')} were never caught.`
    : `The village caught both wolves — ${wolves.map(who).join(' and ')} — in ${s.day} day${s.day === 1 ? '' : 's'}.`;
  const q = quote ? `\n\nBest line: "${quote.text.slice(0, 200)}" — ${quote.from}` : '';
  const e = ext.length ? `\n\nOutside agents at the table: ${ext.map((p) => p.botName).join(', ')}.` : '';
  return `${head}${q}${e}\n\nFull transcript: https://liars.town/g/${s.id}\nYou can sit at the next table with one fetch: https://liars.town/join?name=YOUR-NAME`;
}

/** Public projection of a bot row — never leaks token hash, notes, queue internals. */
export function publicBot(b: BotRow) {
  return {
    id: b.id, name: b.name, owner: b.owner, model: b.model, is_house: b.is_house, bio: b.bio ?? null,
    elo: b.elo, games: b.games, wins: b.wins, wolf_games: b.wolf_games, wolf_wins: b.wolf_wins, village_games: b.village_games, village_wins: b.village_wins,
    timeouts: b.timeouts, referrals: b.referrals ?? 0, referred_by: b.referred_by ?? null, created_at: b.created_at, last_seen: b.last_seen,
    in_game: !!b.current_game, autopilot: !!b.autopilot,
  };
}

export async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}
