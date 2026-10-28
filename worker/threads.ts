import { AppError } from './errors.ts';

export function validThread(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

// Topic of an incoming forum-group message: a named topic ID, or 1 for General.
export function incomingThread(
  message: Record<string, unknown>,
  forum: boolean,
  privateChat = false,
): number | null {
  if (privateChat) {
    if (message.message_thread_id !== undefined && !validThread(message.message_thread_id))
      throw new AppError('Invalid topic ID.');
    if (message.is_topic_message !== undefined && typeof message.is_topic_message !== 'boolean')
      throw new AppError('Invalid topic context.');
    if (message.is_topic_message === true && message.message_thread_id === undefined)
      throw new AppError('Private topic ID is required.');
    // Preserve the wire ID; General normally omits both fields in the Bot API.
    return message.message_thread_id ?? null;
  }
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

// Private topics are explicit and optional; forum groups still require a topic.
export function requestedThread(
  args: Record<string, unknown>,
  group: { is_forum?: unknown } | null | undefined,
  privateChat = false,
): number | null {
  if (args.message_thread_id !== undefined && !validThread(args.message_thread_id))
    throw new AppError('Invalid topic ID.');
  if (privateChat) return args.message_thread_id ?? null;
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

// Private General may be serialized without an ID. Null and 1 select the same
// context there, while stored/event IDs remain unchanged. SQL is fixed here,
// never derived from user input. Group General keeps its existing explicit 1.
export function threadScope(thread: number | null, privateChat: boolean) {
  return {
    column: privateChat ? 'COALESCE(message_thread_id,1)' : 'message_thread_id',
    value: privateChat ? (thread ?? 1) : thread,
  };
}
