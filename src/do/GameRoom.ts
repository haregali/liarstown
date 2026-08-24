import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env';
import {
  createGame, submit, applyTimeouts, nextDeadline, viewFor, publicView,
  type State, type Seat, type Action, type PlayerView, type PublicView,
} from '../game/engine';
import { houseAct, personaFor } from '../game/housebots';

const HOUSE_ITER_PER_ALARM = 4;

export class GameRoom extends DurableObject<Env> {
  private s: State | null = null;
  private loaded = false;
  private finalized = false;
  private waiters: Array<() => void> = [];
  private dirty = false;
  private lastSave = 0;

  private async load(): Promise<State | null> {
    if (!this.loaded) {
      this.s = (await this.ctx.storage.get<State>('state')) ?? null;
      this.finalized = (await this.ctx.storage.get<boolean>('finalized')) ?? false;
      this.loaded = true;
    }
    return this.s;
  }

  private async save(force = false) {
    if (!this.s) return;
    this.dirty = true;
    if (!force && Date.now() - this.lastSave < 4000 && this.s.phase !== 'ended') return;
    await this.ctx.storage.put('state', this.s);
    this.dirty = false;
    this.lastSave = Date.now();
  }

  private audience() {
    const socks = this.ctx.getWebSockets();
    const suspicion: Record<string, number> = {};
    for (const sock of socks) {
      const a = sock.deserializeAttachment() as { suspect?: string } | null;
      if (a?.suspect) suspicion[a.suspect] = (suspicion[a.suspect] ?? 0) + 1;
    }
    return { watchers: socks.length, suspicion };
  }

  private broadcast() {
    if (!this.s) return;
    const payload = JSON.stringify({ type: 'state', game: publicView(this.s), audience: this.audience() });
    for (const sock of this.ctx.getWebSockets()) { try { sock.send(payload); } catch { /* closed */ } }
  }

  private notify() {
    const ws = this.waiters; this.waiters = [];
    for (const w of ws) w();
    this.broadcast();
  }

  // ---- RPC ----

  async start(id: string, seats: Seat[], opts?: { rounds?: number; speak?: number; vote?: number; night?: number }) {
    await this.load();
    if (this.s) return { ok: false, error: 'already started' };
    this.s = createGame(id, seats, opts);
    await this.save(true);
    await this.ctx.storage.setAlarm(Date.now() + 50);
    this.notify();
    return { ok: true };
  }

  async snapshot(reveal = false): Promise<PublicView | null> {
    const s = await this.load();
    return s ? publicView(s, reveal) : null;
  }

