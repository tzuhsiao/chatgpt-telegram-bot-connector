import { requireChat, senderAllowed } from './access.ts';
import { DAY } from './constants.ts';
import { digest } from './crypto.ts';
import { first, requireDatabase, rows, run } from './db.ts';
import type { Env, Runtime } from './env.ts';
import { AppError } from './errors.ts';
import { checkGroup, groupCurrent } from './groups.ts';
import { MAX_BODY, readJson } from './http.ts';
import { imageType } from './image.ts';
import { mediaId } from './intake.ts';
import { botId } from './telegram.ts';
import { requestedThread, validThread } from './threads.ts';
import { toolResult } from './tool-result.ts';
import type { UntypedJson } from './untyped.ts';
import { groupId, objectArgs } from './validate.ts';

// Media retrieval: bounded download of retained, authorized Telegram files,
// static-image validation (image.ts) and a short-lived private D1 byte cache.
// Only validated static images become model-readable content; the bot token
// never appears in errors, and every read re-checks the retained message's
// current authorization.

// Hybrid retrieval: no file URLs, bytes or download outcomes enter event payloads.
export const AUTO_MEDIA_BYTES = 2_000_000,
  MAX_MEDIA_BYTES = 8_000_000;

export const MEDIA_CACHE_BYTES = 32_000_000,
  MEDIA_CACHE_ENTRIES = 32;

export const MEDIA_TTL = 600_000,
  MEDIA_LEASE = 30_000,
  MEDIA_TIMEOUT = 12_000,
  MEDIA_CHUNK = 524286;

export function autoMedia(media: UntypedJson, file: UntypedJson) {
  return (
    !!file?.file_id &&
    Number.isSafeInteger(file.file_size) &&
    file.file_size >= 0 &&
    file.file_size <= AUTO_MEDIA_BYTES &&
    ((media.type === 'photo' && file.kind === 'photo') ||
      (media.type === 'sticker' &&
        file.kind === 'sticker' &&
        file.is_animated === false &&
        file.is_video === false))
  );
}

// `args` are MCP tool arguments, shape-checked by objectArgs before use.
export async function mediaContext(
  args: UntypedJson,
  env: Env,
  runtime: Runtime,
  ingressGroup?: UntypedJson,
) {
  objectArgs(
    args,
    ['chat_id', 'message_id', 'update_id', 'message_thread_id', 'file_index', 'mode'],
    ['chat_id', 'message_id', 'update_id'],
  );
  const chat = requireChat(args.chat_id, env),
    index = args.file_index ?? 0,
    mode = args.mode ?? 'on_demand';
  if (
    !validThread(args.message_id) ||
    !Number.isSafeInteger(args.update_id) ||
    args.update_id < 0 ||
    !Number.isInteger(index) ||
    index < 0 ||
    index > 9 ||
    !['auto', 'on_demand'].includes(mode)
  )
    throw new AppError('Invalid media context.');
  const group = groupId(chat) ? (ingressGroup ?? (await checkGroup(chat, env, runtime))) : null;
  const thread = requestedThread(args, group),
    db = requireDatabase(env);
  const record: UntypedJson = await first(
    db,
    'SELECT * FROM inbox WHERE bot_id=? AND chat_id=? AND message_id=? AND update_id=? AND message_thread_id IS ?',
    botId(env),
    chat,
    args.message_id,
    args.update_id,
    thread,
  );
  const context = { record, group, thread, index, mode };
  await assertMediaContext(context, env, runtime);
  let media;
  try {
    media = JSON.parse(record.media_json);
  } catch {
    throw new AppError('Retained media is unavailable.');
  }
  const file = media?.files?.[index];
  if (!file?.file_id || !mediaId(file.file_id)) throw new AppError('Retained file is unavailable.');
  return { ...context, media, file };
}

