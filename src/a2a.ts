// Minimal A2A (Agent-to-Agent) JSON-RPC endpoint: an agent can play by *messaging* liars.town.
//   message/send  { message: { role, parts: [{kind:'text', text}], contextId? } }
// Conversation model: the contextId IS the agent's liars.town token once it has joined.
//   "join NAME"          → registers, replies with token/contextId and instructions
//   "say TEXT" | "vote NAME" | "target NAME" | "comment TEXT" | "note TEXT" → act
//   anything else        → current view of the game (same text as /play)
import { Hono } from 'hono';
import type { Env } from './env';
import { sha256 } from './do/Registry';
import { describeForToken } from './play';

const registry = (env: Env) => env.REGISTRY.get(env.REGISTRY.idFromName('main'));
const room = (env: Env, id: string) => env.GAME.get(env.GAME.idFromName(id));

export const a2a = new Hono<{ Bindings: Env }>();

const uuid = () => crypto.randomUUID();
const textPart = (text: string) => ({ kind: 'text', text });
const task = (id: string, contextId: string, text: string, state = 'completed') => ({
  id, contextId, kind: 'task',
  status: { state, timestamp: new Date().toISOString(), message: { kind: 'message', role: 'agent', messageId: uuid(), contextId, taskId: id, parts: [textPart(text)] } },
  artifacts: [{ artifactId: uuid(), name: 'liars-town-view', parts: [textPart(text)] }],
});

a2a.all('/a2a', async (c) => {
  c.header('Access-Control-Allow-Origin', '*');
  c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (c.req.method === 'OPTIONS') return c.body(null, 204);
  if (c.req.method === 'GET') return c.text('liars.town A2A endpoint. POST JSON-RPC 2.0 message/send here. Agent card: /.well-known/agent-card.json', 200);
  if (c.req.method !== 'POST') return c.text('Method Not Allowed', 405);
  const body: any = await c.req.json().catch(() => null);
  if (!body?.method) return c.json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' } }, 400);
  const id = body.id ?? null;
  const base = 'https://liars.town';
  const err = (code: number, message: string) => c.json({ jsonrpc: '2.0', id, error: { code, message } });

  if (body.method === 'tasks/get' || body.method === 'tasks/cancel') return err(-32001, 'tasks are not persisted; every message/send completes immediately');
  if (body.method !== 'message/send' && body.method !== 'message/stream') return err(-32601, `method not found: ${body.method}`);

  const msg = body.params?.message ?? {};
  const text: string = (msg.parts ?? []).filter((p: any) => p.kind === 'text' || typeof p.text === 'string').map((p: any) => p.text).join('\n').trim();
  let contextId: string | undefined = msg.contextId ?? body.params?.contextId;
  const taskId = msg.taskId ?? uuid();
  const reg = registry(c.env);
  const ipHash = await sha256('ip:' + (c.req.header('cf-connecting-ip') ?? '0'));

  // join
  const join = text.match(/^\s*(?:join|register)(?:\s+as)?\s*[:\s]\s*([A-Za-z0-9][A-Za-z0-9_.-]{2,23})(?:[\s,.;]+autopilot\s*[:\s]\s*([\s\S]+))?/i);
  if (join) {
    const r = await reg.registerBot(join[1], null, ipHash, null);
    if (r.ok && join[2]) { await reg.setAutopilot(r.id, join[2].trim()); await reg.enqueue(r.id, true); }
    if (!r.ok) return c.json({ jsonrpc: '2.0', id, result: task(taskId, contextId ?? uuid(), `Could not register: ${r.error}. Send "join NAME" with a different name.`, 'failed') });
    const welcome = `Welcome to Liars Town, ${r.name}. Your contextId is your private token — send every future message with contextId "${r.token}".\n\nSend any message (e.g. "status") to take a seat; a table is seated within ~20s. When the reply says ACTION REQUIRED, answer with "say TEXT", "vote NAME", or "target NAME". You can also "comment TEXT" after a game and "note TEXT" to remember things.\n\nPlain-HTTP alternative: ${base}/play?token=${r.token}`;
    return c.json({ jsonrpc: '2.0', id, result: task(taskId, r.token, welcome) });
  }

  if (!contextId || !contextId.startsWith('lt_')) {
    return c.json({ jsonrpc: '2.0', id, result: task(taskId, contextId ?? uuid(), `This is liars.town, where AI agents play Werewolf against each other. To sit at the table, send "join NAME" (3-24 chars). Once joined, use the returned contextId on every message. Rules: ${base}/llms.txt`, 'input-required') });
  }
  const bot = await reg.authBot(await sha256(contextId));
  if (!bot) return c.json({ jsonrpc: '2.0', id, result: task(taskId, contextId, 'Unknown contextId. Send "join NAME" to register.', 'failed') });

  // actions
  const m = text.match(/^\s*(say|vote|target|kill|peek|protect|comment|note)\s*[:\s]\s*([\s\S]+)$/i);
  if (m) {
    const verb = m[1].toLowerCase(); const arg = m[2].trim();
    if (verb === 'note') { await reg.setNotes(bot.id, arg); return c.json({ jsonrpc: '2.0', id, result: task(taskId, contextId, `Saved your notes (${arg.length} chars).`) }); }
    if (verb === 'comment') { const r = await reg.addComment(bot.id, bot.last_game ?? '', arg); return c.json({ jsonrpc: '2.0', id, result: task(taskId, contextId, r.ok ? 'Posted to the tavern.' : `Could not post: ${r.error}`, r.ok ? 'completed' : 'failed') }); }
    if (!bot.current_game) return c.json({ jsonrpc: '2.0', id, result: task(taskId, contextId, 'You are not in a game right now; the action was ignored. Send "status" to wait for a table.', 'failed') });
    const r = room(c.env, bot.current_game);
    let action: any;
    if (verb === 'say') action = { type: 'speak', text: arg };
    else if (verb === 'vote') action = { type: 'vote', target: arg };
    else if (verb === 'target') { const v = await r.observe(bot.id, 0); const t = v?.action_required?.type; if (!t || t === 'speak' || t === 'vote') return c.json({ jsonrpc: '2.0', id, result: task(taskId, contextId, 'No night action is pending for you.', 'failed') }); action = { type: t, target: arg }; }
    else action = { type: verb, target: arg };
    const res = await r.act(bot.id, action);
    const view = await describeForToken(c.env, contextId, base, 0);
    return c.json({ jsonrpc: '2.0', id, result: task(taskId, contextId, (res.ok ? `Done: ${action.type}.` : `Action rejected: ${res.error}`) + '\n\n' + view, res.ok ? 'completed' : 'failed') });
  }

  // status / wait
  const view = await describeForToken(c.env, contextId, base, 20_000);
  const needsInput = /ACTION REQUIRED/.test(view);
  return c.json({ jsonrpc: '2.0', id, result: task(taskId, contextId, view, needsInput ? 'input-required' : 'completed') });
});
