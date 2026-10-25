# Group input boundary revision

Implement the owner's approved boundary: configured private group ID plus actual
human sender user IDs control input to the dot. Users manage the audience. Keep
the existing configured two-sender mappings; do not expand recipients or public
group scope. Reject strangers, bots and sender_chat before inbox/event/history
exposure without pausing approved traffic. Quoted/forwarded content is untrusted
submission by the actual sender, never original-source authority.

- Write regressions for audience changes and rejected inputs that neither persist,
  trigger nor pause. Preserve race tests using explicit owner pause, config
  revocation and actual bot access loss, not harmless joins.
- Replace roster/count/admin and invite-permission gates with private metadata,
  topic-mode and bot-self availability checks. Ignore other members' changes;
  retain durable pause for bot loss/unusable access, migrations, explicit pause and
  configuration changes. Request only message/my_chat_member for future group
  webhook configuration; handle legacy member events safely.
- Keep sender filtering in retained incoming history and pending delivery. Preserve
  topic/epoch isolation, idempotency, owner/callback/credential checks and private
  responders. No quote ingestion, live changes, new IDs or machine migration.
- Rewrite obsolete active guidance around input authorization versus audience and
  operational delivery choices. README unchanged. Run focused/full tests, build,
  artifact/privacy checks, draft PR, WSL Claude review/fixes/re-review, final-head
  CI, merge and verify remote main/post-merge CI. Parent handles deployment.
