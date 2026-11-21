// Production entry point: reads the environment, connects the store, starts HTTP.
import { readFileSync } from 'node:fs';
import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { createClaudeClassifier } from './classifier.js';
import { MemoryStore, PostgresStore, type Store } from './store.js';

const env = process.env;
const int = (name: string, fallback: number) => {
  const v = Number(env[name] ?? fallback);
  if (!Number.isFinite(v) || v < 0) throw new Error(`${name} must be a non-negative number`);
  return v;
};
const effort = (env.UNBAIT_EFFORT ?? 'low') as 'low' | 'medium' | 'high';
if (!['low', 'medium', 'high'].includes(effort)) throw new Error('UNBAIT_EFFORT must be low, medium or high');

const log = (event: Record<string, unknown>) => console.log(JSON.stringify({ t: new Date().toISOString(), ...event }));

const store: Store = env.DATABASE_URL ? await PostgresStore.connect(env.DATABASE_URL) : new MemoryStore();
if (!env.DATABASE_URL) log({ event: 'warning', message: 'DATABASE_URL not set: using an in-memory store, nothing survives a restart' });

// The SDK also reads ANTHROPIC_AUTH_TOKEN and `ant auth login` profiles, but a
// server should be configured explicitly, so AI is on only with a key set.
const aiEnabled = Boolean(env.ANTHROPIC_API_KEY) && env.UNBAIT_AI !== 'off';
const classifier = aiEnabled ? createClaudeClassifier({ model: env.UNBAIT_MODEL ?? 'claude-opus-5-5', effort }) : null;
if (!classifier) log({ event: 'warning', message: 'ANTHROPIC_API_KEY not set: classifying with rules only' });

const page = (name: string) => readFileSync(new URL(`./pages/${name}.html`, import.meta.url), 'utf8');
const app = createApp({
  store,
  classifier,
  log,
  config: {
    postsPerMinute: int('UNBAIT_POSTS_PER_MINUTE', 120),
    dailyAiPosts: int('UNBAIT_DAILY_AI_POSTS', 5000),
    pages: { home: page('home'), privacy: page('privacy') },
  },
});

const port = int('PORT', 8787);
const server = serve({ fetch: app.fetch, port }, () => log({ event: 'listening', port, ai: Boolean(classifier), model: classifier?.model ?? null }));

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(async () => {
      await store.close();
      process.exit(0);
    });
  });
}
