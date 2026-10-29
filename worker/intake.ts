import { senderAllowed } from './access.ts';
import { DAY } from './constants.ts';
import type { Env } from './env.ts';
import { AppError } from './errors.ts';
import { MEDIA_TYPES } from './schemas.ts';
import { botId } from './telegram.ts';
import { incomingThread } from './threads.ts';
import type { UntypedJson } from './untyped.ts';
import { groupId, numericId, senderUsername } from './validate.ts';

// Intake: turn one raw Telegram update into a bounded, allowlisted inbox record.
// Only allowlisted human senders in approved chats pass; message text, captions
// and media metadata stay untrusted content. Raw update fields are walked with
// runtime checks (see UntypedJson).

// Message has no content/service discriminator. Keep known lifecycle fields out
// of intake even when they carry file IDs (e.g. new_chat_photo) or a caption.
export const SERVICE_FIELDS = new Set(
  'new_chat_members left_chat_member chat_owner_left chat_owner_changed new_chat_title new_chat_photo delete_chat_photo group_chat_created supergroup_chat_created channel_chat_created message_auto_delete_timer_changed migrate_to_chat_id migrate_from_chat_id pinned_message successful_payment refunded_payment users_shared chat_shared gift unique_gift gift_upgrade_sent connected_website write_access_allowed passport_data proximity_alert_triggered boost_added chat_background_set checklist_tasks_done checklist_tasks_added community_chat_added community_chat_joined community_chat_removed direct_message_price_changed forum_topic_created forum_topic_edited forum_topic_closed forum_topic_reopened general_forum_topic_hidden general_forum_topic_unhidden giveaway_created giveaway_completed managed_bot_created paid_message_price_changed poll_option_added poll_option_deleted suggested_post_approved suggested_post_approval_failed suggested_post_declined suggested_post_paid suggested_post_refunded video_chat_scheduled video_chat_started video_chat_ended video_chat_participants_invited web_app_data'.split(
    ' ',
  ),
);

export function serviceMessage(message: UntypedJson): boolean {
  return Object.keys(message).some((key) => SERVICE_FIELDS.has(key));
}

export function mediaId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,512}$/.test(value);
}

export function mediaFile(value: UntypedJson, kind: string): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const result: Record<string, unknown> = { kind };
  for (const key of ['file_id', 'file_unique_id'])
    if (mediaId(value[key])) result[key] = value[key];
  if (!result.file_id && !result.file_unique_id) return null;
  for (const key of ['width', 'height', 'length', 'file_size'])
    if (Number.isSafeInteger(value[key]) && value[key] >= 0) result[key] = value[key];
  if (
    Number.isFinite(value.duration) &&
    value.duration >= 0 &&
    value.duration <= Number.MAX_SAFE_INTEGER
  )
    result.duration = value.duration;
  if (
    typeof value.mime_type === 'string' &&
    value.mime_type.length <= 128 &&
    /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(value.mime_type)
  )
    result.mime_type = value.mime_type;
  for (const key of ['is_animated', 'is_video'])
    if (typeof value[key] === 'boolean') result[key] = value[key];
  return result;
}

// Bounded, allowlisted media metadata carried in events and stored with the inbox row.
export interface NormalizedMedia {
  type: string;
  caption?: string;
  caption_truncated?: boolean;
  media_group_id?: string;
  files?: Record<string, unknown>[];
  files_truncated?: boolean;
}