export async function assertMediaContext(context: UntypedJson, env: Env, runtime: Runtime) {
  const record = context.record;
  if (
    !record ||
    record.bot_id !== botId(env) ||
    record.received_at < runtime.now() - 7 * DAY ||
    !senderAllowed(record.chat_id, record.sender_id, env) ||
    ['access_revoked', 'group_access_revoked'].includes(record.last_error)
  )
    throw new AppError('Retained media access is unavailable.', 403, -32001);
  requireChat(record.chat_id, env);
  const current = await first(
    requireDatabase(env),
    'SELECT event_id FROM inbox WHERE event_id=? AND bot_id=? AND chat_id=? AND sender_id=? AND message_thread_id IS ? AND group_revision IS ? AND received_at>=? AND media_json IS ? AND (last_error IS NULL OR last_error NOT IN (?,?))',
    record.event_id,
    record.bot_id,
    record.chat_id,
    record.sender_id,
    context.thread,
    record.group_revision,
    runtime.now() - 7 * DAY,
    record.media_json,
    'access_revoked',
    'group_access_revoked',
  );
  if (!current) throw new AppError('Retained media access is unavailable.', 403, -32001);
  if (context.group) {
    if (record.group_revision !== context.group.revision)
      throw new AppError('Retained media epoch is unavailable.', 403, -32001);
    await groupCurrent(context.group, env);
  }
}

export function base64Bytes(bytes: Uint8Array): string {
  let value = '';
  for (let offset = 0; offset < bytes.length; offset += 8192)
    value += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(value);
}

export async function downloadMedia(
  file: UntypedJson,
  limit: number,
  env: Env,
  runtime: Runtime,
  deadline: number,
): Promise<Uint8Array> {
  const controller = new AbortController(),
    timer = setTimeout(
      () => controller.abort(),
      Math.max(1, Math.min(MEDIA_TIMEOUT, deadline - Date.now())),
    );
  let reader;
  try {
    const checked = <T>(promise: Promise<T>): Promise<T> => {
      // Assigned synchronously by the Promise executor below.
      let aborted!: () => void;
      const timeout = new Promise<never>((_, reject) => {
        aborted = () => reject(new Error('Download deadline.'));
        if (controller.signal.aborted) aborted();
        else controller.signal.addEventListener('abort', aborted, { once: true });
      });
      return Promise.race([promise, timeout]).finally(() =>
        controller.signal.removeEventListener('abort', aborted),
      );
    };
    const response = await checked(
      runtime.fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getFile`, {
        method: 'POST',
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ file_id: file.file_id }),
      }),
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('File resolution failed.');
    }
    // Untrusted getFile envelope: every field read below is checked first.
    const info: UntypedJson = await checked(readJson(response, MAX_BODY)).catch(() => {
      throw new Error('File resolution unavailable.');
    });
    const value = info?.result,
      path = value?.file_path;
    if (
      info?.ok !== true ||
      info.error_code !== undefined ||
      value?.file_id !== file.file_id ||
      (file.file_unique_id && value.file_unique_id !== file.file_unique_id) ||
      (value?.file_size !== undefined &&
        (!Number.isSafeInteger(value.file_size) ||
          value.file_size < 0 ||
          value.file_size > limit)) ||
      typeof path !== 'string' ||
      path.length > 512 ||
      !/^([A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(path)
    )
      throw new Error('Invalid file resolution.');
    const download = await checked(
      runtime.fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${path}`, {
        redirect: 'manual',
        signal: controller.signal,
      }),
    );
    if (!download.ok) {
      await download.body?.cancel();
      throw new Error('Download failed.');
    }
    const length = download.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) {
      await download.body?.cancel();
      throw new Error('Download too large.');
    }
    reader = download.body?.getReader();
    if (!reader) throw new Error('Empty download.');
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value: chunk } = await checked(reader.read());
      if (done) break;
      size += chunk.byteLength;
      if (size > limit) throw new Error('Download too large.');
      chunks.push(chunk);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return bytes;
  } finally {
    clearTimeout(timer);
    controller.abort();
    if (reader) void reader.cancel().catch(() => {});
  }
}

