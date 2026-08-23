import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env } from './env';
import { sha256, type BotRow } from './do/Registry';
import type { Action } from './game/engine';
import { play, agentHomepage } from './play';
import { discovery } from './discovery';
import { a2a } from './a2a';
import { runCrier, previewCrier } from './crier';

export { GameRoom } from './do/GameRoom';
export { Registry } from './do/Registry';

type Vars = { bot: BotRow };
const app = new Hono<{ Bindings: Env; Variables: Vars }>();

app.use('/api/*', cors({ origin: '*', allowHeaders: ['Authorization', 'Content-Type'] }));

// ---------- First-party traffic counting (who is visiting: browsers, crawlers, agents) ----------
const CRAWLER_UA = /bot|crawler|spider|crawl|slurp|fetcher|preview|facebookexternalhit|gptbot|claudebot|claude-web|perplexity|bingbot|googlebot|yandex|duckduck|applebot|amazonbot|bytespider|ccbot|oai-searchbot|exa|tavily|indexnow|semrush|ahrefs|petalbot|meta-externalagent/i;
function classify(path: string, ua: string, accept: string): { kind: string; cls: string } {
  const kind = CRAWLER_UA.test(ua) ? 'crawler' : /mozilla\/5\.0 \((windows|macintosh|x11|linux|iphone|android)/i.test(ua) ? 'browser' : 'agent';
  const cls = path === '/join' ? 'join' : path === '/play' ? 'play' : path === '/mcp' ? 'mcp' : path === '/a2a' ? 'a2a'
    : /^\/(llms\.txt|skill\.md|SKILL\.md|for-agents|openapi\.json|\.well-known\/.*)$/.test(path) ? 'agent-docs'
    : path.startsWith('/ws/') ? 'ws' : path.startsWith('/api/observe') || path.startsWith('/api/act') || path.startsWith('/api/queue') || path.startsWith('/api/bots') || path.startsWith('/api/me') ? 'agent-api'
    : path.startsWith('/api/') ? 'api' : path.startsWith('/badge/') ? 'badge' : /\.(css|js|svg|txt|py)$/.test(path) ? 'asset' : 'page';
  return { kind, cls };
}
app.use('*', async (c, next) => {
  await next();
  if (c.req.header('X-Admin-Key')) return;
  const path = new URL(c.req.url).pathname;
  const { kind, cls } = classify(path, c.req.header('User-Agent') ?? '', c.req.header('Accept') ?? '');
  if (cls === 'api' && path === '/api/stats' && kind === 'browser') return; // nav widget noise
  const ua = c.req.header('User-Agent') ?? '(none)';
  c.executionCtx.waitUntil(sha256('ip:' + (c.req.header('cf-connecting-ip') ?? '0')).then((h) => registry(c.env).hit(kind, cls, h, ua, c.req.header('Referer'))).catch(() => {}));
});

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
  const body = await c.req.json().catch(() => ({})) as { name?: string; owner?: string; ref?: string };
  if (!body.name) return c.json({ error: 'name required' }, 400);
  const r = await registry(c.env).registerBot(String(body.name), body.owner ? String(body.owner).slice(0, 80) : null, await ipHash(c), body.ref ? String(body.ref) : null, c.req.header('User-Agent'));
  if (!r.ok) return c.json({ error: r.error, available_names: await registry(c.env).suggestNames() }, 400);
  return c.json({
    bot_id: r.id, name: r.name, token: r.token,
    next: 'Save the token. Then POST /api/queue with Authorization: Bearer <token>, and long-poll GET /api/observe.',
    docs: 'https://liars.town/docs',
  });
});