export function normalizedMedia(message: UntypedJson): NormalizedMedia {
  // Precedence keeps Telegram's compatibility document/photo fields from
  // replacing the actual animation/live-photo type. No arbitrary values copied.
  const type =
    MEDIA_TYPES.find((key) => key !== 'unknown' && message[key] !== undefined) ?? 'unknown';
  const files: Record<string, unknown>[] = [];
  let truncated = false;
  const add = (value: UntypedJson, kind: string) => {
    const item = mediaFile(value, kind);
    if (item) {
      if (files.length < 10) files.push(item);
      else truncated = true;
    }
  };
  const photo = (value: UntypedJson) => {
    if (Array.isArray(value) && value.length) add(value.at(-1), 'photo');
  };
  const live = (value: UntypedJson) => {
    add(value, 'live_photo');
    photo(value?.photo);
  };
  if (type === 'photo') photo(message.photo);
  else if (type === 'live_photo') live(message.live_photo);
  else if (type === 'paid_media') {
    const items = message.paid_media?.paid_media;
    if (Array.isArray(items)) {
      if (items.length > 20) truncated = true;
      for (const item of items.slice(0, 20)) {
        if (item?.type === 'photo') photo(item.photo);
        else if (item?.type === 'video') add(item.video, 'video');
        else if (item?.type === 'live_photo') live(item.live_photo);
      }
    }
  } else if (
    ['animation', 'audio', 'document', 'sticker', 'video', 'video_note', 'voice'].includes(type)
  )
    add(message[type], type);
  // Every structurally valid, authorized non-text message gets a receipt.
  // Unknown content is opaque: never traverse arbitrary, quoted or forwarded
  // payloads to decide acceptance or extract file IDs and personal information.
  const media: NormalizedMedia = { type };
  if (typeof message.caption === 'string') {
    const points = [...message.caption];
    media.caption = points.slice(0, 1024).join('');
    if (points.length > 1024) media.caption_truncated = true;
  }
  if (mediaId(message.media_group_id)) media.media_group_id = message.media_group_id;
  if (files.length) media.files = files;
  if (truncated) media.files_truncated = true;
  return media;
}

export function inputRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

// Shared envelope checks also gate private topic lifecycle observations. Service
// metadata never enters conversational intake or grants sender/chat authority.
export function authorizedMessage(raw: unknown, env: Env, now: number) {
  const update = inputRecord(raw);
  if (
    !update ||
    typeof update.update_id !== 'number' ||
    !Number.isSafeInteger(update.update_id) ||
    update.update_id < 0
  )
    throw new AppError('Invalid Telegram update.');
  const message = inputRecord(update.message);
  if (!message) return null;
  const chatInfo = inputRecord(message.chat),
    from = inputRecord(message.from);
  if (
    !chatInfo ||
    typeof chatInfo.type !== 'string' ||
    !['private', 'group', 'supergroup'].includes(chatInfo.type) ||
    !from ||
    from.is_bot !== false ||
    message.sender_chat
  )
    return null;
  const chat = String(chatInfo.id),
    sender = String(from.id);
  if (
    !Number.isSafeInteger(chatInfo.id) ||
    !Number.isSafeInteger(from.id) ||
    (!numericId(chat) && !groupId(chat)) ||
    !numericId(sender)
  )
    return null;
  if ((chatInfo.type === 'private') !== numericId(chat) || !senderAllowed(chat, sender, env))
    return null;
  if (
    typeof message.message_id !== 'number' ||
    !Number.isSafeInteger(message.message_id) ||
    message.message_id <= 0 ||
    typeof message.date !== 'number' ||
    !Number.isSafeInteger(message.date) ||
    message.date <= 0 ||
    message.date * 1000 > now + 300000
  )
    return null;
  if (message.date * 1000 < now - 7 * DAY) return null;
  return { update, message, chatInfo, chat, sender, from };
}

export function normalizedUpdate(raw: unknown, env: Env, now: number) {
  const envelope = authorizedMessage(raw, env, now);
  if (!envelope || serviceMessage(envelope.message)) return null;
  const { update, message, chatInfo, chat, sender, from } = envelope;
  let media: NormalizedMedia | null = null;
  let text: string;
  if (typeof message.text === 'string') {
    if (!message.text.length || [...message.text].length > 4096) return null;
    text = message.text;
  } else {
    media = normalizedMedia(message);
    text = `[Telegram ${media.type === 'unknown' ? 'unknown content' : media.type} message]${media.caption ? '\n' + media.caption : ''}`;
  }
  return {
    bot_id: botId(env),
    update_id: update.update_id,
    chat_id: chat,
    sender_id: sender,
    sender_username: senderUsername(from.username),
    message_id: message.message_id,
    message_thread_id: chatInfo.type === 'private' ? incomingThread(message, false, true) : null,
    reaction_album: Object.hasOwn(message, 'media_group_id') ? 1 : 0,
    text,
    media_json: media ? JSON.stringify(media) : null,
    occurred_at: new Date((message.date as number) * 1000).toISOString(),
    received_at: now,
  };
}
