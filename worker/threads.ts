import { AppError } from './errors.ts';

export function validThread(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

// Topic of an incoming forum-group message: a named topic ID, or 1 for General.
export function incomingThread(message: Record<string, unknown>, forum: boolean): number | null {
  if (!forum) return null;
  if (message.message_thread_id !== undefined && !validThread(message.message_thread_id))
    throw new AppError('Invalid topic ID.');
  if (message.is_topic_message !== undefined && typeof message.is_topic_message !== 'boolean')
    throw new AppError('Invalid topic context.');
  if (message.is_topic_message === true) {
    if (!validThread(message.message_thread_id) || message.message_thread_id === 1)
      throw new AppError('Named topic ID is required.');
    return message.message_thread_id;
  }
  // General is not is_topic_message in Telegram's Bot API representation. Ordinary
  // General reply threads can have a message_thread_id; they are not named topics.
  return 1;
}

// Topic requested by a tool call: required for forum groups, refused elsewhere.
export function requestedThread(
  args: Record<string, unknown>,
  group: { is_forum?: unknown } | null | undefined,
): number | null {
  if (args.message_thread_id !== undefined && !validThread(args.message_thread_id))
    throw new AppError('Invalid topic ID.');
  if (group?.is_forum === 1) {
    if (args.message_thread_id === undefined)
      throw new AppError('Forum groups require message_thread_id; use 1 for General.');
    // Defined and validated by the first check.
    return args.message_thread_id as number;
  }
  if (args.message_thread_id !== undefined)
    throw new AppError('Topic routing is supported only for verified forum groups.');
  return null;
}
