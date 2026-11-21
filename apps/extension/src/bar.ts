// The thin bar that replaces a hidden post. It lives in a shadow root so
// LinkedIn's styles can't reach it, and it is appended inside the post
// element (not next to it) so LinkedIn's own rendering is left alone.

const STYLE_ID = 'unbait-page-style';
const ATTR = 'data-unbait';

/** Page-level CSS: hide a post's own children, keep our bar. */
export function installPageStyle(doc: Document = document) {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    [${ATTR}="hidden"] > :not(unbait-bar) { display: none !important; }
    [${ATTR}="hidden"] { min-height: 0 !important; }
    unbait-bar { display: block; }
  `;
  (doc.head ?? doc.documentElement).append(style);
}

export interface BarOptions {
  label: string;
  reason: string;
  /** Offer "Not bait?" (only when the server is in use). */
  canReport: boolean;
  onReport: () => void;
}

const isDark = (doc: Document) =>
  doc.documentElement.getAttribute('data-color-scheme') === 'dark' ||
  doc.documentElement.classList.contains('theme--dark') ||
  doc.body?.classList.contains('theme--dark');

const CSS = `
  :host { all: initial; display: block; }
  .bar {
    box-sizing: border-box; display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
    margin: 0 0 8px; padding: 10px 16px; border-radius: 8px;
    font: 14px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background: var(--bg); color: var(--muted); border: 1px solid var(--line);
  }
  .shown .bar { margin: 0; border: 0; border-top: 1px solid var(--line); border-radius: 0 0 8px 8px; padding: 6px 16px; font-size: 12px; }
  .mark { font-weight: 700; letter-spacing: .02em; color: var(--accent); }
  .what { flex: 1 1 220px; min-width: 0; }
  .label { color: var(--ink); font-weight: 600; }
  .actions { display: flex; gap: 6px; }
  button {
    font: inherit; font-weight: 600; cursor: pointer; border-radius: 999px; padding: 3px 12px;
    background: transparent; color: var(--accent); border: 1px solid var(--accent);
  }
  button.quiet { border-color: transparent; color: var(--muted); }
  button:hover { background: var(--hover); }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .light { --bg: #ffffff; --ink: #1d2226; --muted: #5e6670; --line: #dfdedb; --accent: #0a66c2; --hover: #eef3f8; }
  .dark  { --bg: #1b1f23; --ink: #e9e9e9; --muted: #a7acb1; --line: #38434f; --accent: #71b7fb; --hover: #24303c; }
`;

// Content scripts can't register custom elements (customElements is null in
// their isolated world), but any element with a hyphenated name can still
// carry a shadow root, so the bar is a plain <unbait-bar> element.
const shadows = new WeakMap<HTMLElement, ShadowRoot>();

/** Hide `post` behind a bar, or update the bar if it is already hidden. */
export function hidePost(post: HTMLElement, opts: BarOptions) {
  installPageStyle(post.ownerDocument);
  let bar = post.querySelector<HTMLElement>(':scope > unbait-bar');
  if (!bar) {
    bar = post.ownerDocument.createElement('unbait-bar');
    shadows.set(bar, bar.attachShadow({ mode: 'open' }));
    post.append(bar);
  }
  render(post, bar, opts, 'hidden');
}

/** Put a post back exactly as it was. */
export function restorePost(post: HTMLElement) {
  post.removeAttribute(ATTR);
  post.querySelector(':scope > unbait-bar')?.remove();
}

export const isHidden = (post: HTMLElement) => post.getAttribute(ATTR) === 'hidden';

function render(post: HTMLElement, bar: HTMLElement, opts: BarOptions, state: 'hidden' | 'shown') {
  const root = shadows.get(bar);
  if (!root) return;
  post.setAttribute(ATTR, state);
  const doc = post.ownerDocument;
  const hidden = state === 'hidden';
  const { label, reason, canReport } = opts;

  // Built node by node, never with innerHTML: pages like LinkedIn patch or
  // police HTML sinks, and the reason text comes from the network.
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = '') => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  };
  const style = el('style', '', CSS);
  const wrap = el('div', `${isDark(doc) ? 'dark' : 'light'} ${state}`);
  const row = el('div', 'bar');
  row.setAttribute('role', 'note');
  const what = el('span', 'what', hidden ? 'Hid a post: ' : '');
  what.append(el('span', 'label', label), el('span', 'reason', reason ? ` · ${reason}` : ''));
  const actions = el('span', 'actions');
  const toggle = el('button', 'toggle', hidden ? 'Show' : 'Hide');
  toggle.type = 'button';
  toggle.setAttribute('aria-label', hidden ? `Show the hidden post (${label})` : 'Hide this post again');
  toggle.addEventListener('click', () => render(post, bar, opts, hidden ? 'shown' : 'hidden'));
  actions.append(toggle);
  if (canReport) {
    const report = el('button', 'quiet report', 'Not bait?');
    report.type = 'button';
    report.addEventListener('click', () => {
      opts.onReport();
      restorePost(post);
    });
    actions.append(report);
  }
  row.append(el('span', 'mark', 'Unbait'), what, actions);
  wrap.append(row);
  root.replaceChildren(style, wrap);
}
