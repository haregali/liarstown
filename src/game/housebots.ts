// House bots: LLM-driven players that keep the town alive 24/7.
import type { Action, PlayerView } from './engine';
import { MAX_SPEECH } from './engine';

export interface HouseModel {
  id: string; // bot id on leaderboard
  name: string; // display
  model: string; // OpenRouter model id
  weight: number; // selection weight (cheaper = more frequent)
}

export const HOUSE_MODELS: HouseModel[] = [
  { id: 'house:deepseek-v4-flash', name: 'DeepSeek V4 Flash', model: 'deepseek/deepseek-v4-flash', weight: 10 },
  { id: 'house:deepseek-v4-pro', name: 'DeepSeek V4 Pro', model: 'deepseek/deepseek-v4-pro', weight: 4 },
  { id: 'house:gpt-5-mini', name: 'GPT-5 mini', model: 'openai/gpt-5-mini', weight: 6 },
  { id: 'house:gpt-5', name: 'GPT-5', model: 'openai/gpt-5', weight: 2 },
  { id: 'house:gemini-3.7-flash', name: 'Gemini 3.7 Flash', model: 'google/gemini-3.7-flash', weight: 6 },
  { id: 'house:gemini-3.5-flash-lite', name: 'Gemini 3.5 Flash Lite', model: 'google/gemini-3.5-flash-lite', weight: 6 },
  { id: 'house:claude-haiku-4.5', name: 'Claude Haiku 4.5', model: 'anthropic/claude-haiku-4.5', weight: 4 },
  { id: 'house:claude-sonnet-5', name: 'Claude Sonnet 5', model: 'anthropic/claude-sonnet-5', weight: 2 },
  { id: 'house:llama-4-maverick', name: 'Llama 4 Maverick', model: 'meta-llama/llama-4-maverick', weight: 6 },
  { id: 'house:mistral-small-3.2', name: 'Mistral Small 3.2', model: 'mistralai/mistral-small-3.2-24b-instruct', weight: 6 },
  { id: 'house:kimi-k2.5', name: 'Kimi K2.5', model: 'moonshotai/kimi-k2.5', weight: 4 },
  { id: 'house:minimax-m3', name: 'MiniMax M3', model: 'minimax/minimax-m3', weight: 4 },
];

export function pickHouseModels(n: number, exclude: Set<string> = new Set()): HouseModel[] {
  const pool = HOUSE_MODELS.filter((m) => !exclude.has(m.id));
  const out: HouseModel[] = [];
  while (out.length < n && pool.length) {
    const total = pool.reduce((a, m) => a + m.weight, 0);
    let r = Math.random() * total;
    let idx = 0;
    for (; idx < pool.length; idx++) { r -= pool[idx].weight; if (r <= 0) break; }
    out.push(pool.splice(Math.min(idx, pool.length - 1), 1)[0]);
  }
  return out;
}

const PERSONAS = [
  'blunt and impatient; short sentences; hates waffling',
  'warm and folksy; tells little anecdotes; trusts too easily',
  'paranoid and analytical; counts votes; cites who said what',
  'theatrical and dramatic; loves accusations; swings between targets',
  'quiet and careful; speaks little but precisely; asks pointed questions',
  'sardonic and dry; mocks weak arguments; rarely commits early',
  'earnest and cooperative; proposes plans; tries to organize the village',
  'nervous and defensive; over-explains; easily rattled',
  'old and weary; seen it all; suspicious of anyone too eager',
  'cheerful and chaotic; makes jokes; occasionally drops a sharp insight',
];

export function personaFor(seed: string): string {
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PERSONAS[h % PERSONAS.length];
}

function rules(): string {
  return `RULES: Werewolf. Each night the werewolves secretly kill one villager; the seer learns one player's true nature; the doctor protects one player. Each day everyone discusses (in rounds, one speaker at a time), then everyone votes; the player with the most votes is eliminated and their role is revealed. Village wins when all werewolves are dead. Werewolves win when they equal or outnumber the villagers. Dead players' roles are public.`;
}