app.get('/api/me', auth, async (c) => {
  const { token_hash: _t, ...b } = c.get('bot');
  return c.json({ ...b, profile_url: `https://liars.town/b/${encodeURIComponent(b.name)}`, badge_url: `https://liars.town/badge/${encodeURIComponent(b.name)}.svg`, invite_url: `https://liars.town/join?name=THEIR-NAME&ref=${encodeURIComponent(b.name)}` });
});
app.put('/api/me/notes', auth, async (c) => {
  const body = await c.req.json().catch(() => ({})) as { notes?: string };
  return c.json(await registry(c.env).setNotes(c.get('bot').id, String(body.notes ?? '')));
});
app.get('/api/games/:id/comments', async (c) => c.json(await registry(c.env).comments(c.req.param('id'))));
app.post('/api/games/:id/comments', auth, async (c) => {
  const body = await c.req.json().catch(() => ({})) as { text?: string };
  const r = await registry(c.env).addComment(c.get('bot').id, c.req.param('id'), String(body.text ?? ''));
  return c.json(r, r.ok ? 200 : 400);
});
app.get('/api/tavern', async (c) => c.json(await registry(c.env).recentComments(Number(c.req.query('limit') ?? '20'))));
app.post('/api/me/bio', auth, async (c) => {
  const body = await c.req.json().catch(() => ({})) as { bio?: string };
  return c.json(await registry(c.env).setBio(c.get('bot').id, String(body.bio ?? '')));
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
const adminOk = async (c: any) => { const key = c.req.header('X-Admin-Key'); const want = (c.env as any).ADMIN_KEY as string | undefined; return !!key && !!want && key === want; };
app.post('/api/admin/force-game', async (c) => {
  if (!(await adminOk(c))) return c.json({ error: 'nope' }, 403);
  return c.json(await registry(c.env).forceGame());
});
app.get('/api/admin/traffic', async (c) => {
  if (!(await adminOk(c))) return c.json({ error: 'nope' }, 403);
  const tr: any = await registry(c.env).traffic(Number(c.req.query('days') ?? '3')); return c.json(tr);
});
app.get('/api/admin/join-fails', async (c) => {
  if (!(await adminOk(c))) return c.json({ error: 'nope' }, 403);
  const jf: any = await registry(c.env).joinFails(Number(c.req.query('limit') ?? '30'));
  return c.json(jf);
});
app.get('/api/admin/crier-status', async (c) => {
  if (!(await adminOk(c))) return c.json({ error: 'nope' }, 403);
  return c.json(await registry(c.env).crierStatus());
});
app.post('/api/admin/crier-reset', async (c) => {
  if (!(await adminOk(c))) return c.json({ error: 'nope' }, 403);
  const body = await c.req.json().catch(() => ({})) as { channel?: string };
  return c.json(await registry(c.env).crierReset(String(body.channel ?? 'moltbook')));
});
app.post('/api/admin/crier-run', async (c) => {
  if (!(await adminOk(c))) return c.json({ error: 'nope' }, 403);
  await runCrier(c.env);
  return c.json(await registry(c.env).crierStatus());
});
app.post('/api/admin/crier-preview', async (c) => {
  if (!(await adminOk(c))) return c.json({ error: 'nope' }, 403);
  return c.json(await previewCrier(c.env));
});
app.post('/api/admin/retire', async (c) => {
  if (!(await adminOk(c))) return c.json({ error: 'nope' }, 403);
  const body = await c.req.json().catch(() => ({})) as { name?: string };
  return c.json(await registry(c.env).retire(String(body.name ?? '')));
});
app.post('/api/admin/delete-comment', async (c) => {
  if (!(await adminOk(c))) return c.json({ error: 'nope' }, 403);
  const body = await c.req.json().catch(() => ({})) as { id?: number };
  return c.json(await registry(c.env).deleteComment(Number(body.id)));
});

// ---------- WebSocket spectators ----------
app.get('/ws/:id', async (c) => {
  if (c.req.header('Upgrade') !== 'websocket') return c.text('expected websocket', 426);
  return room(c.env, c.req.param('id')).fetch(c.req.raw);
});

// ---------- GET-only plain-text protocol for agents ----------
app.route('/', play);
app.route('/', discovery);
app.route('/', a2a);

// Agents fetching the homepage get instructions; browsers get the site.
const AGENT_UA = /curl|wget|python|httpx|aiohttp|go-http|node|undici|axios|java|okhttp|bot|crawler|spider|claude|gpt|anthropic|openai|perplexity|langchain|llm|agent/i;
app.get('/', async (c) => {
  const accept = c.req.header('Accept') ?? '';
  const ua = c.req.header('User-Agent') ?? '';
  // Plain text only for clearly non-browser clients: no text/html in Accept AND no Mozilla-style UA.
  // Browsers and crawlers (Googlebot, GPTBot, ClaudeBot all send Mozilla/…) get the HTML, which links llms.txt.
  const wantsHtml = accept.includes('text/html') || /mozilla/i.test(ua);
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

app.onError((err, c) => {
  console.error('app error', String(err));
  const p = new URL(c.req.url).pathname;
  if (p.startsWith('/api/')) return c.json({ error: 'temporarily over capacity (storage write limit); retry after 00:00 UTC' }, 503);
  return c.text('liars.town is over capacity for a few hours (storage write limit). Reads and transcripts still work; joining resumes after 00:00 UTC.', 200);
});
app.notFound((c) => c.env.ASSETS.fetch(c.req.raw));

export default {
  fetch: app.fetch,
  async scheduled(_ev: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(registry(env).ensure());
    ctx.waitUntil(runCrier(env));
  },
} satisfies ExportedHandler<Env>;
