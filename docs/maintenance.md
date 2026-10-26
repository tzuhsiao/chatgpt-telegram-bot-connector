# Visible-error maintenance

The [telegram-maintenance skill](../.agents/skills/telegram-maintenance/SKILL.md)
investigates visible failures under the user's current authorization. It supports
sanitized GitHub issues and, when implementation is in scope, tested draft PRs.
It does not grant authority, change access or revive stopped tasks. Instructions
are designed for capable models; the Dot chooses the investigation within the
stated evidence, privacy and operation constraints.

## Diagnostics contract

MCP JSON-RPC errors include `error.data.diagnostics`; unsuccessful tool results
include `structuredContent.diagnostics` and the same text content. Existing RPC
codes, HTTP statuses, reason fields, send states and image content remain intact.

| Field | Meaning |
| --- | --- |
| `schema_version` | Diagnostic contract version, currently 1. |
| `category` | Initial attribution: invocation, configuration, permission, platform or unknown. Platform includes callback and Telegram failures; a defect needs source/reproduction evidence before attributing it to the connector. |
| `reason` | Fixed, public-safe symptom vocabulary; not upstream error text. |
| `source_version` | `sha256:` digest of the public source-input manifest. Direct unbuilt source says `unbuilt`; never guess a deployed version from local main. |
| `correlation_id` | Random per-MCP-request UUID with `diag_` prefix. Shared with optional rejected-event logs; not derived from a chat, operation, host request header or deployment. Not a stable incident key or persistent lookup API. |
| `operation_state` | Conservative state: not_started, unknown, sending, failed, uncertain, or read_unavailable. The existing send result remains authoritative. Unknown includes exceptions after possible writes. |
| `retry` | `safe` plus a bounded action hint. False is the default for mutations. A read hint permits at most one retry within scope. Safety is not authorization. |
| `maintenance_skill`, `maintenance_url` | Skill discovery. The URL tracks public main; inspect the matching source version for implementation evidence. |

Only this fixed envelope is intended to be public-safe. Ordinary identity, status,
history and media results contain private data and must not be attached wholesale.
No exception stack, request arguments, upstream response descriptions, identifiers,
private hashes, credentials or runtime metadata enter the envelope. Optional
`MCP_DIAGNOSTICS=1` event logs count unexpected keys rather than echoing their names.
They are still private operational logs, not public attachments. The ID only
correlates a response with a log when such a log exists; no diagnostic database or
telemetry service is added.

`npm run build` computes the fingerprint from an explicit list of public Worker,
skill, build recipe and migration inputs. `dist/public-source.json` records each
file hash so another checkout can reproduce it with `publicSource(root)` from
`scripts/public-source.mjs`. Text inputs normalize CRLF to LF for cross-checkout matching. No Git remote, dirty status, environment variables,
private hosting manifest, timestamps or Site identity affect the fingerprint.

An uncertain/in-flight send still requires private reconciliation of the actual
chat and durable operation record. Never use a send as a status probe, change its
frozen key or arguments, or treat retention expiry as proof that it did not send.
No automatic resend, new operation or new recovery endpoint is introduced.

## Package into the existing canonical plugin

Building emits the self-contained payload at
`dist/plugin-skills/skills/telegram-maintenance/SKILL.md`. This is an update payload,
not another plugin and not a standalone upload archive. Every MCP tool description
points to the skill; hosts without packaged skills can read its public URL. A
repository file or Site deployment alone does not install a skill in the plugin.

For an authorized plugin release, use the current Plugin Creator App-backed update
workflow. Resolve the existing canonical plugin from the Site, inspect its current
source and eligibility, retain its scope and release ID, and preserve its App/MCP
connections and presentation. Given that inspected portable source:

```sh
node scripts/prepare-maintenance-plugin.mjs <current-plugin-source> <new-private-output-directory>
```

The helper prepares a partial overlay with the skill and a patch-version bump in
the current manifest(s), preserving all other manifest values. It rejects existing
output directories, non-stable-semver/legacy-only manifests, identity mismatches
and unsupported portable or custom legacy skill paths requiring host-specific reconciliation. Omitted
files remain in the current plugin release. Inspect the effective candidate,
archive privately with files at the archive root, then use the verified plugin ID
and expected release ID for the supported update. Read back the saved skill and
manifest, check retained files and connections, and verify actual host discovery.
Resolve release conflicts from fresh source. Private plugin manifests/archives
must never enter this public repository. If the host cannot update this plugin,
report that exact limit; do not create a replacement plugin.

This implementation task prepares source and payload only. It does not publish
the plugin or deploy the Worker. Both the packaged skill and refreshed MCP tool
descriptions need hosted verification after an authorized release.

## Acceptance and limits

Local tests use synthetic SQLite state, network responses and plugin manifests.
They verify category boundaries, public-field privacy, shared correlation IDs,
reproducible fingerprints, packaging preservation and unchanged send deduplication.
The existing media retrieval suite covers actual image blocks and access bounds.

Hosted acceptance remains pending until deployment/plugin publication is separately
authorized: verify skill discovery in the intended Dot host, trigger a controlled
connector error in an approved test context, observe the bounded investigation,
and with scoped GitHub authorization verify one sanitized actionable report or
draft PR. A real report must distinguish observation, hypothesis, synthetic
reproduction and validation, and search both issues and PRs first. Repeated unchanged
instances should produce neither report nor notification loops. Verify frozen-send
handling without sending live probes. Do not disrupt the working installation to
satisfy acceptance.

A completely stopped task cannot see an error or run this skill. Detecting that
condition is a separate health-check problem requiring separate scheduling and
authorization; this change adds no polling, heartbeat or automatic task revival.
