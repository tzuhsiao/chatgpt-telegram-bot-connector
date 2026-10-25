ALTER TABLE group_access ADD COLUMN is_forum INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE inbox ADD COLUMN message_thread_id INTEGER;
--> statement-breakpoint
CREATE TABLE sent_messages (
  operation_key TEXT PRIMARY KEY NOT NULL,
  bot_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  message_id INTEGER NOT NULL,
  message_thread_id INTEGER,
  group_revision INTEGER,
  text TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  sent_at INTEGER NOT NULL,
  UNIQUE(bot_id, chat_id, message_id)
);
--> statement-breakpoint
CREATE INDEX sent_messages_chat ON sent_messages(bot_id,chat_id,message_thread_id,sent_at);
