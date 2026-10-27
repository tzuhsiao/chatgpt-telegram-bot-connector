import type { Env } from './env.ts';
import { AppError } from './errors.ts';

export function requireDatabase(env: Env): D1Database {
  if (!env.DB) throw new AppError('Database configuration is required.', 503, -32002);
  return env.DB;
}

// Rows are stored data, not validated input: callers check the fields they rely on.
export const first = (db: D1Database, sql: string, ...args: unknown[]) =>
  db
    .prepare(sql)
    .bind(...args)
    .first<Record<string, unknown>>();
export const run = (db: D1Database, sql: string, ...args: unknown[]) =>
  db
    .prepare(sql)
    .bind(...args)
    .run();
export const rows = async (db: D1Database, sql: string, ...args: unknown[]) =>
  (
    await db
      .prepare(sql)
      .bind(...args)
      .all<Record<string, unknown>>()
  ).results;