export async function cachedMedia(
  context: UntypedJson,
  limit: number,
  env: Env,
  runtime: Runtime,
  {
    warm = false,
    deadline = Date.now() + 14000,
    retry = 0,
  }: { warm?: boolean; deadline?: number; retry?: number } = {},
): Promise<UntypedJson> {
  const { record, file } = context,
    db = requireDatabase(env),
    now = runtime.now();
  const key = await digest(
    JSON.stringify([
      env.OWNER_USER_ID,
      record.bot_id,
      record.chat_id,
      record.sender_id,
      context.thread,
      record.group_revision,
      file.file_id,
      file.file_unique_id ?? null,
    ]),
  );
  await run(db, 'DELETE FROM media_cache WHERE expires_at<=?', now);
  let cached: UntypedJson = await first(db, 'SELECT * FROM media_cache WHERE cache_key=?', key);
  // Wait inside the tool, not in the responder task. The deadline and finite
  // backoff bound both wall time and D1 reads; no second network download occurs.
  if (cached?.state === 'downloading') {
    for (const delay of [100, 400, 1000, 2000, 3000, 3500, 4000]) {
      if (cached.expires_at <= runtime.now()) {
        await run(
          db,
          'DELETE FROM media_cache WHERE cache_key=? AND lease_token=? AND expires_at<=?',
          key,
          cached.lease_token,
          runtime.now(),
        );
        cached = null;
        break;
      }
      if (Date.now() + delay > deadline) break;
      await new Promise((resolve) => setTimeout(resolve, delay));
      cached = await first(db, 'SELECT * FROM media_cache WHERE cache_key=?', key);
      if (!cached || cached.state !== 'downloading') break;
    }
  }
  // A failed automatic attempt must not prevent an explicitly authorized larger read.
  if (cached?.state === 'failed' && cached.fetch_limit < limit) {
    await run(
      db,
      "DELETE FROM media_cache WHERE cache_key=? AND lease_token=? AND state='failed'",
      key,
      cached.lease_token,
    );
    cached = null;
  }
  if (!cached) {
    const lease = crypto.randomUUID();
    const claim = () =>
      first(
        db,
        `INSERT INTO media_cache(cache_key,bot_id,chat_id,lease_token,state,allocated_bytes,fetch_limit,expires_at)
      SELECT ?,?,?,?,'downloading',?,?,? WHERE (SELECT COUNT(*) FROM media_cache)<? AND (SELECT COALESCE(SUM(allocated_bytes),0) FROM media_cache)+?<=?
      ON CONFLICT(cache_key) DO NOTHING RETURNING *`,
        key,
        record.bot_id,
        record.chat_id,
        lease,
        limit,
        limit,
        runtime.now() + MEDIA_LEASE,
        MEDIA_CACHE_ENTRIES,
        limit,
        MEDIA_CACHE_BYTES,
      );
    cached = await claim();
    if (!cached) {
      const existing = await first(db, 'SELECT * FROM media_cache WHERE cache_key=?', key);
      if (existing)
        return retry < 1
          ? cachedMedia(context, limit, env, runtime, { warm, deadline, retry: retry + 1 })
          : { state: 'in_progress' };
      // Evict only completed entries. Active leases keep their reservations.
      await run(
        db,
        "DELETE FROM media_cache WHERE cache_key=(SELECT cache_key FROM media_cache WHERE state='ready' ORDER BY expires_at,cache_key LIMIT 1)",
      );
      cached = await claim();
      if (!cached) return { state: 'cache_full' };
    }
    try {
      const bytes = await downloadMedia(file, limit, env, runtime, deadline);
      await assertMediaContext(context, env, runtime);
      const mime = imageType(bytes),
        statements = [];
      for (let offset = 0, index = 0; mime && offset < bytes.length; offset += MEDIA_CHUNK, index++)
        statements.push(
          db
            .prepare(
              `INSERT INTO media_chunks(cache_key,lease_token,chunk_index,data)
        SELECT ?,?,?,? WHERE EXISTS (SELECT 1 FROM media_cache WHERE cache_key=? AND lease_token=? AND state='downloading' AND expires_at>?)`,
            )
            .bind(
              key,
              lease,
              index,
              base64Bytes(bytes.subarray(offset, offset + MEDIA_CHUNK)),
              key,
              lease,
              runtime.now(),
            ),
        );
      statements.push(
        db
          .prepare(
            "UPDATE media_cache SET state='ready',allocated_bytes=?,byte_length=?,mime_type=?,expires_at=? WHERE cache_key=? AND lease_token=? AND state='downloading' AND expires_at>?",
          )
          .bind(
            mime ? bytes.length : 0,
            bytes.length,
            mime,
            now + MEDIA_TTL,
            key,
            lease,
            runtime.now(),
          ),
      );
      const saved = await db.batch(statements);
      // D1 batch returns one result per statement.
      if (!saved.at(-1)!.meta?.changes) return { state: 'unavailable' };
      cached = {
        ...cached,
        state: 'ready',
        byte_length: bytes.length,
        mime_type: mime,
        expires_at: now + MEDIA_TTL,
      };
    } catch (error) {
      await db.batch([
        db.prepare('DELETE FROM media_chunks WHERE cache_key=? AND lease_token=?').bind(key, lease),
        db
          .prepare(
            "UPDATE media_cache SET state='failed',allocated_bytes=0,expires_at=? WHERE cache_key=? AND lease_token=?",
          )
          .bind(runtime.now() + 60000, key, lease),
      ]);
      if (error instanceof AppError) throw error;
      return { state: 'unavailable' };
    }
  }
  if (cached.state === 'downloading') return { state: 'in_progress' };
  if (cached.state === 'failed' || cached.byte_length > limit) return { state: 'unavailable' };
  if (!cached.mime_type)
    return {
      state: 'unsupported',
      reason: 'unsupported_model_transport_or_image',
      byte_length: cached.byte_length,
    };
  if (warm) return { state: 'ready' };
  const chunks = await rows(
    db,
    'SELECT chunk_index,data FROM media_chunks WHERE cache_key=? AND lease_token=? ORDER BY chunk_index',
    key,
    cached.lease_token,
  );
  const valid =
    chunks.length === Math.ceil(cached.byte_length / MEDIA_CHUNK) &&
    chunks.every((chunk, index) => {
      const length = Math.min(MEDIA_CHUNK, cached.byte_length - index * MEDIA_CHUNK);
      return (
        chunk.chunk_index === index &&
        typeof chunk.data === 'string' &&
        chunk.data.length === 4 * Math.ceil(length / 3) &&
        /^[A-Za-z0-9+/]*={0,2}$/.test(chunk.data) &&
        (index === chunks.length - 1 || !chunk.data.includes('='))
      );
    });
  if (!valid) {
    await run(
      db,
      'DELETE FROM media_cache WHERE cache_key=? AND lease_token=?',
      key,
      cached.lease_token,
    );
    return { state: 'unavailable' };
  }
  if (
    !(await first(
      db,
      "SELECT cache_key FROM media_cache WHERE cache_key=? AND lease_token=? AND state='ready' AND expires_at>?",
      key,
      cached.lease_token,
      runtime.now(),
    ))
  )
    return { state: 'unavailable' };
  return {
    state: 'ready',
    mime_type: cached.mime_type,
    byte_length: cached.byte_length,
    expires_at: new Date(cached.expires_at).toISOString(),
    image: chunks.map((chunk) => chunk.data).join(''),
  };
}

