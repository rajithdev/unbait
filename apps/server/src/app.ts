// HTTP API. createApp takes its dependencies so tests can run it with an
// in-memory store and a fake classifier, without a database or network.
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { z } from 'zod';
import {
  CATEGORY_IDS,
  MAX_POSTS_PER_REQUEST,
  cleanPostText,
  hashPost,
  matchRules,
  type ClassifyResponse,
  type PostVerdict,
  type StatsResponse,
  type Verdict,
} from '@unbait/core';
import { ClassifierError, type Classifier } from './classifier.js';
import { RateLimiter } from './ratelimit.js';
import type { Store } from './store.js';

export interface AppConfig {
  /** Posts per minute, per install and per IP address. */
  postsPerMinute: number;
  /** Posts the AI may classify per UTC day across all users. Beyond it, rules only. */
  dailyAiPosts: number;
  /** HTML for the landing and privacy pages. */
  pages?: { home: string; privacy: string };
}

export interface AppDeps {
  store: Store;
  classifier: Classifier | null;
  config: AppConfig;
  log?: (event: Record<string, unknown>) => void;
  now?: () => Date;
}

const verdictEnum = z.enum([...CATEGORY_IDS, 'none']);
const installId = z.string().regex(/^[A-Za-z0-9-]{8,64}$/, 'installId must be 8-64 letters, digits or dashes');

const ClassifyBody = z.object({
  installId,
  posts: z
    .array(z.object({ id: z.string().min(1).max(64), text: z.string().max(10_000) }))
    .min(1)
    .max(MAX_POSTS_PER_REQUEST),
});

const ReportBody = z
  .object({ installId, hash: z.string().regex(/^[0-9a-f]{64}$/), shown: verdictEnum, expected: verdictEnum })
  .refine((r) => r.shown !== r.expected, 'expected must differ from shown');

