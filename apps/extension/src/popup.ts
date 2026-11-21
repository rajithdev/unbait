import { CATEGORIES } from '@unbait/core';
import { send, type HealthReply } from './messages.js';
import { emptyStats, loadSettings, localDay, saveSettings, type Settings, type Stats } from './settings.js';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

async function render() {
  const settings = await loadSettings();
  const { stats, lastProblem } = (await chrome.storage.local.get(['stats', 'lastProblem'])) as { stats?: Stats; lastProblem?: string | null };
  const s = stats ?? emptyStats(localDay());

  document.body.classList.toggle('off', !settings.enabled);
  $<HTMLInputElement>('enabled').checked = settings.enabled;
  $('today').textContent = String(s.day === localDay() ? s.today : 0);
  $('total').textContent = String(s.total);
  $('checked').textContent = String(s.checked);

  const box = $('categories');
  box.replaceChildren(
    ...CATEGORIES.map((c) => {
      const row = document.createElement('label');
      row.className = 'row';
      const input = Object.assign(document.createElement('input'), { type: 'checkbox', checked: settings.categories[c.id] });
      input.addEventListener('change', () => void saveSettings({ categories: { ...settings.categories, [c.id]: input.checked } }).then(render));
      const text = document.createElement('span');
      text.innerHTML = `<span></span><small></small>`;
      text.firstElementChild!.textContent = c.label;
      text.lastElementChild!.textContent = c.summary;
      const count = Object.assign(document.createElement('span'), { className: 'count', textContent: String(s.byCategory[c.id] ?? 0) });
      row.append(input, text, count);
      return row;
    }),
  );

  for (const radio of document.querySelectorAll<HTMLInputElement>('input[name=mode]')) radio.checked = radio.value === settings.mode;
  $<HTMLInputElement>('apiUrl').value = settings.apiUrl;
  await showStatus(settings, lastProblem ?? null);
}

async function showStatus(settings: Settings, lastProblem: string | null) {
  const el = $('status');
  el.className = 'status';
  if (settings.mode !== 'ai') {
    el.textContent = '';
    return;
  }
  el.textContent = 'Checking the server…';
  const health = await send<HealthReply>({ type: 'health' }).catch((): HealthReply => ({ ok: false, error: 'Could not reach the Unbait server' }));
  if (!health.ok) {
    el.className = 'status warn';
    el.textContent = `${health.error ?? 'Server unavailable'}. Posts are checked with rules only until it's back.`;
  } else if (!health.ai) {
    el.className = 'status warn';
    el.textContent = 'The server is up but its AI is off, so only rules are used.';
  } else {
    el.textContent = lastProblem ? `Connected. Last issue: ${lastProblem}.` : 'Connected to the Unbait server.';
  }
}

$<HTMLInputElement>('enabled').addEventListener('change', (e) => void saveSettings({ enabled: (e.target as HTMLInputElement).checked }).then(render));
for (const radio of document.querySelectorAll<HTMLInputElement>('input[name=mode]')) {
  radio.addEventListener('change', () => void saveSettings({ mode: radio.value as Settings['mode'] }).then(render));
}
$<HTMLInputElement>('apiUrl').addEventListener('change', (e) => {
  const value = (e.target as HTMLInputElement).value.trim();
  if (/^https?:\/\//.test(value)) void saveSettings({ apiUrl: value }).then(render);
});

void render();
