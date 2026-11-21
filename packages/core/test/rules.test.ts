import { describe, expect, test } from 'vitest';
import { matchRules, RULE_IDS } from '../src/rules.js';
import { cleanPostText, hashPost, normalizeForRules } from '../src/text.js';
import { CATEGORIES, isVerdict } from '../src/categories.js';

const cat = (text: string) => matchRules(text)?.category ?? 'none';

describe('comment-to-get', () => {
  test.each([
    'I put all 50 prompts in one PDF.\n\nComment "PROMPTS" and I\'ll send it to you.',
    'Want the template?\nComment GUIDE below.',
    'Like + comment and I will DM you the full playbook.',
    'Sending the checklist to everyone who comments today.',
    'Repost ♻️ and comment to get the free roadmap.',
    'Comment 🔥 and I\'ll share the Notion doc.',
    'Make sure we\'re connected so I can DM you the deck.',
    'Comment "𝗦𝗤𝗟" and I\'ll message you the cheat sheet.',
  ])('%s', (text) => expect(cat(text)).toBe('comment_gate'));
});

describe('engagement bait', () => {
  test.each([
    'Hard work beats talent when talent doesn\'t work hard.\n\nAgree?',
    'Remote work is here to stay.\n\nRepost if you agree ♻️',
    'Type YES if you\'ve ever been ghosted by a recruiter.',
    'Tag someone who needs to hear this today.',
    'Coffee or tea while coding?\n\nWhich one are you?',
    'Great leaders listen more than they talk.\n\nFollow me for more.',
  ])('%s', (text) => expect(cat(text)).toBe('engagement_bait'));
});

describe('hype listicle', () => {
  test.each([
    '7 AI tools that will replace your entire marketing team:\n\n1. ...',
    '99% of developers don\'t know these VS Code shortcuts.',
    'Stop writing cover letters.\nUse this one prompt instead.',
    'ChatGPT just killed Canva.\n\nHere\'s why:',
    '10 free websites that feel like cheating:',
  ])('%s', (text) => expect(cat(text)).toBe('hype_listicle'));
});

describe('cliffhanger story', () => {
  const story = [
    'I got fired on a Monday.',
    'No warning.',
    'No severance.',
    'Just a 10-minute call.',
    'I went home and cried.',
    'Then I opened my laptop.',
    'And I made a decision.',
    'Here\'s what happened 👇',
    'I started posting every day.',
  ].join('\n');
  test('dramatic broetry with "here\'s what happened"', () => expect(cat(story)).toBe('cliffhanger_story'));
  test('"Read that again."', () => expect(cat('Your network is your net worth.\n\nRead that again.')).toBe('cliffhanger_story'));
});

describe('leaves real posts alone', () => {
  test.each([
    'I\'m happy to share that I\'m starting a new position as Senior Engineer at a fintech startup!',
    'We\'re hiring two backend engineers (Go, Postgres). Apply here: https://example.com/jobs/12',
    'Here\'s the PDF of my talk slides: https://example.com/slides.pdf',
    'We moved our Postgres 14 cluster to 16 last week. Three things that bit us:\n1. Extensions needed rebuilds\n2. pg_stat_statements reset\n3. Replication slots',
    'Should we use Kafka or Postgres LISTEN/NOTIFY for ~200 events a second? Our team is small and ops time matters most.\n\nThoughts?',
    'Huge thanks to the platform team for shipping the new deploy pipeline. Build times dropped from 14 to 4 minutes.',
    'Comment below with your favourite debugging tool, I\'m collecting them for our onboarding doc.',
    'Stop by booth 42 at the conference tomorrow, we\'ll be demoing the new release.',
    'Our team tried 3 tools for on-call scheduling. Here is what we picked and why.',
    'I was laid off in March. I spent six weeks learning Terraform, passed the associate exam and joined a 30-person infra team in May.',
  ])('%s', (text) => expect(cat(text)).toBe('none'));
});

describe('text helpers', () => {
  test('folds Unicode bold and smart quotes', () => {
    expect(normalizeForRules('𝗖𝗼𝗺𝗺𝗲𝗻𝘁 “𝗣𝗗𝗙” — it’s free')).toBe('comment "pdf" - it\'s free');
  });
  test('cleans "see more", blank lines and stray spaces', () => {
    expect(cleanPostText('  line one  \n\n\n\nline   two…see more')).toBe('line one\n\nline two');
  });
  test('hash is stable across cosmetic differences', async () => {
    const a = await hashPost('Comment “PDF” for the guide');
    const b = await hashPost('𝗖omment "PDF" for the guide   ');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
  test('empty text matches nothing', () => expect(matchRules('   ')).toBeNull());
  test('categories and rules are well-formed', () => {
    expect(new Set(RULE_IDS).size).toBe(RULE_IDS.length);
    for (const c of CATEGORIES) expect(isVerdict(c.id)).toBe(true);
    expect(isVerdict('nope')).toBe(false);
  });
});
