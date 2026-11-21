// Fast, local pattern rules. They run in the browser before anything is sent
// anywhere, so they are tuned for precision: a rule should only fire when the
// post is unmistakably bait. Everything the rules are unsure about is left
// for the AI (or shown, in rules-only mode).

import type { CategoryId } from './categories.js';
import { cleanPostText, normalizeForRules } from './text.js';

export interface RuleHit {
  category: CategoryId;
  /** Stable id, for evals and debugging. */
  rule: string;
  /** Plain-language reason shown to the user. */
  reason: string;
}

interface Post {
  /** Lower-cased, NFKC-folded text. */
  text: string;
  /** Non-empty lines of `text`. */
  lines: string[];
  /** The cleaned original, for checks that need capital letters. */
  raw: string;
}

interface Rule extends RuleHit {
  test: (post: Post) => boolean;
}

const REWARD = String.raw`(?:pdf|guide|template|checklist|cheat ?sheet|playbook|list|course|ebook|e-book|prompts?|notion|doc|file|link|resource|swipe file|framework|toolkit|roadmap|spreadsheet|deck|copy)`;
const ACTION = String.raw`(?:comment|type|drop|reply|write|leave)`;
const SEND = String.raw`(?:send|dm|share|message|email|mail|give)`;

/** "Comment GUIDE", "type 'prompts'", "drop a 🔥": an action plus a code word or emoji. */
const ACTION_WITH_CODE_WORD = new RegExp(
  String.raw`\b${ACTION}\s+(?:with\s+|the word\s+|below\s+)?(?:"[^"\n]{1,24}"|'[^'\n]{1,24}'|\p{Extended_Pictographic}|a\s+\p{Extended_Pictographic}|"?\b[a-z0-9]{2,16}\b"?\s+(?:below|in the comments|and|to|for|if|&))`,
  'u',
);

