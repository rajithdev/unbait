import { describe, expect, test, vi } from 'vitest';
import { hashPost } from '@unbait/core';
import { createApp, type AppConfig } from '../src/app.js';
import { ClassifierError, type AiResult, type Classifier } from '../src/classifier.js';
import { MemoryStore } from '../src/store.js';

const INSTALL = 'test-install-0001';
const config: AppConfig = { postsPerMinute: 100, dailyAiPosts: 1000 };

function fakeClassifier(impl?: Classifier['classify']): Classifier & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    model: 'fake-model',
    calls,
    classify: vi.fn(async (posts: { id: string; text: string }[]) => {
      calls.push(posts.map((p) => p.text));
      if (impl) return impl(posts);
      return {
        results: new Map<string, AiResult>(posts.map((p) => [p.id, p.text.includes('BAIT') ? { verdict: 'engagement_bait', reason: 'Fishes for reactions' } : { verdict: 'none', reason: '' }])),
        usage: { inputTokens: 100, cacheReadTokens: 900, cacheWriteTokens: 0, outputTokens: 20 },
      };
    }),
  };
}

function setup(opts: { classifier?: Classifier | null; config?: Partial<AppConfig> } = {}) {
  const store = new MemoryStore();
  const classifier = opts.classifier === undefined ? fakeClassifier() : opts.classifier;
  const app = createApp({ store, classifier, config: { ...config, ...opts.config } });
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    app.request(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } });
  const classify = async (posts: { id: string; text: string }[]) => {
    const res = await post('/v1/classify', { installId: INSTALL, posts });
    return { status: res.status, body: (await res.json()) as any };
  };
  return { app, store, classifier, post, classify };
}

