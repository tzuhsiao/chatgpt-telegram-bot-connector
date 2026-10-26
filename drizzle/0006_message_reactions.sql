CREATE TABLE reaction_operations (
  operation_key TEXT PRIMARY KEY NOT NULL,
  request_hash TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  message_id INTEGER NOT NULL,
  state TEXT NOT NULL,
  error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX reaction_target_busy ON reaction_operations(bot_id,chat_id,message_id)
  WHERE state IN ('applying','uncertain');
--> statement-breakpoint
-- -1 marks rows whose raw album presence was not retained before this migration.
-- New ingestion explicitly writes 0 or 1; no row-data backfill is required.
ALTER TABLE inbox ADD COLUMN reaction_album INTEGER NOT NULL DEFAULT -1;
