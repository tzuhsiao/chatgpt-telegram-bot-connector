# Telegram Bot Connector

An unofficial, experimental connector primarily designed for dots. It lets your dot
talk with you, and with approved private groups, through your own Telegram bot, using
a small bridge hosted in your own ChatGPT Sites account.

Copy this into your dot:

> Review https://github.com/tzuhsiao/chatgpt-telegram-bot-connector for safety. If it
> looks suitable, follow AGENTS.md to install it for me.

## What it is (and isn't)

**Triggers and tools, not behavior.** The connector does two things: it notifies your
dot with an MCP event when an accepted Telegram message arrives, and it gives your
dot tools to operate its bot (send, react, read recent history, read images). How
your dot behaves (whether it replies, acknowledges, combines messages or stays
silent) is up to you and your dot; the connector never requires a reply to every
message.

**Yours, end to end.** The Site, its database, the plugin and every stored message
live in your own OpenAI account. Besides Telegram and ChatGPT themselves there is no
relay server, no service run by this repository's author, no extra model API, and no
third-party storage or telemetry.

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
