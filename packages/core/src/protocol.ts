// The extension <-> server contract. Kept dependency-free so the extension
// bundle stays small; the server validates requests with zod against these.
import type { CategoryId, Verdict } from './categories.js';

export const API_VERSION = 'v1';
/** Posts per classify request. Matches what one model call handles well. */
export const MAX_POSTS_PER_REQUEST = 10;

export interface ClassifyRequest {
  /** Random id the extension generates once per install. Used only for rate limits. */
  installId: string;
  posts: { id: string; text: string }[];
}

export type VerdictSource = 'rules' | 'ai' | 'cache' | 'fallback';

export interface PostVerdict {
  id: string;
  /** sha256 of the normalized text; the key for reports and caching. */
  hash: string;
  verdict: Verdict;
  /** Short plain-language reason, shown under "Hidden:". Empty for "none". */
  reason: string;
  source: VerdictSource;
}

export interface ClassifyResponse {
  results: PostVerdict[];
  /** True when the server answered from rules only (AI off, over budget or failing). */
  degraded: boolean;
}

export interface ReportRequest {
  installId: string;
  hash: string;
  /** What Unbait decided. */
  shown: Verdict;
  /** What the user says it should have been. */
  expected: Verdict;
}

export interface StatsResponse {
  postsChecked: number;
  hidden: Record<CategoryId, number>;
  reports: number;
}
