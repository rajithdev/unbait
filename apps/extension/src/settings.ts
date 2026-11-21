// User settings (synced across the user's browsers) and local stats.
import { CATEGORY_IDS, type CategoryId } from '@unbait/core';

declare const __API_URL__: string;
export const DEFAULT_API_URL: string = typeof __API_URL__ === 'string' ? __API_URL__ : 'http://localhost:8787';

export type Mode = 'rules' | 'ai';

export interface Settings {
  enabled: boolean;
  /** "rules": nothing leaves the browser. "ai": unclear posts go to the server. */
  mode: Mode;
  categories: Record<CategoryId, boolean>;
  apiUrl: string;
}

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  mode: 'rules',
  categories: Object.fromEntries(CATEGORY_IDS.map((id) => [id, true])) as Record<CategoryId, boolean>,
  apiUrl: DEFAULT_API_URL,
};

export async function loadSettings(): Promise<Settings> {
  const { settings } = await chrome.storage.sync.get('settings');
  return mergeSettings(settings);
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = mergeSettings({ ...(await loadSettings()), ...patch });
  await chrome.storage.sync.set({ settings: next });
  return next;
}

/** Fill in anything missing, so settings saved by an older version still load. */
export function mergeSettings(saved: unknown): Settings {
  const s = (saved && typeof saved === 'object' ? saved : {}) as Partial<Settings>;
  return {
    enabled: typeof s.enabled === 'boolean' ? s.enabled : DEFAULT_SETTINGS.enabled,
    mode: s.mode === 'ai' || s.mode === 'rules' ? s.mode : DEFAULT_SETTINGS.mode,
    categories: Object.fromEntries(
      CATEGORY_IDS.map((id) => [id, typeof s.categories?.[id] === 'boolean' ? s.categories[id] : true]),
    ) as Record<CategoryId, boolean>,
    apiUrl: typeof s.apiUrl === 'string' && /^https?:\/\//.test(s.apiUrl) ? s.apiUrl.replace(/\/+$/, '') : DEFAULT_SETTINGS.apiUrl,
  };
}

export interface Stats {
  day: string;
  today: number;
  total: number;
  checked: number;
  byCategory: Record<CategoryId, number>;
}

export const emptyStats = (day: string): Stats => ({
  day,
  today: 0,
  total: 0,
  checked: 0,
  byCategory: Object.fromEntries(CATEGORY_IDS.map((id) => [id, 0])) as Record<CategoryId, number>,
});

export const localDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
