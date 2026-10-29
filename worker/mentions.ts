import { senderAllowed } from './access.ts';
import { DAY } from './constants.ts';
import { first, requireDatabase } from './db.ts';
import type { Env, Runtime } from './env.ts';
import { AppError } from './errors.ts';
import { botId } from './telegram.ts';
import { threadScope } from './threads.ts';
import { groupId, numericId, objectArgs } from './validate.ts';

export type Mention = { user_id: string; offset: number; length: number };

// Only numeric user links are generated. Labels remain literal slices of text;
// callers cannot supply markup, entity types, URLs or user profile assertions.
export function normalizedMentions(value: unknown, text: string): Mention[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20)
    throw new AppError('Use at most twenty explicit mentions.');
  if (!value.length) return [];
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text))
    throw new AppError('Mention text must be valid Unicode.');
  const boundary = (index: number) => {
    const before = text.charCodeAt(index - 1),
      after = text.charCodeAt(index);
    return !(before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff);
  };
  const mentions = value
    .map((item: unknown): Mention => {
      const fields = objectArgs(
        item,
        ['user_id', 'offset', 'length'],
        ['user_id', 'offset', 'length'],
      );
      const { user_id, offset, length } = fields;
      if (
        !numericId(user_id) ||
        typeof offset !== 'number' ||
        typeof length !== 'number' ||
        !Number.isSafeInteger(offset) ||
        !Number.isSafeInteger(length) ||
        offset < 0 ||
        length < 1 ||
        length > text.length ||
        offset > text.length - length ||
        !boundary(offset) ||
        !boundary(offset + length) ||
        !text.slice(offset, offset + length).trim()
      )
        throw new AppError('Invalid mention user ID or UTF-16 range.');
      return { user_id, offset, length };
    })
    .sort((a, b) => a.offset - b.offset);
  for (let i = 1; i < mentions.length; i++) {
    const previous = mentions[i - 1],
      current = mentions[i];
    if (previous && current && previous.offset + previous.length > current.offset)
      throw new AppError('Mention ranges must not overlap.');
  }
  return mentions;
}

export async function requireMentionTargets(
  mentions: Mention[],
  chat: string,
  thread: number | null,
  revision: unknown,
  env: Env,
  runtime: Runtime,
): Promise<void> {
  const scope = threadScope(thread, !groupId(chat));
  let oldest = Infinity;
  for (const user of new Set(mentions.map((mention) => mention.user_id))) {
    if (!senderAllowed(chat, user, env))
      throw new AppError('Mention target is not an approved sender in this chat.', 403, -32001);
    const record = await first(
      requireDatabase(env),
      `SELECT received_at FROM inbox WHERE bot_id=? AND chat_id=? AND sender_id=?
      AND ${scope.column} IS ? AND group_revision IS ? AND received_at>=?
      AND (last_error IS NULL OR last_error NOT IN ('access_revoked','group_access_revoked'))
      ORDER BY received_at DESC LIMIT 1`,
      botId(env),
      chat,
      user,
      scope.value,
      revision,
      runtime.now() - 7 * DAY,
    );
    if (
      !record ||
      typeof record.received_at !== 'number' ||
      record.received_at < runtime.now() - 7 * DAY
    )
      throw new AppError(
        'Mention target must be retained in this exact chat/topic and approval epoch.',
        403,
        -32001,
      );
    oldest = Math.min(oldest, record.received_at);
  }
  if (oldest < runtime.now() - 7 * DAY)
    throw new AppError('Mention target provenance has expired.', 403, -32001);
}

export function mentionEntities(mentions: Mention[]) {
  return mentions.map(({ user_id, offset, length }) => ({
    type: 'text_link',
    offset,
    length,
    url: `tg://user?id=${user_id}`,
  }));
}
