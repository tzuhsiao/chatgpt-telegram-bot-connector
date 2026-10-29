-- Optional per-message observation; legacy rows remain unknown (NULL).
ALTER TABLE inbox ADD COLUMN sender_username TEXT;
