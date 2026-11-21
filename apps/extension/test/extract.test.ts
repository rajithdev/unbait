// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { findPosts, readPostText } from '../src/extract.js';
import { hidePost, isHidden, restorePost } from '../src/bar.js';

const fixture = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures/feed.html'), 'utf8');

beforeEach(() => {
  document.documentElement.innerHTML = new DOMParser().parseFromString(fixture, 'text/html').documentElement.innerHTML;
});

describe('findPosts', () => {
  test('finds top-level posts with text, not comments or image-only posts', () => {
    const ids = findPosts(document).map((p) => p.el.id);
    expect(ids).toEqual(['post-gate', 'post-real', 'post-agree', 'post-subtle']);
  });

  test('keeps line breaks and drops the "more" button', () => {
    const gate = findPosts(document).find((p) => p.el.id === 'post-gate')!;
    expect(gate.text).toBe('I put my entire cold email playbook into one PDF.\n\nComment "PLAYBOOK" and I\'ll send it to you.');
  });

  test('replaces tagged people with @someone and ignores comments', () => {
    const real = readPostText(document.getElementById('post-real')!);
    expect(real).toContain('with @someone.');
    expect(real).not.toContain('Jane');
    expect(real).toContain('Writeup: example.com/ci');
    expect(real).not.toContain('Agree?');
  });

  test('also understands the older feed layout', () => {
    document.body.innerHTML = `<div class="feed-shared-update-v2" id="old"><div class="update-components-text"><span>Tag someone who needs this.</span></div></div>`;
    expect(findPosts(document).map((p) => [p.el.id, p.text])).toEqual([['old', 'Tag someone who needs this.']]);
  });
});

describe('hidden-post bar', () => {
  test('hides, shows again, and restores a post', () => {
    const post = document.getElementById('post-agree')!;
    const onReport = vi.fn();
    hidePost(post, { label: 'Engagement bait', reason: 'Ends with a bare "Agree?"', canReport: true, onReport });
    expect(isHidden(post)).toBe(true);
    expect(post.querySelectorAll(':scope > unbait-bar')).toHaveLength(1);
    expect(document.getElementById('unbait-page-style')!.textContent).toContain('[data-unbait="hidden"] > :not(unbait-bar)');

    hidePost(post, { label: 'Engagement bait', reason: '', canReport: false, onReport });
    expect(post.querySelectorAll(':scope > unbait-bar')).toHaveLength(1);

    restorePost(post);
    expect(post.hasAttribute('data-unbait')).toBe(false);
    expect(post.querySelector('unbait-bar')).toBeNull();
  });
});
