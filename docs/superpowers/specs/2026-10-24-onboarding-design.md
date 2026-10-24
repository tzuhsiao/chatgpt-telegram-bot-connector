# Personal Telegram onboarding

Implement issue #6 for a Dot reading the repository URL: a short public README,
agent-facing guidance in AGENTS.md, and a reusable setup skill. Install or reuse
the Site and its canonical plugin before requesting the two owner inputs. Use
Telegram Bot as the product name; preserve protocol/tool/package IDs.

The skill orchestrates supported native Sites/plugin/event tools. A dependency-free,
side-effect-free Node helper selects one next checkpoint from enumerated, redacted
observations. It accepts no identities, URLs or credentials, persists nothing, and
does not confer authorization. Re-read authoritative host state on every resume;
unknown outcomes, ambiguous installations and stale task references require
reconciliation before creation. All mutations remain subject to owner approval.

Alternatives considered: documentation alone leaves repeated setup decisions to
the agent; an autonomous provisioning service would add an unverified credential
and authorization boundary. The bounded skill and checkpoint helper fit the
existing Sites architecture and the implementation-only scope. This is an
implementation decision under the supplied task specification, not a new promise
that every host supports unattended installation.

Keep verified Site-scoped ownership, both matching private-chat allowlists,
independent secrets, exact independently verified callback origins, authenticated
subscriptions, fixed webhooks and existing idempotency. No live installation,
deployment, credentials, automation changes, deletion or Telegram messages during
development. Native tools can provision/inspect Sites and their canonical plugin;
protected token entry and some acceptance checks may require user interaction.
Missing capabilities must produce an exact pending/blocked checkpoint.

Fresh setup must detect old automation and bot webhook references even after the
owner deletes a Site/plugin. Reinstallation must not silently replace a webhook,
create an extra responder, replay old messages, or inherit an old Site owner ID.
Local checks prove the helper and transport, not hosted or real-message acceptance.
