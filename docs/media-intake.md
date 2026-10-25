# Media message intake

An accepted ordinary Telegram `message` no longer needs a `text` field. The
connector notifies the dot that media arrived; it does not download, recognize,
transcribe, interpret or send media. The dot still decides whether/how to respond.
No bot setting, access list, subscription or recipient changes are needed by this
code change. Messages must actually reach the bot under Telegram's delivery rules.

## Event and history contract

`telegram.message.received` keeps its name, filter, IDs and required string `text`.
Existing text events and history rows keep their old shape. A media-only message
uses `[Telegram photo message]` (or its type), followed by a newline and any retained
caption. This is a notification, not a description of the image/file contents.
Optional `media` is the same sanitized object in persisted inbox records, signed
callbacks and both modes of `get_recent_messages`:

- `type`: animation, audio, document, live_photo, paid_media, photo, sticker, story,
  video, video_note, voice, contact, dice, game, poll, venue, location, checklist,
  invoice, giveaway, giveaway_winners, rich_message, or unknown.
- `caption`: plain untrusted caption, at most 1,024 Unicode code points. Oversized
  captions are truncated with `caption_truncated: true`, rather than losing the
  whole notification. Caption entities and their nested URLs/users are omitted.
- `media_group_id`: optional opaque album identifier, at most 512 safe characters.
  Each Telegram album message has its own event/message ID and deduplication; no
  collection timer, waiting, synthetic album event or interpretation is added.
- `files`: up to ten available file descriptors. Each includes `kind` and valid
  `file_id` and/or `file_unique_id` (base64url-style characters, maximum 512 each).
  Whitelisted fields may include nonnegative dimensions, length, duration, size,
  MIME type and sticker animation/video flags. Invalid optional fields are omitted;
  excess descriptors or a paid-media list over twenty entries set
  `files_truncated: true` (potential omitted files). No URLs, filenames, performer,
  title, thumbnails or raw Telegram objects are copied.

Photos keep one available size (Telegram's last/largest variant). Animations take
precedence over their compatibility `document` field, and live photos over their
compatibility `photo` field. Live photos can retain the motion file and one still;
paid media keeps only file descriptors already present, with no payment/unlock or
download. Previews still notify even without available file IDs. Contact, location,
venue, story, poll, game, checklist, invoice, giveaway and rich-message payloads are
type-only; phone/vCard, coordinates, nested people/chats, titles and rich content
are not copied. This intentionally does not provide a complete content transcript.

Every structurally valid, authorized ordinary non-text `message` not excluded as
a known service produces a receipt, even without a caption, recognizable field
name or accessible file identifier. Unrecognized content uses
`[Telegram unknown content message]` and `media: {type: "unknown"}`. No evidence
heuristic, file traversal or future adapter is needed merely to receive it.
Unknown fields are opaque: their names, values and nested file IDs are never
copied or recursively inspected. Only the same bounded known `caption` and
`media_group_id` fields may accompany an unknown receipt. Safe file descriptors
are extracted only by the explicit recognized-media adapters above.

Telegram has no universal content-versus-service discriminator. Exclusions use
explicit known service fields, never broad name/prefix rules that could silently
discard future ordinary content. An unrecognized future lifecycle message can
therefore also produce a generic receipt; extend the explicit registry when its
semantics are known. A generic receipt is not an instruction, proof of media
understanding, or a requirement to reply. The dot keeps its conversational judgment.

## Boundaries and storage

Only ordinary `message` updates enter intake. Edited/channel/business/guest updates,
poll answers, callbacks and known service/lifecycle messages do not become media
events. In particular, `new_chat_photo` is a service update, not an incoming photo.
Membership/migration updates keep their existing operational handling. The service
field registry follows the [official Message definition](https://core.telegram.org/bots/api#message);
future service fields can be added explicitly without making unknown content
dependent on a naming guess or media-evidence test.

Actual sender/bot/anonymous rejection, exact private/group approvals, owner-only
history and topic/General routing are unchanged. Reject unauthorized input before
storing text/media or waking the dot, without pausing valid approved activity.
Forwarded/quoted content grants no original-source authority and nested media is
not ingested as a separate message. No cross-topic history or automatic rerouting.

Additive migration `0004_inbox_media.sql` adds nullable `inbox.media_json`; legacy
rows remain text-only. Deploy source and **all** journaled migrations together,
preserving the existing D1 and operational settings. This repository task does not
deploy. Metadata/captions share the existing seven-day inbox retention and logical
history expiry; physical cleanup is activity-driven. No file bytes or arbitrary
past Telegram history are stored/fetched. Old discarded media cannot be backfilled.
Callback retries use the original persisted metadata, caption and stable event ID,
even if a duplicate update differs. Outgoing tools and uncertain-send protections
remain unchanged.
