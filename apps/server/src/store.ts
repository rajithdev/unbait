// Persistence. The server never stores post text: only the hash of a post,
// the verdict, and counters. MemoryStore is for tests and local runs without
// a database; PostgresStore is what production uses.
import pg from 'pg';
import type { Verdict } from '@unbait/core';

export interface CachedVerdict {
  verdict: Verdict;
  reason: string;
}

export interface Store {
  getVerdicts(hashes: string[]): Promise<Map<string, CachedVerdict>>;
  putVerdicts(rows: (CachedVerdict & { hash: string; model: string })[]): Promise<void>;
  /** Returns false when this install already reported this post. */
  addReport(report: { hash: string; installKey: string; shown: Verdict; expected: Verdict }): Promise<boolean>;
  /** Add to named counters for a UTC day (YYYY-MM-DD). */
  bump(day: string, counts: Record<string, number>): Promise<void>;
  dayCount(day: string, key: string): Promise<number>;
  totals(): Promise<Record<string, number>>;
  close(): Promise<void>;
}

/** Cached verdicts expire so a better prompt or model gets another look. */
export const VERDICT_TTL_DAYS = 30;

export class MemoryStore implements Store {
  private verdicts = new Map<string, CachedVerdict & { at: number }>();
  private reports = new Set<string>();
  private counters = new Map<string, number>();

  async getVerdicts(hashes: string[]) {
    const cutoff = Date.now() - VERDICT_TTL_DAYS * 86_400_000;
    const out = new Map<string, CachedVerdict>();
    for (const h of hashes) {
      const v = this.verdicts.get(h);
      if (v && v.at >= cutoff) out.set(h, { verdict: v.verdict, reason: v.reason });
    }
    return out;
  }
  async putVerdicts(rows: (CachedVerdict & { hash: string })[]) {
    for (const r of rows) this.verdicts.set(r.hash, { verdict: r.verdict, reason: r.reason, at: Date.now() });
  }
  async addReport(r: { hash: string; installKey: string }) {
    const key = `${r.installKey}:${r.hash}`;
    if (this.reports.has(key)) return false;
    this.reports.add(key);
    return true;
  }
  async bump(day: string, counts: Record<string, number>) {
    for (const [k, n] of Object.entries(counts)) {
      if (!n) continue;
      this.counters.set(`${day}|${k}`, (this.counters.get(`${day}|${k}`) ?? 0) + n);
    }
  }
  async dayCount(day: string, key: string) {
    return this.counters.get(`${day}|${key}`) ?? 0;
  }
  async totals() {
    const out: Record<string, number> = {};
    for (const [k, n] of this.counters) {
      const key = k.split('|')[1]!;
      out[key] = (out[key] ?? 0) + n;
    }
    return out;
  }
  async close() {}
}

const MIGRATION = `
CREATE TABLE IF NOT EXISTS verdicts (
  hash       text PRIMARY KEY,
  verdict    text NOT NULL,
  reason     text NOT NULL DEFAULT '',
  model      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS reports (
  id          bigserial PRIMARY KEY,
  hash        text NOT NULL,
  install_key text NOT NULL,
  shown       text NOT NULL,
  expected    text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (install_key, hash)
);
CREATE TABLE IF NOT EXISTS daily_counters (
  day   date   NOT NULL,
  key   text   NOT NULL,
  count bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (day, key)
);
`;

export class PostgresStore implements Store {
  private constructor(private pool: pg.Pool) {}

  static async connect(connectionString: string): Promise<PostgresStore> {
    const pool = new pg.Pool({ connectionString, max: 10 });
    await pool.query(MIGRATION);
    return new PostgresStore(pool);
  }

  async getVerdicts(hashes: string[]) {
    const out = new Map<string, CachedVerdict>();
    if (!hashes.length) return out;
    const { rows } = await this.pool.query<{ hash: string; verdict: Verdict; reason: string }>(
      `SELECT hash, verdict, reason FROM verdicts WHERE hash = ANY($1) AND created_at > now() - make_interval(days => $2)`,
      [hashes, VERDICT_TTL_DAYS],
    );
    for (const r of rows) out.set(r.hash, { verdict: r.verdict, reason: r.reason });
    return out;
  }

  async putVerdicts(rows: (CachedVerdict & { hash: string; model: string })[]) {
    if (!rows.length) return;
    await this.pool.query(
      `INSERT INTO verdicts (hash, verdict, reason, model)
       SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[])
       ON CONFLICT (hash) DO UPDATE SET verdict = EXCLUDED.verdict, reason = EXCLUDED.reason, model = EXCLUDED.model, created_at = now()`,
      [rows.map((r) => r.hash), rows.map((r) => r.verdict), rows.map((r) => r.reason), rows.map((r) => r.model)],
    );
  }

  async addReport(r: { hash: string; installKey: string; shown: Verdict; expected: Verdict }) {
    const res = await this.pool.query(
      `INSERT INTO reports (hash, install_key, shown, expected) VALUES ($1, $2, $3, $4) ON CONFLICT (install_key, hash) DO NOTHING`,
      [r.hash, r.installKey, r.shown, r.expected],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async bump(day: string, counts: Record<string, number>) {
    const entries = Object.entries(counts).filter(([, n]) => n);
    if (!entries.length) return;
    await this.pool.query(
      `INSERT INTO daily_counters (day, key, count)
       SELECT $1::date, k, n FROM unnest($2::text[], $3::bigint[]) AS t(k, n)
       ON CONFLICT (day, key) DO UPDATE SET count = daily_counters.count + EXCLUDED.count`,
      [day, entries.map(([k]) => k), entries.map(([, n]) => n)],
    );
  }

  async dayCount(day: string, key: string) {
    const { rows } = await this.pool.query<{ count: string }>(`SELECT count FROM daily_counters WHERE day = $1 AND key = $2`, [day, key]);
    return Number(rows[0]?.count ?? 0);
  }

  async totals() {
    const { rows } = await this.pool.query<{ key: string; total: string }>(`SELECT key, sum(count) AS total FROM daily_counters GROUP BY key`);
    return Object.fromEntries(rows.map((r) => [r.key, Number(r.total)]));
  }

  async close() {
    await this.pool.end();
  }
}