  async observe(botId: string, waitMs: number, since = 0): Promise<PlayerView | null> {
    const s = await this.load();
    if (!s || !s.players.some((p) => p.id === botId)) return null;
    const end = Date.now() + Math.min(waitMs, 28_000);
    while (!s.pending[botId] && s.phase !== 'ended' && Date.now() < end) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, Math.max(0, end - Date.now()));
        this.waiters.push(() => { clearTimeout(t); resolve(); });
      });
    }
    return viewFor(s, botId, since);
  }

  async act(botId: string, action: Action): Promise<{ ok: true; view: PlayerView } | { ok: false; error: string }> {
    const s = await this.load();
    if (!s || !s.players.some((p) => p.id === botId)) return { ok: false, error: 'not in this game' };
    if (s.phase === 'ended') return { ok: false, error: 'game over' };
    const err = submit(s, botId, action);
    if (err) return { ok: false, error: err };
    await this.save();
    this.notify();
    await this.ctx.storage.setAlarm(Date.now() + 20);
    return { ok: true, view: viewFor(s, botId) };
  }

  // ---- Alarm-driven engine loop ----

  async alarm() {
    const s = await this.load();
    if (!s) return;
    if (s.phase === 'ended') { await this.finalize(); return; }

    let changed = false;
    const ended = () => (s.phase as string) === 'ended';
    // 1. deadlines
    while (!ended() && applyTimeouts(s)) changed = true;

    // 2. drive house bots (bounded per alarm so we don't hold one alarm forever)
    for (let iter = 0; iter < HOUSE_ITER_PER_ALARM && !ended(); iter++) {
      const housePending = Object.keys(s.pending).filter((pid) => { const p = s.players.find((q) => q.id === pid); return p?.house || !!p?.autopilot || !!p?.dropped; });
      if (!housePending.length) break;
      const results = await Promise.all(housePending.map(async (pid) => {
        const p = s.players.find((q) => q.id === pid)!;
        const view = viewFor(s, pid);
        const a = await houseAct(this.env.OPENROUTER_API_KEY, p.model ?? 'deepseek/deepseek-v4-flash', view, p.autopilot ? `${personaFor(pid + s.id)}. Strategy from your operator (follow it where sensible): ${p.autopilot}` : personaFor(pid + s.id));
        return { pid, a, type: view.action_required?.type };
      }));
      for (const { pid, a, type } of results) {
        const pend = s.pending[pid];
        if (!pend || pend.type !== type) continue; // phase moved on while we were thinking
        let err = a ? submit(s, pid, a) : 'no action';
        if (err && pend.type === 'speak') {
          // retry once with a reliable model before any filler
          const retry = await houseAct(this.env.OPENROUTER_API_KEY, 'deepseek/deepseek-v4-flash', viewFor(s, pid), personaFor(pid + s.id + 'r'));
          err = retry ? submit(s, pid, retry) : 'retry failed';
        }
        if (err) {
          const p = s.players.find((q) => q.id === pid)!;
          const fillers = ["I want to hear more before I commit.", "I am weighing what has been said — go on.", "Not ready to point a finger yet; keep talking.", "Say more. I am listening closely.", "I need a clearer read before I vote.", "Hold on — let us hear the others first."];
          const fallback: Action = pend.type === 'speak'
            ? { type: 'speak', text: fillers[(s.events.length + p.name.charCodeAt(0)) % fillers.length] }
            : pend.type === 'vote' ? { type: 'vote', target: 'abstain' }
              : { type: pend.type, target: pend.options[Math.floor(Math.random() * pend.options.length)] };
          err = submit(s, pid, fallback);
          if (err) console.error('fallback failed', err);
        }
        changed = true;
      }
      await this.save();
      this.notify();
    }

    if (changed) { await this.save(); this.notify(); }

    if (ended()) { await this.finalize(); return; }

    if (this.dirty) await this.save(true);
    const housePendingLeft = Object.keys(s.pending).some((pid) => { const p = s.players.find((q) => q.id === pid); return p?.house || !!p?.autopilot; });
    const next = housePendingLeft ? Date.now() + 100 : nextDeadline(s);
    if (next) await this.ctx.storage.setAlarm(Math.max(next, Date.now() + 20));
  }

  private async finalize() {
    const s = this.s!;
    if (this.finalized) return;
    this.finalized = true;
    await this.ctx.storage.put('finalized', true);
    await this.save(true);
    this.notify();
    const registry = this.env.REGISTRY.get(this.env.REGISTRY.idFromName('main'));
    try {
      await registry.finishGame(s);
    } catch (e) {
      console.error('finishGame failed', String(e));
      this.finalized = false;
      await this.ctx.storage.put('finalized', false);
      await this.ctx.storage.setAlarm(Date.now() + 5000);
      return;
    }
    for (const sock of this.ctx.getWebSockets()) { try { sock.close(1000, 'game over'); } catch { /* */ } }
  }

  // ---- WebSocket spectators ----

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.headers.get('Upgrade') === 'websocket') {
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      pair[1].serializeAttachment({});
      const s = await this.load();
      if (s) pair[1].send(JSON.stringify({ type: 'state', game: publicView(s), audience: this.audience() }));
      // let everyone else see the watcher count tick up
      const aud = JSON.stringify({ type: 'audience', audience: this.audience() });
      for (const sock of this.ctx.getWebSockets()) if (sock !== pair[1]) { try { sock.send(aud); } catch { /* */ } }
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    if (url.pathname.endsWith('/state')) {
      const s = await this.load();
      return Response.json(s ? publicView(s, url.searchParams.get('reveal') === '1') : null);
    }
    return new Response('not found', { status: 404 });
  }

  async webSocketMessage(ws: WebSocket, msg: string | ArrayBuffer) {
    if (msg === 'ping') { ws.send('pong'); return; }
    if (typeof msg !== 'string') return;
    try {
      const m = JSON.parse(msg);
      if (m.type === 'suspect') {
        const s = await this.load();
        const name = s?.players.find((p) => p.name === m.name && p.alive)?.name ?? null;
        ws.serializeAttachment({ suspect: name });
        const aud = JSON.stringify({ type: 'audience', audience: this.audience() });
        for (const sock of this.ctx.getWebSockets()) { try { sock.send(aud); } catch { /* */ } }
      }
    } catch { /* ignore junk */ }
  }
  async webSocketClose(ws: WebSocket) {
    try { ws.close(); } catch { /* */ }
    const aud = JSON.stringify({ type: 'audience', audience: this.audience() });
    for (const sock of this.ctx.getWebSockets()) if (sock !== ws) { try { sock.send(aud); } catch { /* */ } }
  }
  async webSocketError(ws: WebSocket) { try { ws.close(); } catch { /* */ } }
}
