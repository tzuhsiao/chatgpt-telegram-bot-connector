CREATE TABLE media_cache (
  cache_key TEXT PRIMARY KEY NOT NULL,
  bot_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  lease_token TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('downloading','ready','failed')),
  allocated_bytes INTEGER NOT NULL CHECK(allocated_bytes>=0 AND allocated_bytes<=8000000),
  fetch_limit INTEGER NOT NULL DEFAULT 8000000 CHECK(fetch_limit IN (2000000,8000000)),
  byte_length INTEGER,
  mime_type TEXT,
  expires_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX media_cache_expiry ON media_cache(expires_at);
--> statement-breakpoint
CREATE TABLE media_chunks (
  cache_key TEXT NOT NULL REFERENCES media_cache(cache_key) ON DELETE CASCADE,
  lease_token TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY(cache_key,lease_token,chunk_index)
);
