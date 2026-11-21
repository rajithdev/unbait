// End-to-end: loads the built extension into Chromium, serves a copy of the
// LinkedIn feed's structure at linkedin.com (intercepted, nothing goes to the
// real site), and runs the real API server in-process with a fake AI.
//
//   pnpm e2e            (builds the extension first)
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { serve } from '@hono/node-server';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { createApp } from '../../server/src/app.js';
import type { Classifier } from '../../server/src/classifier.js';
import { MemoryStore } from '../../server/src/store.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const extDir = join(here, '..');
const PORT = 8799;
const shots = process.env.E2E_SCREENSHOTS;

// A stand-in for Claude: flags one subtle post the rules can't catch.
const fakeAi: Classifier = {
  model: 'fake',
  async classify(posts) {
    return {
      results: new Map(posts.map((p) => [p.id, p.text.includes('Nobody ever tells you') ? { verdict: 'cliffhanger_story' as const, reason: 'A teaser story with no real details' } : { verdict: 'none' as const, reason: '' }])),
      usage: { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
    };
  },
};

let passed = 0;
async function step(name: string, fn: () => Promise<void>) {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

const hiddenIds = (page: Page) => page.$$eval('[data-unbait="hidden"]', (els) => els.map((e) => e.id).sort());

async function main() {
  execFileSync(process.execPath, ['build.mjs'], { cwd: extDir, env: { ...process.env, UNBAIT_API_URL: `http://localhost:${PORT}` }, stdio: 'ignore' });
  const server = serve({ fetch: createApp({ store: new MemoryStore(), classifier: fakeAi, config: { postsPerMinute: 1000, dailyAiPosts: 1000 } }).fetch, port: PORT });
  const profile = mkdtempSync(join(tmpdir(), 'unbait-e2e-'));
  let context: BrowserContext | undefined;

  try {
    context = await chromium.launchPersistentContext(profile, {
      headless: true,
      channel: 'chromium', // the full Chromium build; the headless shell can't run extensions
      viewport: { width: 900, height: 1000 },
      args: [`--disable-extensions-except=${join(extDir, 'dist')}`, `--load-extension=${join(extDir, 'dist')}`],
    });
    const fixture = readFileSync(join(extDir, 'test/fixtures/feed.html'), 'utf8');
    await context.route('https://www.linkedin.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: fixture }));

    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    const extensionId = new URL(worker.url()).host;
    const setSettings = (patch: object) => worker.evaluate(async (p) => {
      const { settings } = await chrome.storage.sync.get('settings');
      await chrome.storage.sync.set({ settings: { ...(settings ?? {}), ...p } });
    }, patch);

    const page = await context.newPage();

    await step('rules mode hides obvious bait and leaves real posts alone', async () => {
      await page.goto('https://www.linkedin.com/feed/');
      await page.waitForSelector('[data-unbait="hidden"]');
      await page.waitForTimeout(500);
      assert.deepEqual(await hiddenIds(page), ['post-agree', 'post-gate']);
      assert.equal(await page.isVisible('#post-real [data-testid="expandable-text-box"]'), true);
      assert.equal(await page.isVisible('#post-gate [data-testid="expandable-text-box"]'), false);
      if (shots) await page.screenshot({ path: join(shots, 'feed-rules.png') });
    });

    await step('"Show" reveals a hidden post', async () => {
      await page.locator('#post-gate unbait-bar').getByRole('button', { name: /Show the hidden post/ }).click();
      assert.equal(await page.getAttribute('#post-gate', 'data-unbait'), 'shown');
      assert.equal(await page.isVisible('#post-gate [data-testid="expandable-text-box"]'), true);
    });

    await step('turning a category off shows those posts again', async () => {
      await setSettings({ categories: { comment_gate: true, engagement_bait: false, cliffhanger_story: true, hype_listicle: true } });
      await page.waitForFunction(() => !document.querySelector('#post-agree')?.hasAttribute('data-unbait'));
      await setSettings({ categories: { comment_gate: true, engagement_bait: true, cliffhanger_story: true, hype_listicle: true } });
    });

    await step('AI mode sends what the rules miss to the server and hides it with its reason', async () => {
      await setSettings({ mode: 'ai' });
      await page.reload();
      await page.waitForSelector('#post-subtle[data-unbait="hidden"]', { timeout: 10_000 });
      assert.deepEqual(await hiddenIds(page), ['post-agree', 'post-gate', 'post-subtle']);
      const bar = await page.locator('#post-subtle unbait-bar .bar').innerText();
      assert.match(bar, /Cliffhanger story/);
      assert.match(bar, /A teaser story with no real details/);
      assert.match(bar, /Not bait\?/);
      if (shots) await page.locator('#post-subtle').screenshot({ path: join(shots, 'bar.png') });
    });

    await step('"Not bait?" shows the post and keeps it shown after a reload', async () => {
      await page.locator('#post-subtle unbait-bar').getByRole('button', { name: 'Not bait?' }).click();
      assert.equal(await page.getAttribute('#post-subtle', 'data-unbait'), null);
      await page.reload();
      await page.waitForSelector('#post-gate[data-unbait="hidden"]');
      await page.waitForTimeout(1500);
      assert.equal(await page.getAttribute('#post-subtle', 'data-unbait'), null);
    });

    await step('the popup shows counts and the server status', async () => {
      await page.waitForTimeout(3500); // counts are flushed every 3 seconds
      const popup = await context!.newPage();
      await popup.goto(`chrome-extension://${extensionId}/popup.html`);
      await popup.waitForFunction(() => document.getElementById('status')?.textContent?.includes('Connected'));
      assert.equal(await popup.textContent('#total'), '3');
      assert.equal(await popup.textContent('#checked'), '4');
      assert.equal(await popup.isChecked('#enabled'), true);
      if (shots) await popup.screenshot({ path: join(shots, 'popup.png'), animations: 'disabled' });
    });

    await step('the extension asks for no permissions beyond storage and linkedin.com', async () => {
      const manifest = await worker.evaluate(() => chrome.runtime.getManifest());
      assert.deepEqual(manifest.permissions, ['storage']);
      assert.deepEqual(manifest.host_permissions, ['https://www.linkedin.com/*']);
    });
  } finally {
    await context?.close();
    server.close();
    rmSync(profile, { recursive: true, force: true });
  }
  console.log(`\n${passed} end-to-end checks passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