describe('POST /v1/classify', () => {
  test('rules catch obvious bait without calling the AI', async () => {
    const { classify, classifier } = setup();
    const { status, body } = await classify([{ id: 'a', text: 'Comment "PDF" and I\'ll send it to you.' }]);
    expect(status).toBe(200);
    expect(body.results[0]).toMatchObject({ id: 'a', verdict: 'comment_gate', source: 'rules' });
    expect(body.results[0].hash).toBe(await hashPost('Comment "PDF" and I\'ll send it to you.'));
    expect((classifier as any).calls).toHaveLength(0);
  });

  test('the AI decides the rest, and repeats come from the cache', async () => {
    const { classify, classifier } = setup();
    const first = await classify([
      { id: 'a', text: 'Some BAIT the rules miss' },
      { id: 'b', text: 'A normal post about our database migration' },
    ]);
    expect(first.body.results.map((r: any) => [r.id, r.verdict, r.source])).toEqual([
      ['a', 'engagement_bait', 'ai'],
      ['b', 'none', 'ai'],
    ]);
    expect(first.body.degraded).toBe(false);
    const again = await classify([{ id: 'c', text: 'Some   BAIT the rules miss' }]);
    expect(again.body.results[0]).toMatchObject({ id: 'c', verdict: 'engagement_bait', source: 'cache' });
    expect((classifier as any).calls).toHaveLength(1);
  });

  test('identical posts in one request are classified once', async () => {
    const { classify, classifier } = setup();
    const { body } = await classify([
      { id: 'a', text: 'same text' },
      { id: 'b', text: 'same text' },
    ]);
    expect(body.results.map((r: any) => r.source)).toEqual(['ai', 'ai']);
    expect((classifier as any).calls[0]).toEqual(['same text']);
  });

  test('falls back to showing the post when the AI fails', async () => {
    const { classify } = setup({ classifier: fakeClassifier(async () => { throw new ClassifierError('boom', true); }) });
    const { status, body } = await classify([{ id: 'a', text: 'hmm' }]);
    expect(status).toBe(200);
    expect(body).toMatchObject({ degraded: true, results: [{ id: 'a', verdict: 'none', source: 'fallback' }] });
  });

  test('a post the AI leaves out is shown, not guessed', async () => {
    const { classify } = setup({
      classifier: fakeClassifier(async () => ({ results: new Map(), usage: { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 } })),
    });
    const { body } = await classify([{ id: 'a', text: 'hmm' }]);
    expect(body).toMatchObject({ degraded: true, results: [{ verdict: 'none', source: 'fallback' }] });
  });

  test('without an AI key the server works on rules only', async () => {
    const { classify } = setup({ classifier: null });
    const { body } = await classify([
      { id: 'a', text: 'Tag someone who needs this.' },
      { id: 'b', text: 'Something subtle' },
    ]);
    expect(body.results.map((r: any) => r.source)).toEqual(['rules', 'fallback']);
    expect(body.degraded).toBe(true);
  });

  test('the daily AI budget is enforced', async () => {
    const { classify, classifier } = setup({ config: { dailyAiPosts: 2 } });
    await classify([{ id: 'a', text: 'one' }, { id: 'b', text: 'two' }]);
    const { body } = await classify([{ id: 'c', text: 'three' }]);
    expect(body.results[0].source).toBe('fallback');
    expect((classifier as any).calls).toHaveLength(1);
  });

  test('rejects bad input', async () => {
    const { post } = setup();
    expect((await post('/v1/classify', { installId: 'x', posts: [{ id: 'a', text: 'hi' }] })).status).toBe(400);
    expect((await post('/v1/classify', { installId: INSTALL, posts: [] })).status).toBe(400);
    expect((await post('/v1/classify', { installId: INSTALL, posts: Array.from({ length: 11 }, (_, i) => ({ id: String(i), text: 'x' })) })).status).toBe(400);
    expect((await post('/v1/classify', 'not json')).status).toBe(400);
  });

  test('rate limits per install', async () => {
    const { classify } = setup({ classifier: null, config: { postsPerMinute: 3 } });
    expect((await classify([{ id: 'a', text: '1' }, { id: 'b', text: '2' }, { id: 'c', text: '3' }])).status).toBe(200);
    expect((await classify([{ id: 'd', text: '4' }])).status).toBe(429);
  });

  test('allows calls from the extension and no other site', async () => {
    const { app } = setup();
    const preflight = (origin: string) =>
      app.request('/v1/classify', { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'POST' } });
    expect((await preflight('chrome-extension://abcdef')).headers.get('access-control-allow-origin')).toBe('chrome-extension://abcdef');
    expect((await preflight('https://evil.example')).headers.get('access-control-allow-origin')).toBeNull();
    const health = await app.request('/health', { headers: { origin: 'chrome-extension://abcdef' } });
    expect(health.headers.get('access-control-allow-origin')).toBe('chrome-extension://abcdef');
  });
});

describe('reports and stats', () => {
  test('a report is counted once per install and post', async () => {
    const { post, app, classify } = setup();
    await classify([{ id: 'a', text: 'Tag someone who needs this.' }, { id: 'b', text: 'normal' }]);
    const hash = await hashPost('normal');
    const report = { installId: INSTALL, hash, shown: 'engagement_bait', expected: 'none' };
    expect(await (await post('/v1/report', report)).json()).toEqual({ ok: true, duplicate: false });
    expect(await (await post('/v1/report', report)).json()).toEqual({ ok: true, duplicate: true });
    expect((await post('/v1/report', { ...report, expected: 'engagement_bait' })).status).toBe(400);

    const stats = await (await app.request('/v1/stats')).json();
    expect(stats).toEqual({
      postsChecked: 2,
      hidden: { comment_gate: 0, engagement_bait: 1, cliffhanger_story: 0, hype_listicle: 0 },
      reports: 1,
    });
  });

  test('health reports whether the AI is on', async () => {
    expect(await (await setup().app.request('/health')).json()).toEqual({ ok: true, ai: true, model: 'fake-model' });
    expect(await (await setup({ classifier: null }).app.request('/health')).json()).toEqual({ ok: true, ai: false, model: null });
  });
});
