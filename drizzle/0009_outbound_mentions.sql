-- Nullable metadata preserves legacy plain-text requests and their hashes.
ALTER TABLE outgoing ADD COLUMN mentions_json TEXT;
--> statement-breakpoint
ALTER TABLE sent_messages ADD COLUMN mentions_json TEXT;
