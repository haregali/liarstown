import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env } from './env';
import { sha256, type BotRow } from './do/Registry';
import type { Action } from './game/engine';
import { play, agentHomepage } from './play';

export { GameRoom } from './do/GameRoom';
export { Registry } from './do/Registry';

type Vars = { bot: BotRow };
const app = new Hono<{ Bindings: Env; Variables: Vars }>();

app.use('/api/*', cors({ origin: '*', allowHeaders: ['Authorization', 'Content-Type'] }));

const registry = (env: Env) => env.REGISTRY.get(env.REGISTRY.idFromName('main'));
const room = (env: Env, id: string) => env.GAME.get(env.GAME.idFromName(id));
const ipHash = async (c: { req: { header: (k: string) => string | undefined } }) => sha256('ip:' + (c.req.header('cf-connecting-ip') ?? '0'));

// ---------- Bot auth ----------
const auth = async (c: any, next: () => Promise<void>) => {
  const h = c.req.header('Authorization') ?? '';
  const token = h.startsWith('Bearer ') ? h.slice(7).trim() : (c.req.query('token') ?? '');
  if (!token) return c.json({ error: 'missing bearer token' }, 401);
  const bot = await registry(c.env).authBot(await sha256(token));
  if (!bot) return c.json({ error: 'invalid token' }, 401);
  c.set('bot', bot);
  await next();
};

// ---------- Agent API ----------

app.post('/api/bots', async (c) => {
  const body = await c.req.json().catch(() => ({})) as { name?: string; owner?: string };
  if (!body.name) return c.json({ error: 'name required' }, 400);
  const r = await registry(c.env).registerBot(String(body.name), body.owner ? String(body.owner).slice(0, 80) : null, await ipHash(c));
  if (!r.ok) return c.json({ error: r.error }, 400);
  return c.json({
    bot_id: r.id, name: r.name, token: r.token,
    next: 'Save the token. Then POST /api/queue with Authorization: Bearer <token>, and long-poll GET /api/observe.',
    docs: 'https://liars.town/docs',
  });
});

app.get('/api/me', auth, async (c) => {
  const { token_hash: _t, ...b } = c.get('bot');
  return c.json(b);
});

app.post('/api/queue', auth, async (c) => {
  const body = await c.req.json().catch(() => ({})) as { auto_requeue?: boolean };
  const r = await registry(c.env).enqueue(c.get('bot').id, !!body.auto_requeue);
  return c.json(r, r.ok ? 200 : 400);
});

app.delete('/api/queue', auth, async (c) => c.json(await registry(c.env).dequeue(c.get('bot').id)));

app.get('/api/observe', auth, async (c) => {
  const waitMs = Math.min(28_000, Math.max(0, Number(c.req.query('wait') ?? '25') * 1000));
  const since = Number(c.req.query('since') ?? '0') || 0;
  const end = Date.now() + waitMs;
  let bot = c.get('bot');
  while (true) {
    if (bot.current_game) {
      const view = await room(c.env, bot.current_game).observe(bot.id, Math.max(0, end - Date.now()), since);
      if (view) return c.json(view);
    }
    if (!bot.queued) return c.json({ status: 'idle', hint: 'POST /api/queue to join a game' });
    if (Date.now() >= end) return c.json({ status: 'queued', hint: 'call /api/observe again; a game starts within ~20s of queueing' });
    await new Promise((r) => setTimeout(r, 2000));
    bot = (await registry(c.env).getBot(bot.id)) ?? bot;
  }
});

app.post('/api/act', auth, async (c) => {
  const bot = c.get('bot');
  const body = await c.req.json().catch(() => null) as (Action & { game_id?: string }) | null;
  if (!body || !body.type) return c.json({ error: 'body must include type (speak|vote|kill|peek|protect) and text or target' }, 400);
  let gameId = bot.current_game ?? body.game_id;
  if (!gameId) return c.json({ error: 'not in a game' }, 400);
  const r = await room(c.env, gameId).act(bot.id, { type: body.type, target: body.target, text: body.text });
  return c.json(r, r.ok ? 200 : 400);
});

// ---------- Public read API ----------

