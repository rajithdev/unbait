// Text helpers shared by the extension, the server and the evals.

/** LinkedIn's own limit for a post, so nothing real is ever cut. */
export const MAX_POST_CHARS = 3000;

/**
 * Tidy text read from the page before it is classified or hashed:
 * drop the "…see more" toggle, trim each line, and collapse runs of
 * blank lines. Line breaks are kept on purpose: one-sentence-per-line
 * layout is itself a signal.
 */
export function cleanPostText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[   ]/g, ' ')
    .replace(/(?:…|\.\.\.)\s*(?:see more|more)\s*$/i, '')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_POST_CHARS);
}

/**
 * The form the rules match against. NFKC folds the "𝗯𝗼𝗹𝗱" and "𝘪𝘵𝘢𝘭𝘪𝘤"
 * Unicode letters popular in these posts back to plain ASCII, and quotes
 * and apostrophes are straightened so patterns only need one spelling.
 */
export function normalizeForRules(text: string): string {
  return cleanPostText(text)
    .normalize('NFKC')
    .replace(/[‘’ʼ`´]/g, "'")
    .replace(/[“”«»„]/g, '"')
    .replace(/[‐‑‒–—]/g, '-')
    .toLowerCase();
}

/**
 * Stable id for a post's text, used as the cache key on both sides.
 * The server stores this hash and the verdict, never the text itself.
 */
export async function hashPost(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(normalizeForRules(text));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