// `args` are MCP tool arguments, shape-checked by objectArgs before use.
export async function messageMedia(
  args: UntypedJson,
  env: Env,
  runtime: Runtime,
  ingressGroup?: UntypedJson,
) {
  const context = await mediaContext(args, env, runtime, ingressGroup);
  let result;
  if (context.mode === 'auto' && !autoMedia(context.media, context.file))
    result = { state: 'on_demand_required' };
  else if (context.mode === 'on_demand' && context.file.file_size > MAX_MEDIA_BYTES)
    result = { state: 'unavailable', reason: 'file_too_large' };
  else
    result = await cachedMedia(
      context,
      context.mode === 'auto' ? AUTO_MEDIA_BYTES : MAX_MEDIA_BYTES,
      env,
      runtime,
    );
  await assertMediaContext(context, env, runtime);
  if (result.state === 'ready' && Date.parse(result.expires_at) <= runtime.now())
    result = { state: 'unavailable' };
  const { image, ...metadata } = result,
    output = toolResult(metadata);
  if (image) output.content.push({ type: 'image', mimeType: result.mime_type, data: image });
  output.isError = ['unavailable', 'cache_full', 'in_progress', 'unsupported'].includes(
    result.state,
  );
  return output;
}

export async function prefetchMedia(
  eventId: string,
  env: Env,
  runtime: Runtime,
  group: UntypedJson,
): Promise<void> {
  const record: UntypedJson = await first(
    requireDatabase(env),
    'SELECT * FROM inbox WHERE event_id=?',
    eventId,
  );
  if (!record?.media_json) return;
  const media = JSON.parse(record.media_json);
  for (const [index, file] of (media.files ?? []).entries())
    if (autoMedia(media, file)) {
      const context = await mediaContext(
        {
          chat_id: record.chat_id,
          message_id: record.message_id,
          update_id: record.update_id,
          ...(record.message_thread_id !== null
            ? { message_thread_id: record.message_thread_id }
            : {}),
          file_index: index,
          mode: 'auto',
        },
        env,
        runtime,
        group,
      );
      await cachedMedia(context, AUTO_MEDIA_BYTES, env, runtime, { warm: true });
    }
}