const rules: Rule[] = [
  /* ------------------------------------------------- comment-to-get */
  {
    category: 'comment_gate',
    rule: 'gate.ill-send',
    reason: 'Asks you to comment, like or follow to get something sent to you',
    test: ({ text }) =>
      new RegExp(
        String.raw`\b(?:comment|like|repost|follow|connect|react|reply|type|drop)\b[^\n]{0,120}\b(?:i'?ll|i will|we'?ll|we will|i'm going to|i am going to)\s+(?:personally\s+)?${SEND}\b`,
      ).test(text),
  },
  {
    category: 'comment_gate',
    rule: 'gate.to-get',
    reason: 'Asks you to comment to get a resource',
    test: ({ text }) =>
      new RegExp(String.raw`\b(?:comment|repost|like|react|follow|connect|type|drop)\b[^\n]{0,60}\bto (?:get|receive|unlock|access|grab)\b`).test(text) &&
      new RegExp(REWARD).test(text),
  },
  {
    category: 'comment_gate',
    rule: 'gate.code-word',
    reason: 'Asks you to comment a code word to get a resource',
    test: ({ text }) =>
      ACTION_WITH_CODE_WORD.test(text) &&
      (new RegExp(String.raw`\b${SEND}\b[^\n]{0,40}\b(?:you|it|them|everyone|the)\b`).test(text) || new RegExp(String.raw`\b(?:free|get|want|grab)\b[^\n]{0,40}\b${REWARD}\b`).test(text)),
  },
  {
    category: 'comment_gate',
    rule: 'gate.everyone-who',
    reason: 'Promises a resource to everyone who comments',
    test: ({ text }) => /\b(?:to|for) (?:everyone|anyone|all|each person|the first \d+(?: people)?) (?:who|that) (?:comments|likes|reposts|reacts|follows|replies)\b/.test(text),
  },
  {
    category: 'comment_gate',
    rule: 'gate.want-comment',
    reason: 'Asks you to comment to get a resource',
    test: ({ text }) =>
      new RegExp(String.raw`\bwant (?:the|my|this|a copy|it|access)\b[^\n]{0,80}\?\s*(?:\n\s*)?(?:just\s+)?${ACTION}\b`).test(text),
  },
  {
    category: 'comment_gate',
    rule: 'gate.connect-to-dm',
    reason: 'Asks you to connect or follow so it can be sent to you',
    test: ({ text }) => new RegExp(String.raw`\b(?:connect(?:ed)?|follow(?:ing)?)\b[^\n]{0,50}\b(?:so (?:that )?i can|so i'?ll be able to|to receive|so you get)\b[^\n]{0,20}\b${SEND}`).test(text),
  },

  {
    category: 'comment_gate',
    rule: 'gate.its-yours',
    reason: 'Asks you to comment or repost to get something',
    test: ({ text }) =>
      /\b(?:comment|repost|like|react|follow)\b[^\n]{0,60}\b(?:it'?s yours|it is yours|you'?ll get (?:it|access|the)|get (?:it|access|the link) (?:free|instantly|now))\b/.test(text),
  },

  /* ------------------------------------------------- engagement bait */
  {
    category: 'engagement_bait',
    rule: 'bait.react-if',
    reason: 'Asks for likes or reposts "if you agree"',
    test: ({ text }) => /(?:^|\n|[.!?] )\s*(?:♻️|🔁|👍|❤️)?\s*(?:like|react|repost|share|hit like|smash (?:that )?like)\b[^\n]{0,20}\bif (?:you|u|this)\b/.test(text),
  },
  {
    category: 'engagement_bait',
    rule: 'bait.type-yes',
    reason: 'Asks you to type a word to show agreement',
    test: ({ text }) => /\b(?:type|comment|drop|say)\s+"?(?:yes|yes!|yep|amen|1|100|agree|true|facts)"?\s+(?:if|below|in the comments)\b/.test(text),
  },
  {
    category: 'engagement_bait',
    rule: 'bait.tag-someone',
    reason: 'Asks you to tag someone',
    test: ({ text }) => /\btag (?:someone|a friend|a colleague|a coworker|your (?:friend|manager|boss|team|bestie)|a person|someone who|the person|that one)\b/.test(text),
  },
  {
    category: 'engagement_bait',
    rule: 'bait.follow-for-more',
    reason: 'Ends with "follow for more"',
    test: ({ lines }) => lines.slice(-3).some((l) => /\bfollow (?:me |for |@?[a-z.]+ for )?(?:for )?more\b/.test(l) && l.split(/\s+/).length <= 12),
  },
  {
    category: 'engagement_bait',
    rule: 'bait.agree',
    reason: 'Ends with a bare "Agree?"',
    test: ({ lines }) => /^(?:\p{Extended_Pictographic}\s*)*(?:agree\??|do you agree\??|agree or disagree\??|agree\?\s*disagree\?|who agrees\??)\s*(?:\p{Extended_Pictographic}\s*)*$/u.test(lines.at(-1) ?? ''),
  },
  {
    category: 'engagement_bait',
    rule: 'bait.which-one',
    reason: 'Asks you to pick a side to get comments',
    test: ({ lines }) => lines.slice(-2).some((l) => /^(?:so,?\s+)?(?:which one are you|which (?:one|type|side) are you(?: on)?|are you (?:team )?a or (?:team )?b|a or b|1 or 2|team [a-z]+ or team [a-z]+)\s*\??\s*(?:\p{Extended_Pictographic}\s*)*$/u.test(l)),
  },

  {
    category: 'engagement_bait',
    rule: 'bait.empty-thoughts',
    reason: 'A one-line claim that just asks for comments',
    test: ({ text, lines }) =>
      wordCount(text) <= 20 && /^(?:thoughts|what do you think|your thoughts|yes or no|true or false)\s*\??\s*(?:\p{Extended_Pictographic}\s*|👇\s*)*$/u.test(lines.at(-1) ?? ''),
  },
  {
    category: 'engagement_bait',
    rule: 'bait.vote-below',
    reason: 'A trivial poll to collect votes',
    test: ({ text }) => wordCount(text) <= 40 && /\b(?:vote|cast your vote) (?:below|in the comments|now)\b/.test(text),
  },

  /* ------------------------------------------------- hype listicle */
  {
    category: 'hype_listicle',
    rule: 'hype.n-things-will',
    reason: 'A list that promises to replace, 10x or make you rich',
    test: ({ text }) =>
      /\b\d{1,3}\+?\s+(?:[a-z-]+\s+){0,3}(?:tools|prompts|websites|sites|apps|extensions|habits|hacks|skills|books|ways|tips|secrets|plugins|gpts|agents)\b[^\n]{0,80}\b(?:replace|10x|100x|make you (?:rich|money|a millionaire)|change your life|save you \d+|will blow your mind|nobody (?:is )?(?:talks?|talking|tells you)|no one (?:talks|tells you)|feel like (?:cheating|magic)|illegal to know)\b/.test(text),
  },
  {
    category: 'hype_listicle',
    rule: 'hype.ninety-nine-percent',
    reason: 'Claims "99% of people don\'t know this"',
    test: ({ text }) => /\b(?:9\d|8\d)\s?% of (?:people|you|developers|founders|marketers|users|professionals|job seekers|candidates|designers|engineers)\b[^\n]{0,40}\b(?:don't|do not|never|aren't|are not|have no idea|won't|will never|miss)\b/.test(text),
  },
  {
    category: 'hype_listicle',
    rule: 'hype.stop-start',
    reason: '"Stop doing X. Do this instead."',
    test: ({ text }) => /(?:^|\n)\s*stop (?:using|doing|writing|saying|asking|sending|posting|wasting)\b[^\n]{0,80}\n?(?:[^\n]{0,80}\n)?\s*(?:start|use|do|try|instead)\b[^\n]{0,60}\binstead\b/.test(text),
  },
  {
    category: 'hype_listicle',
    rule: 'hype.ai-killed',
    reason: 'Claims an AI tool just killed or replaced a whole job',
    test: ({ text }) => /\b(?:ai|chatgpt|gpt|claude|gemini|this (?:new )?(?:tool|app|ai))\b[^\n]{0,30}\b(?:just )?(?:killed|replaced|destroyed|ended)\b[^\n]{0,25}\b(?:designers|copywriters|developers|programmers|marketers|recruiters|accountants|lawyers|canva|excel|google|figma|photoshop|agencies|jobs)\b/.test(text),
  },

  {
    category: 'hype_listicle',
    rule: 'hype.do-this-and',
    reason: 'Promises guaranteed results if you follow a list',
    test: ({ text, lines }) =>
      /\bdo (?:this|these|that)(?: \w+){0,2} and you'?ll (?:double|triple|10x|get (?:interviews|hired|rich|promoted)|never|land|make|be)\b/.test(text) ||
      lines.some((l) => /^guaranteed[.!]*$/.test(l)),
  },

  /* ------------------------------------------------- cliffhanger story */
  {
    category: 'cliffhanger_story',
    rule: 'story.read-that-again',
    reason: 'Uses "Read that again" or "Let that sink in"',
    test: ({ lines }) => lines.some((l) => /^(?:read (?:that|it|this) again|let that sink in|i'll say it again)[.!]*\s*(?:\p{Extended_Pictographic}\s*)*$/u.test(l)),
  },
  {
    category: 'cliffhanger_story',
    rule: 'story.heres-what-happened',
    reason: 'A dramatic hook followed by "here\'s what happened"',
    test: (post) => /\b(?:here'?s|here is|this is) (?:what happened(?: next)?|how it ended|what i learned|the twist)\b[^\n]{0,4}(?:👇|⬇️|↓|:)/.test(post.text) && isBroetry(post),
  },
  {
    category: 'cliffhanger_story',
    rule: 'story.next-in-comments',
    reason: 'Hides the end of a dramatic story behind a cliffhanger',
    test: (post) =>
      (/\bwhat happened next\b[^\n]{0,40}(?:shocked|surprised|changed|stunned|blew)/.test(post.text) || /\((?:full |rest of the )?story in (?:the )?(?:comments|first comment)\)/.test(post.text)) &&
      isBroetry(post, 6),
  },
  {
    category: 'cliffhanger_story',
    rule: 'story.dramatic-broetry',
    reason: 'A dramatic one-line-per-sentence story',
    test: (post) => isBroetry(post, 10) && DRAMATIC_HOOK.test(post.lines[0] ?? ''),
  },
];

const DRAMATIC_HOOK =
  /\b(?:fired|laid off|rejected|quit|resigned|broke|homeless|cried|crying|tears|failed|bankrupt|zero|\$0|0 (?:followers|clients|dollars)|dropped out|ghosted|humiliated|walked out|lost everything|told me i)\b/;

const wordCount = (text: string) => text.split(/\s+/).filter((w) => /[a-z0-9]/.test(w)).length;

/** One short sentence per line, many lines: the shape of the viral story. */
function isBroetry({ lines }: Post, minLines = 8): boolean {
  if (lines.length < minLines) return false;
  const short = lines.filter((l) => l.split(/\s+/).length <= 9).length;
  return short / lines.length >= 0.75;
}

/**
 * Run the rules on a post. Returns the first hit in priority order
 * (comment-to-get, engagement bait, hype listicle, cliffhanger story), or null.
 */
export function matchRules(text: string): RuleHit | null {
  const normalized = normalizeForRules(text);
  if (!normalized) return null;
  const post: Post = {
    text: normalized,
    lines: normalized.split('\n').map((l) => l.trim()).filter(Boolean),
    raw: cleanPostText(text),
  };
  for (const r of rules) {
    if (r.test(post)) return { category: r.category, rule: r.rule, reason: r.reason };
  }
  return null;
}

/** Every rule id, for tests and eval reports. */
export const RULE_IDS = rules.map((r) => r.rule);
