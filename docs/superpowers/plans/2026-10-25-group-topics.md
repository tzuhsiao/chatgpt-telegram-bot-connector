# Group topic routing plan

Support forum supergroups within existing two-human group approval, retaining
membership checks, durable pause/epochs, private-chat compatibility and dot autonomy.
No live changes, README expansion, topic management or private-topic issue #15.

- Add failing integration tests for named topics and General, exact event/storage
  routing, explicit scoped history/sends, invalid/missing IDs, ordinary replies,
  quote-target boundaries, idempotency/uncertainty and populated migration.
- Add migration 0003: group forum mode, inbox thread context and separate confirmed
  outgoing text records with seven-day content retention. Preserve thirty-day
  operation metadata and historical request hashes for unthreaded calls.
- Verify forum mode with membership, pause on mode changes, and normalize forum
  General to thread 1. Topic messages require a positive safe-integer thread ID.
  Ordinary non-forum replies do not become topics. Private topic messages remain
  unsupported rather than being forwarded without routing context.
- Keep one subscription per chat; add forum message_thread_id to event payloads.
  Require explicit topic selection for forum sends/history, including 1 for General
  (omit Telegram's thread parameter when sending to General). Validate returned
  routing and retained quote targets; never fall back to General on error.
- Add optional include_outgoing history, default false for compatibility. Merge
  retained incoming and confirmed bot text only, with roles/senders, exact thread
  and approval epoch. No Telegram history fetch/import or invented transcript.
- Update AGENTS/setup/group operations guidance and actual retention. Run focused
  and full tests/build/artifact/privacy checks, WSL Claude review, fixes/re-review,
  draft PR and merge after successful CI; verify remote main and post-merge CI.
