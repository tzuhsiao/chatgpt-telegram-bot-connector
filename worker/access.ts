import type { Env } from './env.ts';
import { AppError } from './errors.ts';
import { groupId, numericId } from './validate.ts';

// Platform-verified Site-scoped caller ID. Trust depends on the hosting edge
// stripping client-supplied copies of this header (see docs/operations.md).
export function callerId(request: { headers: Headers }): string | null {
  return request.headers.get('oai-authenticated-user-id') || null;
}

export function requireOwner(request: { headers: Headers }, env: Env): string {
  const id = callerId(request);
  if (!id) throw new AppError('Authentication required.', 401, -32001);
  if (!env.OWNER_USER_ID) throw new AppError('Owner configuration is required.', 503, -32002);
  if (id !== env.OWNER_USER_ID) throw new AppError('Owner access required.', 403, -32001);
  return id;
}

export function allowlist(value: unknown): Set<string> {
  if (!value) return new Set();
  const entries = String(value)
    .split(',')
    .map((value) => value.trim());
  if (entries.some((value) => !numericId(value)))
    throw new AppError('Invalid allowlist configuration.', 503, -32002);
  return new Set(entries);
}

export function requireChat(chat: unknown, env: Env): string {
  if (groupId(chat) && groupConfig(env).has(chat)) return chat;
  if (!numericId(chat) || !allowlist(env.TELEGRAM_ALLOWED_CHAT_IDS).has(chat))
    throw new AppError('Chat is not allowed.', 403, -32001);
  return chat;
}

// Separate group/participant approvals never grant access to a human's private chat.
export function groupConfig(env: Env): Map<string, string[]> {
  if (!env.TELEGRAM_ALLOWED_GROUPS) return new Map();
  let value: unknown;
  try {
    // JSON.parse coerces its argument to a string, exactly as before.
    value = JSON.parse(env.TELEGRAM_ALLOWED_GROUPS as string);
  } catch {
    throw new AppError('Invalid group configuration.', 503, -32002);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 10)
    throw new AppError('Invalid group configuration.', 503, -32002);
  const result = new Map<string, string[]>();
  for (const [chat, humans] of Object.entries(value)) {
    if (
      !groupId(chat) ||
      !Array.isArray(humans) ||
      humans.length !== 2 ||
      humans.some((id) => !numericId(id)) ||
      new Set(humans).size !== 2
    )
      throw new AppError('Invalid group configuration.', 503, -32002);
    result.set(chat, [...(humans as string[])].sort());
  }
  return result;
}

export function observedGroups(env: Env): {
  groups: Map<string, string[]>;
  error: 'invalid_group_config' | null;
} {
  try {
    return { groups: groupConfig(env), error: null };
  } catch {
    return { groups: new Map(), error: 'invalid_group_config' };
  }
}

export function securityConfigured(env: Env): boolean {
  return (
    !!env.OWNER_USER_ID &&
    ((allowlist(env.TELEGRAM_ALLOWED_USER_IDS).size > 0 &&
      allowlist(env.TELEGRAM_ALLOWED_CHAT_IDS).size > 0) ||
      observedGroups(env).groups.size > 0)
  );
}

// A private message is accepted only when sender and chat match and appear in both
// allowlists; a group message only when the sender is one of that group's approved humans.
export function senderAllowed(chat: unknown, sender: unknown, env: Env): boolean {
  if (groupId(chat))
    return (
      observedGroups(env)
        .groups.get(chat)
        ?.includes(sender as string) === true
    );
  return (
    chat === sender &&
    allowlist(env.TELEGRAM_ALLOWED_CHAT_IDS).has(chat as string) &&
    allowlist(env.TELEGRAM_ALLOWED_USER_IDS).has(sender as string)
  );
}
