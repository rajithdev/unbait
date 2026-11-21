// Messages between the content script, the popup and the background worker.
import type { CategoryId, Verdict, VerdictSource } from '@unbait/core';

export type Request =
  | { type: 'classify'; posts: { hash: string; text: string }[] }
  | { type: 'report'; hash: string; shown: Verdict; expected: Verdict }
  | { type: 'count'; checked: string[]; hidden: { hash: string; category: CategoryId }[] }
  | { type: 'health' };

export interface RemoteVerdict {
  verdict: Verdict;
  reason: string;
  source: VerdictSource;
}

export interface ClassifyReply {
  verdicts: Record<string, RemoteVerdict>;
  /** Set when the server could not be reached or answered from rules only. */
  problem?: string;
}

export interface HealthReply {
  ok: boolean;
  ai?: boolean;
  error?: string;
}

export const send = <T>(message: Request) => chrome.runtime.sendMessage<Request, T>(message);
