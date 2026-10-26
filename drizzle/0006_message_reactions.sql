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
ALTER TABLE inbox ADD COLUMN reaction_album INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
-- Legacy media discarded malformed album IDs. Fail closed until those rows expire.
UPDATE inbox SET reaction_album=1 WHERE media_json IS NOT NULL;
