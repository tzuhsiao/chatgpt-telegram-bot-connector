// Runtime settings from native Sites controls. Every string setting is external
// input: it stays `unknown` until the code that uses it validates it.
export interface Env {
  DB?: D1Database;
  OWNER_USER_ID?: unknown;
  SITE_ORIGIN?: unknown;
  TELEGRAM_BOT_TOKEN?: unknown;
  TELEGRAM_WEBHOOK_SECRET?: unknown;
  TELEGRAM_ALLOWED_USER_IDS?: unknown;
  TELEGRAM_ALLOWED_CHAT_IDS?: unknown;
  TELEGRAM_ALLOWED_GROUPS?: unknown;
  MCP_CALLBACK_ORIGINS?: unknown;
  MCP_DIAGNOSTICS?: unknown;
}
