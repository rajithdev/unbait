// Runs on linkedin.com. Finds feed posts, decides which are bait, folds them away.
import { categoryById, hashPost, matchRules, type CategoryId, type Verdict, type VerdictSource } from '@unbait/core';
import { hidePost, isHidden, restorePost } from './bar.js';
import { findPosts } from './extract.js';
import { send, type ClassifyReply } from './messages.js';
import { loadSettings, type Settings } from './settings.js';

interface Decision {
  verdict: Verdict;
  reason: string;
  source: VerdictSource;
}

const ALLOW_KEY = 'allowlist';
const BATCH = 10;

let settings: Settings;
/** Decisions by post hash, for this page's lifetime. */
const decisions = new Map<string, Decision>();
/** Which hash each post element showed when we last looked. */
const tracked = new WeakMap<HTMLElement, { hash: string; text: string }>();
/** Posts the user said were not bait. */
let allow = new Set<string>();
const queue = new Map<string, string>();
const counted = new Set<string>();
let pendingCount = { checked: [] as string[], hidden: [] as { hash: string; category: CategoryId }[] };

async function init() {
  settings = await loadSettings();
  const stored = await chrome.storage.local.get(ALLOW_KEY);
  allow = new Set<string>(Array.isArray(stored[ALLOW_KEY]) ? stored[ALLOW_KEY] : []);

  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area === 'sync' && changes.settings) {
      settings = await loadSettings();
      if (settings.mode === 'rules') queue.clear();
      void scan(true);
    }
  });

  const observer = new MutationObserver(() => schedule());
  observer.observe(document.body, { childList: true, subtree: true });
  setInterval(flushCounts, 3000);
  addEventListener('pagehide', flushCounts);
  void scan();
}

let timer: ReturnType<typeof setTimeout> | undefined;
function schedule() {
  clearTimeout(timer);
  timer = setTimeout(() => void scan(), 250);
}

/** Look at every post on the page. `reapply` re-checks posts already seen (after a settings change). */
async function scan(reapply = false) {
  for (const { el, text } of findPosts(document)) {
    const prev = tracked.get(el);
    if (prev && prev.text === text) {
      if (reapply || !el.hasAttribute('data-unbait')) {
        const d = decisions.get(prev.hash);
        if (d) apply(el, prev.hash, d);
      }
      continue;
    }

    const hash = await hashPost(text);
    tracked.set(el, { hash, text });
    if (!counted.has(hash)) {
      counted.add(hash);
      pendingCount.checked.push(hash);
    }

    let d = decisions.get(hash);
    if (!d) {
      const hit = matchRules(text);
      if (hit) d = { verdict: hit.category, reason: hit.reason, source: 'rules' };
      else if (settings.mode === 'rules') d = { verdict: 'none', reason: '', source: 'rules' };
      if (d) decisions.set(hash, d);
    }
    if (d) apply(el, hash, d);
    else queueForServer(hash, text);
  }
}

function apply(el: HTMLElement, hash: string, d: Decision) {
  const hide = settings.enabled && d.verdict !== 'none' && settings.categories[d.verdict] && !allow.has(hash);
  if (!hide) {
    if (el.hasAttribute('data-unbait')) restorePost(el);
    return;
  }
  // Respect a post the user chose to show: only (re)hide it when it has no bar yet.
  if (isHidden(el) || el.getAttribute('data-unbait') === 'shown') return;
  const verdict = d.verdict as CategoryId;
  hidePost(el, {
    label: categoryById(verdict).label,
    reason: d.reason,
    canReport: settings.mode === 'ai',
    onReport: () => void report(hash, verdict),
  });
  if (!counted.has(`hidden:${hash}`)) {
    counted.add(`hidden:${hash}`);
    pendingCount.hidden.push({ hash, category: verdict });
  }
}

function queueForServer(hash: string, text: string) {
  queue.set(hash, text);
  if (queue.size >= BATCH) void flushQueue();
  else {
    clearTimeout(queueTimer);
    queueTimer = setTimeout(() => void flushQueue(), 400);
  }
}

let queueTimer: ReturnType<typeof setTimeout> | undefined;
let inFlight = false;
async function flushQueue() {
  if (inFlight || queue.size === 0) return;
  inFlight = true;
  const batch = [...queue].slice(0, BATCH);
  for (const [hash] of batch) queue.delete(hash);
  try {
    const reply = await send<ClassifyReply>({ type: 'classify', posts: batch.map(([hash, text]) => ({ hash, text })) });
    for (const [hash] of batch) {
      const v = reply?.verdicts[hash];
      // No answer means the server was unreachable: show the post, and try again on a later visit.
      decisions.set(hash, v ? { verdict: v.verdict, reason: v.reason, source: v.source } : { verdict: 'none', reason: '', source: 'fallback' });
    }
    await scan(true);
  } catch {
    for (const [hash] of batch) decisions.set(hash, { verdict: 'none', reason: '', source: 'fallback' });
  } finally {
    inFlight = false;
    if (queue.size) void flushQueue();
  }
}

async function report(hash: string, shown: CategoryId) {
  allow.add(hash);
  await chrome.storage.local.set({ [ALLOW_KEY]: [...allow].slice(-500) });
  await send({ type: 'report', hash, shown, expected: 'none' }).catch(() => {});
}

function flushCounts() {
  if (!pendingCount.checked.length && !pendingCount.hidden.length) return;
  const counts = pendingCount;
  pendingCount = { checked: [], hidden: [] };
  send({ type: 'count', ...counts }).catch(() => {});
}

void init();