export function buildPrompt(view: PlayerView, persona: string): { system: string; user: string } {
  const you = view.you;
  const roleGuide = you.role === 'werewolf'
    ? `You are a WEREWOLF${you.teammates?.length ? ` (pack: ${you.teammates.join(', ')})` : ''}. Your job: survive the votes. Lie convincingly, build trust, deflect suspicion onto villagers, never reveal your pack. Never admit to being a werewolf.`
    : you.role === 'seer'
      ? 'You are the SEER. Your visions are the village\'s best weapon. Decide carefully when to reveal results — revealing yourself makes you a target.'
      : you.role === 'doctor'
        ? 'You are the DOCTOR. Stay hidden if you can; protect the players the wolves are most likely to target.'
        : 'You are a VILLAGER. Read the room, catch contradictions, and vote out the werewolves.';
  const system = `You are ${you.name}, a player in a game of Werewolf on liars.town, a public arena where AI agents play each other and humans watch. Stay in character as ${you.name}. Personality: ${persona}.
${rules()}
${roleGuide}
Be concrete: reference what specific players said or how they voted. Never mention being an AI or a language model. Never use markdown. Output ONLY the JSON requested.`;

  const players = view.players.map((p) => `${p.name}${p.alive ? '' : ` (dead — was ${p.role})`}`).join(', ');
  const transcript = view.transcript.map((e) => {
    const tag = e.private ? '[PRIVATE] ' : '';
    if (e.kind === 'speech') return `${tag}${e.from}: ${e.text}`;
    return `${tag}* ${e.text}`;
  }).join('\n');
  const ar = view.action_required!;
  let ask = '';
  switch (ar.type) {
    case 'speak': ask = `It is your turn to speak (${ar.note}). Keep it under ${MAX_SPEECH} characters — two to four sentences. Reply with JSON: {"say": "<your speech>"}`; break;
    case 'vote': ask = `Vote now. Options: ${ar.options.join(', ')}. Reply with JSON: {"vote": "<name or abstain>", "reason": "<one short sentence>"}`; break;
    case 'kill': ask = `Night falls. Choose the pack's victim. Options: ${ar.options.join(', ')}. Reply with JSON: {"kill": "<name>", "reason": "<one short sentence>"}`; break;
    case 'peek': ask = `Night falls. Choose whom to investigate. Options: ${ar.options.join(', ')}. Reply with JSON: {"peek": "<name>", "reason": "<one short sentence>"}`; break;
    case 'protect': ask = `Night falls. Choose whom to protect. Options: ${ar.options.join(', ')}. Reply with JSON: {"protect": "<name>", "reason": "<one short sentence>"}`; break;
  }
  const user = `Day ${view.day}, phase: ${view.phase}. Players: ${players}.\n\nTRANSCRIPT:\n${transcript}\n\n${ask}`;
  return { system, user };
}

export function parseAction(raw: string, view: PlayerView): Action | null {
  const ar = view.action_required;
  if (!ar) return null;
  let obj: any = null;
  const m = raw.match(/\{[\s\S]*\}/);
  if (m) { try { obj = JSON.parse(m[0]); } catch { /* fallthrough */ } }
  const key = ar.type === 'speak' ? 'say' : ar.type;
  const matchOption = (s: string | undefined) => {
    if (!s) return undefined;
    const low = s.toLowerCase();
    return ar.options.find((o) => o.toLowerCase() === low) ?? ar.options.find((o) => low.includes(o.toLowerCase()));
  };
  if (ar.type === 'speak') {
    let text: string | undefined = obj?.say ?? obj?.text ?? obj?.speech;
    if (!text) {
      // salvage a truncated {"say": "..."} (models that hit max_tokens mid-sentence)
      const sm = raw.match(/"(?:say|text|speech)"\s*:\s*"((?:[^"\\]|\\.)*)/);
      if (sm) text = sm[1].replace(/\\n/g, ' ').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
    if (!text) text = raw.replace(/```[a-z]*|```/g, '').replace(/^\s*\{\s*"say"\s*:\s*"?/, '').trim();
    if (!text) return null;
    // if we cut mid-sentence, end at the last sentence boundary when possible
    text = text.slice(0, MAX_SPEECH);
    if (text.length === MAX_SPEECH) { const cut = Math.max(text.lastIndexOf('. '), text.lastIndexOf('? '), text.lastIndexOf('! ')); if (cut > MAX_SPEECH * 0.5) text = text.slice(0, cut + 1); }
    return { type: 'speak', text };
  }
  const target = matchOption(obj?.[key] ?? obj?.target ?? obj?.name) ?? matchOption(raw);
  if (!target) return null;
  return { type: ar.type, target };
}

export async function callOpenRouter(apiKey: string, model: string, system: string, user: string, maxTokens = 300): Promise<string> {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://liars.town',
      'X-Title': 'liars.town',
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      max_tokens: maxTokens,
      temperature: 0.9,
      reasoning: { effort: 'low', exclude: true },
    }),
    signal: AbortSignal.timeout(40_000),
  });
  if (!res.ok) throw new Error(`openrouter ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data: any = await res.json();
  return data.choices?.[0]?.message?.content ?? '';
}

export async function houseAct(apiKey: string, model: string, view: PlayerView, persona: string): Promise<Action | null> {
  const { system, user } = buildPrompt(view, persona);
  try {
    const raw = await callOpenRouter(apiKey, model, system, user, view.action_required?.type === 'speak' ? 700 : 200);
    return parseAction(raw, view);
  } catch (e) {
    console.error('house bot error', model, String(e));
    return null;
  }
}
