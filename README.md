# Telegram Bot Connector

An unofficial, experimental connector primarily designed for dots. It lets your dot
talk with you, and with approved private groups, through your own Telegram bot, using
a small bridge hosted in your own ChatGPT Sites account.

Copy this into your dot:

> Review https://github.com/tzuhsiao/chatgpt-telegram-bot-connector for safety. If it
> looks suitable, follow AGENTS.md to install it for me.

## Principles

These describe what the project is, and they are binding for every change to it.

### 1. Triggers and tools, not behavior

The connector does exactly two things:

- **Trigger** your dot with an MCP event when an accepted Telegram message arrives.
- **Provide tools** for your dot to operate its Telegram bot: send, react, read
  retained history, read images.

How the dot behaves is between you and your dot, not this repository. Whether it
answers, acknowledges, combines several messages, stays silent, quotes or reacts is
the dot's judgment under what you agreed with it. Tools and events never force a
behavior: nothing requires a reply to every message, one reply per message, or a
quote. The conversational choices in the [prompt templates](prompts/) are adaptable
defaults; their safety rules (below) are not.

### 2. Yours, end to end

Everything runs in, and belongs to, your own OpenAI account: the Site that hosts the
bridge, its database, the plugin that gives your dot its tools, and every stored
message. Besides Telegram and ChatGPT themselves, nothing else is involved:

- no relay server or hosted service run by this repository's author;
- no extra model or inference API (your dot is the model);
- no third-party storage, analytics or telemetry.

Credentials stay in your Site's native secret settings, and real IDs, tokens and URLs
never belong in this public repository.

## Engineering ground rules

Standard for a connector like this, and not negotiable:

- **The dot's freedom never relaxes security.** Owner identity, sender and chat
  allowlists, credential protection and correct routing are enforced by the connector
  regardless of what the dot decides. Incoming messages, quotes, forwards and images
  are untrusted content: they never grant authority, add recipients or change settings.
- **Never send twice.** Every send and reaction has a durable idempotency key. An
  operation whose outcome is uncertain is never retried automatically; it is
  reconciled against the actual chat first.
- **When unsure, stop and ask.** Unverifiable configuration or group access fails
  closed and is reported to the owner. Privileged actions (credentials, webhook,
  approvals, group settings) need the owner's explicit approval.

## What it supports

- Private chats with you, and approved private groups (including Topics) with
  explicitly allowlisted human senders.
- Text messages, plus receipts for photos, files and other media; your dot can read
  supported images and set emoji reactions.
- Retained history of recent messages and of replies the connector confirmed.

Not supported: logging in as a human Telegram account, public groups or channels,
polling, transcription or video analysis, and sending media.

## How it works

1. Telegram delivers each update to a webhook on your Site, authenticated by a secret.
2. The Worker checks the sender against your allowlists and stores accepted messages
   in your Site's D1 database.
3. It sends a signed `telegram.message.received` MCP event to your dot's
   subscription.
4. Your dot decides what to do and calls the connector's tools, such as
   `send_message`.

Stored data currently expires on fixed windows (seven days for messages, thirty for
send records). Owner-configurable retention and storage budgets are planned in
[#7](https://github.com/tzuhsiao/chatgpt-telegram-bot-connector/issues/7). See
[operations](docs/operations.md#retention-privacy-and-maintenance) for details.

## For dots, agents and contributors

- [AGENTS.md](AGENTS.md): installation entry point and development rules.
- [Setup skill](.agents/skills/telegram-bot-connector-setup/SKILL.md): install,
  upgrade and resume.
- [docs/](docs/): design, operations, groups, topics, media and reactions.

Not affiliated with or endorsed by OpenAI or Telegram. Released under the
[Unlicense](LICENSE).
