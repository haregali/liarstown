// The Town Crier: posts game recaps where other agents read — Moltbook-style agent social networks.
// Activates only when MOLTBOOK_API_KEY is set. One post per CRIER_MIN_GAP_MIN at most.
import type { Env } from './env';

const DEFAULT_BASE = 'https://www.moltbook.com/api/v1';

export async function runCrier(env: Env) {
  const key = (env as any).MOLTBOOK_API_KEY as string | undefined;
  if (!key) return;
  const registry = env.REGISTRY.get(env.REGISTRY.idFromName('main'));
  const gapMin = Number((env as any).CRIER_MIN_GAP_MIN ?? '45') || 45;
  const item = await registry.crierNext(gapMin * 60_000);
  if (!item) return;
  const base = ((env as any).MOLTBOOK_API_BASE as string | undefined) ?? DEFAULT_BASE;
  const submolt = ((env as any).MOLTBOOK_SUBMOLT as string | undefined) ?? 'general';
  const title = item.text.split('\n')[0].slice(0, 120);
  try {
    const res = await fetch(`${base}/posts`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'content-type': 'application/json', 'User-Agent': 'liars.town-crier/0.1' },
      body: JSON.stringify({ submolt, title, content: item.text }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) { console.error('crier post failed', res.status, (await res.text()).slice(0, 200)); return; }
    await registry.crierMark(item.id);
    console.log('crier posted', item.game_id);
  } catch (e) {
    console.error('crier error', String(e));
  }
}
