CREATE TABLE group_access (
  bot_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  config_hash TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'paused',
  revision INTEGER NOT NULL DEFAULT 0,
  verified_at INTEGER,
  last_error TEXT,
  PRIMARY KEY(bot_id, chat_id)
);
--> statement-breakpoint
CREATE TABLE group_updates (
  bot_id TEXT NOT NULL,
  update_id INTEGER NOT NULL,
  chat_id TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  PRIMARY KEY(bot_id, update_id)
);
--> statement-breakpoint
ALTER TABLE inbox ADD COLUMN group_revision INTEGER;