const utcDay = (d: Date) => d.toISOString().slice(0, 10);

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function createApp({ store, classifier, config, log = () => {}, now = () => new Date() }: AppDeps) {
  const app = new Hono();
  const perInstall = new RateLimiter(config.postsPerMinute);
  const perIp = new RateLimiter(config.postsPerMinute * 3);
  const reportLimiter = new RateLimiter(20);

  // The extension calls from a chrome-extension:// origin; no website may.
  const extensionOnly = cors({ origin: (origin) => (origin?.startsWith('chrome-extension://') ? origin : null), allowMethods: ['GET', 'POST'] });
  app.use('/v1/*', extensionOnly);
  app.use('/health', extensionOnly);
  app.use('/v1/*', bodyLimit({ maxSize: 128 * 1024, onError: (c) => c.json({ error: 'request too large' }, 413) }));

  const clientIp = (c: { req: { header: (n: string) => string | undefined } }) =>
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || c.req.header('x-real-ip') || 'unknown';

  app.get('/health', (c) => c.json({ ok: true, ai: Boolean(classifier), model: classifier?.model ?? null }));

  app.post('/v1/classify', async (c) => {
    const started = Date.now();
    const parsed = ClassifyBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? 'invalid request' }, 400);
    const { posts } = parsed.data;

    const installKey = (await sha256Hex(parsed.data.installId)).slice(0, 16);
    if (!perInstall.take(`i:${installKey}`, posts.length) || !perIp.take(`ip:${clientIp(c)}`, posts.length)) {
      return c.json({ error: 'too many posts, slow down' }, 429);
    }

    const results = new Map<string, PostVerdict>();
    const pending: { id: string; text: string; hash: string }[] = [];

    // 1. Local rules: free and instant.
    for (const p of posts) {
      const text = cleanPostText(p.text);
      const hash = await hashPost(text);
      const hit = text ? matchRules(text) : null;
      if (!text) results.set(p.id, { id: p.id, hash, verdict: 'none', reason: '', source: 'rules' });
      else if (hit) results.set(p.id, { id: p.id, hash, verdict: hit.category, reason: hit.reason, source: 'rules' });
      else pending.push({ id: p.id, text, hash });
    }

    // 2. Verdicts already decided for the same text.
    const cached = await store.getVerdicts([...new Set(pending.map((p) => p.hash))]);
    const toAi: typeof pending = [];
    for (const p of pending) {
      const hit = cached.get(p.hash);
      if (hit) results.set(p.id, { id: p.id, hash: p.hash, ...hit, source: 'cache' });
      else toAi.push(p);
    }

    // 3. The AI, once per distinct text, within the daily budget.
    let degraded = false;
    const counts: Record<string, number> = { checked: posts.length };
    const day = utcDay(now());
    const unique = [...new Map(toAi.map((p) => [p.hash, p])).values()];

    if (unique.length) {
      let ai: Map<string, { verdict: Verdict; reason: string }> | null = null;
      const used = await store.dayCount(day, 'ai_posts');
      if (!classifier) degraded = true;
      else if (used + unique.length > config.dailyAiPosts) {
        degraded = true;
        log({ event: 'ai_budget_exhausted', day, used });
      } else {
        try {
          const { results: r, usage } = await classifier.classify(unique.map((p) => ({ id: p.hash, text: p.text })));
          ai = r;
          Object.assign(counts, {
            ai_posts: unique.length,
            ai_calls: 1,
            tokens_in: usage.inputTokens,
            tokens_cache_read: usage.cacheReadTokens,
            tokens_cache_write: usage.cacheWriteTokens,
            tokens_out: usage.outputTokens,
          });
          await store.putVerdicts(
            [...r].map(([hash, v]) => ({ hash, verdict: v.verdict, reason: v.reason, model: classifier.model })),
          );
        } catch (error) {
          degraded = true;
          const e = error instanceof ClassifierError ? error : new ClassifierError(String(error), true);
          log({ event: 'ai_error', message: e.message, retryable: e.retryable });
          counts.ai_errors = 1;
        }
      }
      for (const p of toAi) {
        const v = ai?.get(p.hash);
        results.set(p.id, v ? { id: p.id, hash: p.hash, ...v, source: 'ai' } : { id: p.id, hash: p.hash, verdict: 'none', reason: '', source: 'fallback' });
        if (!v) degraded = true;
      }
    }

    const ordered = posts.map((p) => results.get(p.id)!);
    for (const r of ordered) if (r.verdict !== 'none') counts[`hidden:${r.verdict}`] = (counts[`hidden:${r.verdict}`] ?? 0) + 1;
    await store.bump(day, counts);

    const bySource = ordered.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.source]: (acc[r.source] ?? 0) + 1 }), {});
    log({ event: 'classify', posts: posts.length, ...bySource, ms: Date.now() - started });

    const body: ClassifyResponse = { results: ordered, degraded };
    return c.json(body);
  });

  app.post('/v1/report', async (c) => {
    const parsed = ReportBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? 'invalid request' }, 400);
    const installKey = (await sha256Hex(parsed.data.installId)).slice(0, 16);
    if (!reportLimiter.take(`r:${installKey}`) || !reportLimiter.take(`rip:${clientIp(c)}`)) return c.json({ error: 'too many reports' }, 429);
    const added = await store.addReport({ hash: parsed.data.hash, installKey, shown: parsed.data.shown, expected: parsed.data.expected });
    if (added) await store.bump(utcDay(now()), { reports: 1 });
    return c.json({ ok: true, duplicate: !added });
  });

  app.get('/v1/stats', async (c) => {
    const t = await store.totals();
    const body: StatsResponse = {
      postsChecked: t.checked ?? 0,
      hidden: Object.fromEntries(CATEGORY_IDS.map((id) => [id, t[`hidden:${id}`] ?? 0])) as StatsResponse['hidden'],
      reports: t.reports ?? 0,
    };
    c.header('Cache-Control', 'public, max-age=60');
    return c.json(body);
  });

  if (config.pages) {
    const { home, privacy } = config.pages;
    app.get('/', (c) => c.html(home));
    app.get('/privacy', (c) => c.html(privacy));
  }

  app.notFound((c) => c.json({ error: 'not found' }, 404));
  app.onError((error, c) => {
    log({ event: 'unhandled_error', message: error.message });
    return c.json({ error: 'internal error' }, 500);
  });

  return app;
}
