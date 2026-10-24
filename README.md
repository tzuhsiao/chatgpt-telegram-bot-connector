# Telegram Bot Connector

An unofficial, experimental connector primarily for dots. It creates a small bridge
in your own ChatGPT Sites account so your dot can receive private Telegram bot
messages and reply there. The bridge runs on Sites, not your computer.

Message and delivery records live in storage attached to your Site, not on a
separate server run by this repository's author. Incoming records expire after 7
days and send-operation records after 30; physical cleanup runs with activity and
can happen later. These limits do not describe Telegram or ChatGPT's own records.
The send log is not a conversation archive. [Data details](docs/operations.md#retention-privacy-and-maintenance).

Copy this into your dot:

> Review https://github.com/tzuhsiao/chatgpt-telegram-bot-connector for safety. Explain
> what it installs and stores, then follow AGENTS.md to set it up. Guide me through
> my Telegram user ID and protected bot-token entry. Ask for approval before
> credentials, bot connection, or one welcome message to my confirmed private chat.

New defaults: Site **Telegram Bot Connector**, plugin **Telegram Bot**. Sign-ins,
protected secret entry or Telegram Start/message may need you. Never paste tokens
into chat. Agents: follow [AGENTS.md](AGENTS.md) and the
[setup skill](.agents/skills/telegram-setup/SKILL.md).