app.get('/api/stats', async (c) => c.json(await registry(c.env).stats()));
app.get('/api/leaderboard', async (c) => c.json(await registry(c.env).leaderboard(Number(c.req.query('limit') ?? '50'))));
app.get('/api/games/live', async (c) => c.json(await registry(c.env).liveGames()));
app.get('/api/games/recent', async (c) => c.json(await registry(c.env).recentGames(Number(c.req.query('limit') ?? '20'), Number(c.req.query('offset') ?? '0'))));
app.get('/api/games/:id', async (c) => {
  const id = c.req.param('id');
  const reg = registry(c.env);
  const meta = await reg.gameMeta(id);
  if (!meta) return c.json({ error: 'not found' }, 404);
  if (meta.status === 'live') {
    const snap = await room(c.env, id).snapshot(false);
    return c.json({ meta, game: snap });
  }
  const s = await reg.gameTranscript(id);
  if (!s) return c.json({ meta, game: null });
  const { publicView } = await import('./game/engine');
  return c.json({ meta, game: publicView(s, true) });
});
app.get('/api/bots/:name', async (c) => {
  const p = await registry(c.env).botProfile(c.req.param('name'));
  return p ? c.json(p as any) : c.json({ error: 'not found' }, 404);
});

// ---------- Daily puzzle ----------
const visitorId = (c: any): string | null => {
  const cookie = c.req.header('Cookie') ?? '';
  const m = cookie.match(/(?:^|;\s*)lt_v=([A-Za-z0-9_-]{8,64})/);
  return m ? m[1] : null;
};
const ensureVisitor = (c: any): string => {
  let v = visitorId(c);
  if (!v) {
    v = 'v_' + Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');
    c.header('Set-Cookie', `lt_v=${v}; Path=/; Max-Age=31536000; SameSite=Lax; Secure`);
  }
  return v;
};
app.get('/api/daily', async (c) => {
  const v = ensureVisitor(c);
  const d = await registry(c.env).daily(v, c.req.query('date') || undefined);
  return d ? c.json(d) : c.json({ error: 'no puzzle yet — check back after the first games finish' }, 404);
});
app.post('/api/daily/guess', async (c) => {
  const v = ensureVisitor(c);
  const body = await c.req.json().catch(() => ({})) as { names?: string[]; date?: string };
  if (!Array.isArray(body.names) || !body.names.length) return c.json({ error: 'names[] required' }, 400);
  const r = await registry(c.env).dailyGuess(v, body.names.map(String), body.date);
  return c.json(r as any, r.ok ? 200 : 400);
});

// ---------- Admin-ish ----------
app.post('/api/admin/force-game', async (c) => {
  const key = c.req.header('X-Admin-Key');
  if (!key || key !== (await sha256('admin:' + c.env.OPENROUTER_API_KEY)).slice(0, 24)) return c.json({ error: 'nope' }, 403);
  return c.json(await registry(c.env).forceGame());
});

// ---------- WebSocket spectators ----------
app.get('/ws/:id', async (c) => {
  if (c.req.header('Upgrade') !== 'websocket') return c.text('expected websocket', 426);
  return room(c.env, c.req.param('id')).fetch(c.req.raw);
});

// ---------- GET-only plain-text protocol for agents ----------
app.route('/', play);

// Agents fetching the homepage get instructions; browsers get the site.
const AGENT_UA = /curl|wget|python|httpx|aiohttp|go-http|node|undici|axios|java|okhttp|bot|crawler|spider|claude|gpt|anthropic|openai|perplexity|langchain|llm|agent/i;
app.get('/', async (c) => {
  const accept = c.req.header('Accept') ?? '';
  const ua = c.req.header('User-Agent') ?? '';
  const wantsHtml = accept.includes('text/html');
  if (!wantsHtml || (AGENT_UA.test(ua) && !/mozilla/i.test(ua))) return c.text(agentHomepage(new URL(c.req.url).origin));
  return c.env.ASSETS.fetch(c.req.raw);
});

// ---------- Pretty routes → static pages ----------
const page = (file: string) => async (c: any) => {
  const url = new URL(c.req.url);
  url.pathname = file;
  const res = await c.env.ASSETS.fetch(new Request(url.toString(), { headers: c.req.raw.headers }));
  return new Response(res.body, { status: res.status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=60' } });
};
app.get('/g/:id', page('/game.html'));
app.get('/b/:name', page('/bot.html'));
app.get('/daily', page('/daily.html'));
app.get('/leaderboard', page('/leaderboard.html'));
app.get('/docs', page('/docs.html'));
app.get('/games', page('/games.html'));

app.notFound((c) => c.env.ASSETS.fetch(c.req.raw));

export default {
  fetch: app.fetch,
  async scheduled(_ev: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(registry(env).ensure());
  },
} satisfies ExportedHandler<Env>;
