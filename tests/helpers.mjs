import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';

export class TestDatabase {
  constructor(migrationCount = Infinity) {
    this.sqlite = new DatabaseSync(':memory:');
    const journal = JSON.parse(
      readFileSync(new URL('../drizzle/meta/_journal.json', import.meta.url), 'utf8'),
    );
    for (const entry of journal.entries.slice(0, migrationCount))
      this.sqlite.exec(
        readFileSync(new URL(`../drizzle/${entry.tag}.sql`, import.meta.url), 'utf8'),
      );
  }
  prepare(sql) {
    const db = this.sqlite;
    function statement(args = []) {
      const runSync = () => {
        const result = db.prepare(sql).run(...args);
        return {
          success: true,
          meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) },
        };
      };
      return {
        bind(...values) {
          return statement(values);
        },
        async first(column) {
          const row = db.prepare(sql).get(...args);
          return row ? (column ? row[column] : { ...row }) : null;
        },
        async all() {
          return {
            success: true,
            results: db
              .prepare(sql)
              .all(...args)
              .map((row) => ({ ...row })),
          };
        },
        async run() {
          return runSync();
        },
        runSync,
      };
    }
    return statement();
  }
  async batch(statements) {
    this.sqlite.exec('BEGIN IMMEDIATE');
    // SQLite is synchronous: never yield while this connection owns a transaction.
    try {
      const results = statements.map((statement) => statement.runSync());
      this.sqlite.exec('COMMIT');
      return results;
    } catch (error) {
      this.sqlite.exec('ROLLBACK');
      throw error;
    }
  }
  close() {
    this.sqlite.close();
  }
}

export const NOW = Date.parse('2026-10-23T12:00:00Z');
export const SECRET = 'whsec_' + Buffer.alloc(32, 7).toString('base64');
export const SECRET2 = 'whsec_' + Buffer.alloc(32, 8).toString('base64');
export function environment(db = new TestDatabase()) {
  return {
    DB: db,
    OWNER_USER_ID: 'owner-test',
    TELEGRAM_BOT_TOKEN: '123456:synthetic-token-not-a-secret',
    TELEGRAM_WEBHOOK_SECRET: 'synthetic_webhook_secret_0123456789',
    TELEGRAM_ALLOWED_USER_IDS: '10001',
    TELEGRAM_ALLOWED_CHAT_IDS: '10001',
    MCP_CALLBACK_ORIGINS: 'https://callbacks.example.com',
    SITE_ORIGIN: 'https://connector.example',
  };
}
export function rpc(method, params = {}, caller = 'owner-test') {
  return new Request('https://connector.example/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(caller ? { 'oai-authenticated-user-id': caller } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
}
export function subscription(overrides = {}) {
  return {
    name: 'telegram.message.received',
    arguments: { chat_id: '10001' },
    delivery: {
      mode: 'webhook',
      url: 'https://callbacks.example.com/events/opaque-test-path',
      secret: SECRET,
    },
    ...overrides,
  };
}
export async function call(worker, env, name, args = {}) {
  const response = await worker.fetch(rpc('tools/call', { name, arguments: args }), env);
  return { status: response.status, body: await response.json() };
}
export function update(updateId = 42, text = 'Hello from a synthetic test') {
  return {
    update_id: updateId,
    message: {
      message_id: updateId + 10,
      date: Math.floor(NOW / 1000),
      chat: { id: 10001, type: 'private' },
      from: { id: 10001, is_bot: false, first_name: 'Test' },
      text,
    },
  };
}
export function telegramRequest(
  payload = update(),
  secret = 'synthetic_webhook_secret_0123456789',
) {
  return new Request('https://connector.example/telegram/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': secret },
    body: JSON.stringify(payload),
  });
}
export function verifySignature(init, secret = SECRET) {
  const h = new Headers(init.headers);
  const expected =
    'v1,' +
    createHmac('sha256', Buffer.from(secret.slice(6), 'base64'))
      .update(`${h.get('webhook-id')}.${h.get('webhook-timestamp')}.${init.body}`)
      .digest('base64');
  return h.get('webhook-signature')?.split(' ').includes(expected);
}
export function challengeResponse(init) {
  return Response.json({ challenge: JSON.parse(init.body).challenge });
}
