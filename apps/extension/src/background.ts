// Service worker: the only part that talks to the network, and only in AI mode.
import { MAX_POSTS_PER_REQUEST, type CategoryId, type ClassifyResponse } from '@unbait/core';
import type { ClassifyReply, HealthReply, RemoteVerdict, Request } from './messages.js';
import { emptyStats, loadSettings, localDay, type Stats } from './settings.js';

const CACHE_KEY = 'verdicts';
const CACHE_MAX = 5000;
const TIMEOUT_MS = 25_000;
const SEEN_MAX = 5000;

type CacheEntry = RemoteVerdict & { t: number };

async function installId(): Promise<string> {
  const { installId } = await chrome.storage.local.get('installId');
  if (typeof installId === 'string') return installId;
  const id = crypto.randomUUID();
  await chrome.storage.local.set({ installId: id });
  return id;
}

async function api<T>(base: string, path: string, body?: unknown): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${base}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(res.status === 429 ? 'The Unbait server is busy' : `The Unbait server answered ${res.status}`);
    return (await res.json()) as T;
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw new Error('The Unbait server took too long to answer');
    throw error instanceof TypeError ? new Error('Could not reach the Unbait server') : error;
  } finally {
    clearTimeout(timer);
  }
}

async function classify(posts: { hash: string; text: string }[]): Promise<ClassifyReply> {
  const settings = await loadSettings();
  if (settings.mode !== 'ai') return { verdicts: {} };

  const stored = (await chrome.storage.local.get(CACHE_KEY))[CACHE_KEY] as Record<string, CacheEntry> | undefined;
  const cache = stored ?? {};
  const verdicts: Record<string, RemoteVerdict> = {};
  const missing = posts.filter((p) => {
    const hit = cache[p.hash];
    if (hit) verdicts[p.hash] = { verdict: hit.verdict, reason: hit.reason, source: 'cache' };
    return !hit;
  });

  let problem: string | undefined;
  const id = await installId();
  for (let i = 0; i < missing.length; i += MAX_POSTS_PER_REQUEST) {
    const chunk = missing.slice(i, i + MAX_POSTS_PER_REQUEST);
    try {
      const res = await api<ClassifyResponse>(settings.apiUrl, '/v1/classify', {
        installId: id,
        posts: chunk.map((p) => ({ id: p.hash, text: p.text })),
      });
      for (const r of res.results) {
        verdicts[r.id] = { verdict: r.verdict, reason: r.reason, source: r.source };
        // A fallback is "we couldn't decide", not an answer: don't keep it.
        if (r.source !== 'fallback') cache[r.id] = { verdict: r.verdict, reason: r.reason, source: r.source, t: Date.now() };
      }
      if (res.degraded) problem = 'The AI was unavailable for some posts, so they were shown';
    } catch (error) {
      problem = (error as Error).message;
      break;
    }
  }

  const entries = Object.entries(cache);
  const trimmed = entries.length > CACHE_MAX ? Object.fromEntries(entries.sort((a, b) => b[1].t - a[1].t).slice(0, CACHE_MAX)) : cache;
  await chrome.storage.local.set({ [CACHE_KEY]: trimmed, lastProblem: problem ?? null });
  return { verdicts, problem };
}

/**
 * Stats count distinct posts: the same post seen again after a reload, or in
 * another tab, is not counted twice. The hashes are kept locally, capped.
 */
async function count(checked: string[], hidden: { hash: string; category: CategoryId }[]) {
  const today = localDay();
  const saved = (await chrome.storage.local.get(['stats', 'seen'])) as { stats?: Stats; seen?: { checked: string[]; hidden: string[] } };
  const stats: Stats = saved.stats ?? emptyStats(today);
  if (stats.day !== today) Object.assign(stats, { day: today, today: 0 });
  const seenChecked = new Set(saved.seen?.checked ?? []);
  const seenHidden = new Set(saved.seen?.hidden ?? []);

  for (const h of checked) {
    if (seenChecked.has(h)) continue;
    seenChecked.add(h);
    stats.checked++;
  }
  for (const { hash, category } of hidden) {
    if (seenHidden.has(hash)) continue;
    seenHidden.add(hash);
    stats.today++;
    stats.total++;
    stats.byCategory[category] = (stats.byCategory[category] ?? 0) + 1;
  }
  const keep = (set: Set<string>) => [...set].slice(-SEEN_MAX);
  await chrome.storage.local.set({ stats, seen: { checked: keep(seenChecked), hidden: keep(seenHidden) } });
  await updateBadge(stats);
}

async function updateBadge(stats?: Stats) {
  const s = stats ?? ((await chrome.storage.local.get('stats')).stats as Stats | undefined);
  const n = s && s.day === localDay() ? s.today : 0;
  await chrome.action.setBadgeBackgroundColor({ color: '#0a66c2' });
  await chrome.action.setBadgeText({ text: n ? String(n > 999 ? '999+' : n) : '' });
}

async function handle(message: Request): Promise<unknown> {
  switch (message.type) {
    case 'classify':
      return classify(message.posts);
    case 'report': {
      const settings = await loadSettings();
      if (settings.mode !== 'ai') return { ok: false };
      return api(settings.apiUrl, '/v1/report', { installId: await installId(), hash: message.hash, shown: message.shown, expected: message.expected }).catch(() => ({ ok: false }));
    }
    case 'count':
      return count(message.checked, message.hidden);
    case 'health': {
      const settings = await loadSettings();
      return api<{ ok: boolean; ai: boolean }>(settings.apiUrl, '/health')
        .then((h): HealthReply => ({ ok: h.ok, ai: h.ai }))
        .catch((error): HealthReply => ({ ok: false, error: (error as Error).message }));
    }
  }
}

chrome.runtime.onMessage.addListener((message: Request, _sender, reply) => {
  handle(message).then(reply, (error) => reply({ error: String(error) }));
  return true; // keep the channel open for the async reply
});

chrome.runtime.onStartup.addListener(() => void updateBadge());
chrome.runtime.onInstalled.addListener(() => void updateBadge());
