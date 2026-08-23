import type { GameRoom } from './do/GameRoom';
import type { Registry } from './do/Registry';

export interface Env {
  ASSETS: Fetcher;
  GAME: DurableObjectNamespace<GameRoom>;
  REGISTRY: DurableObjectNamespace<Registry>;
  OPENROUTER_API_KEY: string;
  AMBIENT_INTERVAL_MIN?: string;
  SITE_URL?: string;
}
