// The kinds of post Unbait can hide. The ids are part of the API and the
// extension's saved settings, so never rename one; add new ones instead.

export const CATEGORY_IDS = ['comment_gate', 'engagement_bait', 'cliffhanger_story', 'hype_listicle'] as const;
export type CategoryId = (typeof CATEGORY_IDS)[number];
export type Verdict = CategoryId | 'none';

export interface Category {
  id: CategoryId;
  /** Shown in the extension: "Hidden: <label>". */
  label: string;
  /** One line for the settings page. */
  summary: string;
  /** Full definition, used in the AI prompt and the README. */
  definition: string;
}

export const CATEGORIES: readonly Category[] = [
  {
    id: 'comment_gate',
    label: 'Comment-to-get giveaway',
    summary: '"Comment PDF and I\'ll send it to you"',
    definition:
      'The post promises a resource (PDF, guide, template, list, course, prompt pack, link or DM) in exchange for an action: commenting a word or emoji, liking, reposting, following or connecting. This wins over every other category whenever a reward is gated behind an action, even if the post is also a list or a story.',
  },
  {
    id: 'engagement_bait',
    label: 'Engagement bait',
    summary: '"Agree?", "Like if…", "Tag someone who…"',
    definition:
      'The post exists mainly to farm reactions, with no reward offered: "Agree?", "Like if you…", "Repost if…", "Type YES if…", "Tag someone who…", "Which one are you, A or B?", "Follow me for more", or "Thoughts?" tacked onto an empty claim, and trivial polls designed to collect votes.',
  },
  {
    id: 'cliffhanger_story',
    label: 'Cliffhanger story',
    summary: '"I got rejected 47 times. Then this happened 👇"',
    definition:
      'The viral-story format: a dramatic one-line hook, one short sentence per line, an emotional twist and a generic moral, with few or no concrete, checkable details. Often contains "Here\'s what happened 👇", "Read that again." or "Let that sink in."',
  },
  {
    id: 'hype_listicle',
    label: 'Hype listicle',
    summary: '"7 AI tools that will replace your whole team"',
    definition:
      'A breathless list or claim post with exaggerated promises and little substance: "7 AI tools that will replace your entire team", "99% of people don\'t know these prompts", "Stop doing X. Do this instead." Typical words: 10x, replace, make you rich, nobody talks about this.',
  },
];

export const NONE_DEFINITION =
  'Everything else: ordinary posts with real content, including job changes, hiring posts with a direct link, genuine questions, real stories with concrete details, resources shared directly, event announcements and substantive lists. When in doubt, choose none: hiding a real post is worse than showing a bait one.';

const BY_ID = new Map(CATEGORIES.map((c) => [c.id, c]));

export const isCategoryId = (v: unknown): v is CategoryId => typeof v === 'string' && BY_ID.has(v as CategoryId);
export const isVerdict = (v: unknown): v is Verdict => v === 'none' || isCategoryId(v);
export const categoryById = (id: CategoryId): Category => BY_ID.get(id)!;
