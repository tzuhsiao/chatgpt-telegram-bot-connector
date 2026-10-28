-- Title provenance and operation identities survive inbox expiry and restarts.
CREATE TABLE private_topics (
  bot_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  message_thread_id INTEGER NOT NULL,
  name TEXT,
  provenance TEXT NOT NULL CHECK(provenance IN ('unknown','implicit','manual','dot')),
  revision INTEGER NOT NULL DEFAULT 0,
  last_message_id INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(bot_id,chat_id,message_thread_id)
);
--> statement-breakpoint
CREATE TABLE topic_name_operations (
  operation_key TEXT PRIMARY KEY NOT NULL,
  request_hash TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  message_thread_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  mode TEXT NOT NULL,
  revision INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('reserved','applying','applied','unchanged','failed','uncertain')),
  superseded INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX topic_name_busy ON topic_name_operations(bot_id,chat_id,message_thread_id)
  WHERE state IN ('reserved','applying','uncertain');
