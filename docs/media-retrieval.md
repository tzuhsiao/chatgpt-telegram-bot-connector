# Private media retrieval

The receipt event and history keep their existing text, caption and bounded media
metadata contract. No bytes, URLs or download outcomes are added to callbacks.
Receipt alone never proves that the dot saw an image.

## Hybrid retrieval

An ordinary photo or a sticker explicitly marked `is_animated: false` and
`is_video: false`, with a retained `file_id` and known size at most **2,000,000
bytes**, is eligible for automatic prefetch. Paid media, live photos, documents,
animations, audio, voice, video and unknown-size files are not automatically
fetched. Each available retained file is selected by its bounded descriptor;
unknown/nested/quoted payloads are not searched for files.

After persisting and attempting the receipt, the Worker schedules eligible
prefetch using `ctx.waitUntil`. Download failures, cache pressure and cancellation
do not change callback data, delivery state or webhook status. Environments without
the Worker execution context skip background prefetch; the retrieval tool remains
available. Background work is best effort, with no scheduled drainer or guarantee
that it survives an isolate termination.

The owner-only tool is:

```
get_message_media(chat_id, message_id, update_id,
                  message_thread_id?, file_index?, mode?)
```

Use IDs from the actual event or retained authorized history. `file_index` defaults
to zero; forum topics require the actual explicit thread, including 1 for General.
The tool accepts no URLs or raw file IDs. It resolves the retained incoming row,
checks logical seven-day retention, bot identity, current sender/chat approvals,
group access epoch and exact topic, then checks again before returning content.
Group reads retain the existing live bot-access verification behavior; operational
failure can pause group access. The caller is the owner, not a task-specific
identity: task policies must also prevent private/group context disclosure.

- `mode: auto` enforces the same eligible type/known-size policy and **2,000,000
  actual streamed bytes**, even when Telegram metadata understates the length.
- `mode: on_demand` (the default) explicitly permits fetching a retained file up
  to **8,000,000 actual bytes**. Larger files are unsupported in this version.
  A failed automatic size-limited attempt does not block a larger explicit read.
- Supported static JPEG, PNG, WebP and single-frame GIF containers are returned
  as actual MCP `image` content blocks, with MIME detected from bytes. Header
  dimensions must be positive, each side at most 8,192 and area at most 16 million
  pixels. No server-side image model, decoding, OCR or transcoding is performed.
- Other bytes can be fetched on demand but are discarded after format checking and return
  `unsupported` metadata, **without a binary attachment or claimed model access**.
  Animated images, arbitrary documents, voice/audio and video have no verified
  general model-readable transport here. No automatic transcription, video analysis,
  execution or following embedded instructions is authorized.

Results report `ready`, `on_demand_required`, `in_progress`, `cache_full`,
`unavailable` or `unsupported`. Download errors are deliberately generic and never
include Telegram file paths, token-bearing URLs or upstream exception text.
`in_progress` is transient: a concurrent background/tool download owns the lease.
The tool waits internally up to its finite deadline before returning this state;
it does not grant authority for task polling or claiming image understanding.

## Storage, expiry and deduplication

Additive migration `0005_media_cache.sql` uses the existing private D1 binding.
The cache has at most **32 entries** and **32,000,000 reserved/decoded bytes**.
Atomic admission reserves the request's maximum byte budget before network access;
successful image entries shrink the reservation to actual size. Unsupported files
retain no byte chunks or allocation. Failure markers release their byte allocation
and suppress same-budget downloads for 60 seconds; larger explicit reads can retry. Active download leases
expire after 30 seconds; complete entries expire 10 minutes after admission.
Concurrent requests for the same scoped file reuse a ready cache entry or receive
`in_progress`, rather than downloading twice. Foreground reads wait inside the tool for a
concurrent lease with finite backoff within a 14-second tool budget; responder
tasks do not poll. On capacity pressure one oldest ready entry may be evicted and
admission retried; active reservations are never evicted.

524,286-byte raw chunks (divisible by three so stored base64 joins without decoding) are base64-encoded in separate rows, safely below D1's
2,000,000-byte row limit. Encoded storage can be approximately 43 MB plus bounded
row metadata at the maximum decoded budget. Cache keys bind owner, bot, chat,
actual sender, topic, group epoch and retained file identifiers; deduplication
never grants cross-chat/topic access. Logical expiry applies to reads even when
physical cleanup has not run. Activity deletes expired entries and chunks;
**an idle Site can retain expired bytes longer**. Private approval removal denies
reads immediately but does not physically purge bytes before normal expiry/cleanup.
Group pause/revocation purges
its cache transactionally. Telegram and ChatGPT retention policies are separate.
Deleted Telegram messages cannot be detected reliably and may remain retrievable
through retained authorized context until its logical expiry.

## Deployment and acceptance

Publish reviewed source with all journaled migrations to the existing Site/D1,
preserving operational settings, private/group allowlists, Site/plugin identity,
subscriptions and outgoing idempotency. No new storage binding, secret or config
key is needed. Re-disclose the private byte-cache storage/expiry to existing users.

The approved UX also requires separately applying the automatic-read paragraph in
`prompts/private-chat.md` and the supplement in `prompts/group-media.md` to the
existing responders. Preserve all complete triggers, IDs, activation/coverage
state, frozen plans and conversational autonomy. This repository change does not
edit live tasks and does not require a reply to every image.

[MCP Events](https://developers.openai.com/plugins/build/mcp-events) documents JSON
callbacks capped at 256 KiB; no inline image attachment field is assumed. Actual
[MCP image blocks](https://modelcontextprotocol.io/specification/2026-07-28/server/tools#image-content)
are the proposed model-readable path. A 2,000,000-byte image is about 2.67 MB of
base64, so hosted response limits and model consumption must still be tested.

Before claiming hosted image readability, obtain separate acceptance consent and
verify a fresh synthetic image with an unpredictable rendered token through an
actual event-triggered private responder, group responder and forum topic. Check
that the task calls the image tool without a manual user fetch and perceives that
token; test a near-limit image and an honest failure result. Local tests prove
connector logic and MCP result shape, not Sites passthrough, model perception or
deterministic task compliance. Do not run live tests on an existing installation
without applicable consent.
