// Runs against memory always, and against Postgres when TEST_DATABASE_URL is set.
import { afterAll, describe, expect, test } from 'vitest';
import { MemoryStore, PostgresStore, type Store } from '../src/store.js';

const h = (c: string) => c.repeat(64);
const targets: [string, () => Promise<Store>][] = [['memory', async () => new MemoryStore()]];
if (process.env.TEST_DATABASE_URL) targets.push(['postgres', () => PostgresStore.connect(process.env.TEST_DATABASE_URL!)]);

describe.each(targets)('%s store', (_name, make) => {
  let store: Store;
  afterAll(async () => store?.close());

  test('round-trips verdicts and counters', async () => {
    store = await make();
    const run = Math.random().toString(16).slice(2, 10);
    const a = h('a').slice(0, 56) + run, b = h('b').slice(0, 56) + run;
    await store.putVerdicts([{ hash: a, verdict: 'hype_listicle', reason: 'A hype list', model: 'm' }]);
    await store.putVerdicts([{ hash: a, verdict: 'none', reason: '', model: 'm2' }]);
    const got = await store.getVerdicts([a, b]);
    expect(got.get(a)).toEqual({ verdict: 'none', reason: '' });
    expect(got.has(b)).toBe(false);

    const day = `2099-01-${String(1 + (parseInt(run.slice(0, 2), 16) % 28)).padStart(2, '0')}`;
    const before = await store.dayCount(day, `k${run}`);
    await store.bump(day, { [`k${run}`]: 2, zero: 0 });
    await store.bump(day, { [`k${run}`]: 3 });
    expect(await store.dayCount(day, `k${run}`)).toBe(before + 5);
    expect((await store.totals())[`k${run}`]).toBe(5);

    expect(await store.addReport({ hash: a, installKey: run, shown: 'none', expected: 'hype_listicle' })).toBe(true);
    expect(await store.addReport({ hash: a, installKey: run, shown: 'none', expected: 'hype_listicle' })).toBe(false);
  });
});
