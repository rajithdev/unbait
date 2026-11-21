// Finding posts in LinkedIn's feed and reading their text. Kept free of
// extension APIs so it can be tested against saved HTML.

/**
 * LinkedIn ships two feed layouts. The current one marks the feed with
 * data-testid="mainFeed" and each update with role="listitem"; the older one
 * uses .feed-shared-update-v2. Both are listed so either keeps working.
 */
export const SELECTORS = {
  feed: '[data-testid="mainFeed"]',
  post: '[role="listitem"]',
  text: '[data-testid="expandable-text-box"]',
  comments: '[data-testid*="commentList"], [componentkey*="comment:"], .comments-comments-list',
  legacyPost: '.feed-shared-update-v2, div[data-urn^="urn:li:activity"]',
  legacyText: '.update-components-text, .feed-shared-update-v2__description',
} as const;

export interface FoundPost {
  el: HTMLElement;
  text: string;
}

/** Every feed post under `root` that has text, outermost elements only. */
export function findPosts(root: ParentNode = document): FoundPost[] {
  const found: FoundPost[] = [];
  const seen = new Set<Element>();

  const addPost = (el: HTMLElement, textSelector: string) => {
    if (seen.has(el)) return;
    seen.add(el);
    const text = readPostText(el, textSelector);
    if (text) found.push({ el, text });
  };

  for (const feed of root.querySelectorAll<HTMLElement>(SELECTORS.feed)) {
    for (const el of feed.querySelectorAll<HTMLElement>(SELECTORS.post)) {
      // Skip list items nested inside another post (comments, carousels).
      const outer = el.parentElement?.closest(SELECTORS.post);
      if (outer && feed.contains(outer)) continue;
      addPost(el, SELECTORS.text);
    }
  }
  for (const el of root.querySelectorAll<HTMLElement>(SELECTORS.legacyPost)) {
    if (el.parentElement?.closest(SELECTORS.legacyPost)) continue;
    addPost(el, SELECTORS.legacyText);
  }
  return found;
}

/**
 * The text of a post, including a reshared post's text, but not comments.
 * People tagged in the post become "@someone", so no names leave the browser.
 */
export function readPostText(post: HTMLElement, textSelector: string = SELECTORS.text): string {
  return [...post.querySelectorAll<HTMLElement>(textSelector)]
    .filter((box) => !box.closest(SELECTORS.comments) && !box.parentElement?.closest(textSelector))
    .map((box) => toText(box).replace(/\n{3,}/g, '\n\n').trim())
    .filter(Boolean)
    .join('\n\n');
}

const BLOCK = new Set(['P', 'DIV', 'LI', 'UL', 'OL', 'H1', 'H2', 'H3', 'H4', 'BLOCKQUOTE', 'SECTION', 'ARTICLE']);
const SKIP = new Set(['BUTTON', 'SCRIPT', 'STYLE', 'SVG', 'IMG', 'TEMPLATE']);

/** Text with line breaks kept, without relying on layout (works on detached nodes too). */
function toText(node: Node): string {
  let out = '';
  for (const child of node.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      out += child.textContent ?? '';
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      const el = child as HTMLElement;
      if (SKIP.has(el.tagName) || el.getAttribute('aria-hidden') === 'true') continue;
      if (el.tagName === 'BR') out += '\n';
      else if (el.tagName === 'A' && isPersonLink(el)) out += '@someone';
      else {
        const inner = toText(el);
        out += BLOCK.has(el.tagName) ? `\n${inner}\n` : inner;
      }
    }
  }
  return out;
}

function isPersonLink(a: HTMLElement): boolean {
  return /linkedin\.com\/in\/|^\/in\//.test(a.getAttribute('href') ?? '');
}
