CREATE TABLE subscriptions (
  id TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL,
  chat_id TEXT NOT NULL UNIQUE,
  callback_url TEXT NOT NULL,
  secret TEXT NOT NULL,
  previous_secret TEXT,
  rotation_until INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  verified_at INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1
);
--> statement-breakpoint
CREATE TABLE inbox (
  event_id TEXT PRIMARY KEY NOT NULL,
  bot_id TEXT NOT NULL,
  update_id INTEGER NOT NULL,
  chat_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  message_id INTEGER NOT NULL,
  text TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  subscription_id TEXT,
  state TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  last_status INTEGER,
  last_error TEXT,
  delivered_at INTEGER,
  UNIQUE(bot_id, update_id)
);
--> statement-breakpoint
CREATE INDEX inbox_pending ON inbox(state, next_attempt_at, received_at);
--> statement-breakpoint
CREATE INDEX inbox_chat ON inbox(chat_id, received_at);
--> statement-breakpoint
CREATE TABLE outgoing (
  operation_key TEXT PRIMARY KEY NOT NULL,
  request_hash TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  state TEXT NOT NULL,
  message_id INTEGER,
  error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE connector_meta (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);
