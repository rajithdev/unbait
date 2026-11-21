// Scores Unbait against the labelled dataset.
//
//   pnpm eval                      rules only (free, offline)
//   pnpm eval --ai                 rules, then the AI for what rules miss (the real pipeline; costs money)
//   pnpm eval --ai --model claude-haiku-5-5
//   pnpm eval --split test         dev | test | all (default all)
//   pnpm eval --write              also update evals/RESULTS.md
//
// The dataset is split by id: odd numbers are "dev" (used while tuning the
// rules and prompt), even numbers are "test" (held out, the honest number).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CATEGORY_IDS, matchRules, type Verdict } from '@unbait/core';
import { createClaudeClassifier, type Usage } from '../apps/server/src/classifier.js';

interface Row {
  id: string;
  label: Verdict;
  hard: boolean;
  text: string;
}

interface Scored extends Row {
  predicted: Verdict;
  source: 'rules' | 'ai' | 'none';
  rule?: string;
}

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : fallback;
};

const useAi = flag('ai');
const model = option('model', 'claude-opus-5-5');
const split = option('split', 'all');
if (!['dev', 'test', 'all'].includes(split)) throw new Error('--split must be dev, test or all');

const all: Row[] = readFileSync(here('./dataset.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const splitOf = (id: string) => (Number(id.split('-')[1]) % 2 === 1 ? 'dev' : 'test');
const rows = all.filter((r) => split === 'all' || splitOf(r.id) === split);

/* ------------------------------------------------------------ classify */
const scored: Scored[] = rows.map((r) => {
  const hit = matchRules(r.text);
  return hit ? { ...r, predicted: hit.category, source: 'rules', rule: hit.rule } : { ...r, predicted: 'none', source: 'none' };
});

const usage: Usage = { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
let aiCalls = 0;
if (useAi) {
  const classifier = createClaudeClassifier({ model, effort: 'low' });
  const pending = scored.filter((s) => s.source === 'none');
  console.error(`Sending ${pending.length} posts to ${model} in ${Math.ceil(pending.length / 10)} calls…`);
  for (let i = 0; i < pending.length; i += 10) {
    const batch = pending.slice(i, i + 10);
    const { results, usage: u } = await classifier.classify(batch.map((s) => ({ id: s.id, text: s.text })));
    aiCalls++;
    for (const k of Object.keys(usage) as (keyof Usage)[]) usage[k] += u[k];
    for (const s of batch) {
      const r = results.get(s.id);
      if (r) Object.assign(s, { predicted: r.verdict, source: 'ai' });
    }
  }
}

/* ------------------------------------------------------------- metrics */
const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(1)}%` : '–');
const isBait = (v: Verdict) => v !== 'none';

function summarize(set: Scored[]) {
  const tp = set.filter((s) => isBait(s.label) && isBait(s.predicted)).length;
  const fp = set.filter((s) => !isBait(s.label) && isBait(s.predicted)).length;
  const fn = set.filter((s) => isBait(s.label) && !isBait(s.predicted)).length;
  const right = set.filter((s) => isBait(s.label) && s.predicted === s.label).length;
  return {
    posts: set.length,
    precision: pct(tp, tp + fp),
    recall: pct(tp, tp + fn),
    falseHides: `${fp} of ${set.filter((s) => !isBait(s.label)).length}`,
    rightCategory: pct(right, tp),
  };
}

const overall = summarize(scored);
const hardOnly = summarize(scored.filter((s) => s.hard));
const perCategory = CATEGORY_IDS.map((id) => {
  const ofLabel = scored.filter((s) => s.label === id);
  const caught = ofLabel.filter((s) => isBait(s.predicted)).length;
  const exact = ofLabel.filter((s) => s.predicted === id).length;
  return { id, posts: ofLabel.length, caught: pct(caught, ofLabel.length), exact: pct(exact, ofLabel.length) };
});

// Opus 5.5: $4 in / $20 out / $0.20 cache read / $5 cache write per million tokens.
const PRICES: Record<string, [number, number, number, number]> = {
  'claude-opus-5-5': [4, 20, 0.2, 5],
  'claude-sonnet-5-5': [2, 10, 0.1, 2.5],
  'claude-haiku-5-5': [0.1, 0.5, 0.01, 0.125],
};
const price = PRICES[model];
const cost = price
  ? (usage.inputTokens * price[0] + usage.outputTokens * price[1] + usage.cacheReadTokens * price[2] + usage.cacheWriteTokens * price[3]) / 1e6
  : null;
const aiPosts = scored.filter((s) => s.source === 'ai').length;

/* -------------------------------------------------------------- report */
const mistakes = scored.filter((s) => s.predicted !== s.label);
const pipeline = useAi ? `rules + ${model}` : 'rules only';
const md = [
  `### ${pipeline} · ${split} split · ${scored.length} posts`,
  '',
  '| | Posts | Precision | Recall | Wrongly hidden | Right category |',
  '| --- | ---: | ---: | ---: | ---: | ---: |',
  `| All | ${overall.posts} | ${overall.precision} | ${overall.recall} | ${overall.falseHides} | ${overall.rightCategory} |`,
  `| Hard cases | ${hardOnly.posts} | ${hardOnly.precision} | ${hardOnly.recall} | ${hardOnly.falseHides} | ${hardOnly.rightCategory} |`,
  '',
  '| Category | Posts | Hidden | Hidden with the right label |',
  '| --- | ---: | ---: | ---: |',
  ...perCategory.map((c) => `| \`${c.id}\` | ${c.posts} | ${c.caught} | ${c.exact} |`),
  '',
  useAi
    ? `Rules decided ${scored.filter((s) => s.source === 'rules').length} posts; the AI decided ${aiPosts} in ${aiCalls} calls${cost !== null ? `, costing $${cost.toFixed(4)} ($${((cost / Math.max(aiPosts, 1)) * 1000).toFixed(2)} per 1,000 AI-checked posts)` : ''}. Cache reads: ${usage.cacheReadTokens.toLocaleString('en')} tokens.`
    : `Rules decided ${scored.filter((s) => s.source === 'rules').length} of ${scored.length} posts.`,
].join('\n');

console.log(md);
console.log(`\nMistakes (${mistakes.length}):`);
for (const m of mistakes) {
  console.log(`  ${m.id.padEnd(6)} ${m.hard ? 'hard' : '    '} label=${m.label.padEnd(17)} got=${m.predicted.padEnd(17)} ${m.rule ?? m.source}  | ${m.text.split('\n')[0]!.slice(0, 70)}`);
}

mkdirSync(here('./results'), { recursive: true });
writeFileSync(here(`./results/${new Date().toISOString().replace(/[:.]/g, '-')}.json`), JSON.stringify({ pipeline, split, overall, hardOnly, perCategory, usage, cost, scored }, null, 2));
if (flag('write')) {
  const file = here('./RESULTS.md');
  const header = '# Eval results\n\nGenerated by `pnpm eval --write`. "Precision" is the share of hidden posts that really were bait; "Recall" is the share of bait that got hidden; "Wrongly hidden" counts real posts that were hidden, the mistake that matters most.\n\n';
  let existing = '';
  try {
    existing = readFileSync(file, 'utf8').replace(header, '');
  } catch {}
  const sections = existing.split(/\n(?=### )/).filter((s) => s.trim() && !s.startsWith(`### ${pipeline} · ${split} split`));
  writeFileSync(file, header + [...sections.map((s) => s.trim()), md].join('\n\n') + '\n');
}
