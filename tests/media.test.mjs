import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createWorker } from '../worker/index.js';
import {
  environment,
  NOW,
  call,
  rpc,
  subscription,
  challengeResponse,
  update,
  telegramRequest,
  TestDatabase,
  verifySignature,
} from './helpers.mjs';

const CHAT = '-1001234567890';
const file = { file_id: 'synthetic_file', file_unique_id: 'synthetic_unique', file_size: 1234 };
const content = (response) => response.body.result.structuredContent;
function mediaUpdate(id, fields, chat = '10001', thread = null) {
  const value = update(id);
  delete value.message.text;
  Object.assign(value.message, fields);
  if (chat === CHAT) {
    value.message.chat = {
      id: Number(CHAT),
      type: 'supergroup',
      ...(thread !== null ? { is_forum: true } : {}),
    };
    value.message.from.id = 20002;
  }
  if (thread !== null) {
    value.message.message_thread_id = thread;
    value.message.is_topic_message = thread !== 1;
  }
  return value;
}
async function fixture(t, { chat = '10001', forum = false, db = new TestDatabase() } = {}) {
  const env = environment(db);
  t.after(() => db.close());
  if (chat === CHAT) env.TELEGRAM_ALLOWED_GROUPS = JSON.stringify({ [CHAT]: ['10001', '20002'] });
  const state = { time: NOW, events: [], bodies: [], status: 204 };
  const worker = createWorker({
    now: () => state.time,
    fetch: async (url, init) => {
      const args = JSON.parse(init.body),
        method = new URL(url).pathname.split('/').at(-1);
      if (method === 'getChat')
        return Response.json({
          ok: true,
          result: { id: Number(CHAT), type: 'supergroup', ...(forum ? { is_forum: true } : {}) },
        });
      if (method === 'getChatMember') {
        assert.equal(args.user_id, 123456);
        return Response.json({
          ok: true,
          result: { user: { id: 123456, is_bot: true }, status: 'administrator' },
        });
      }
      assert.equal(
        new URL(url).hostname,
        'callbacks.example.com',
        'Intake must not download, send, or call other Telegram APIs',
      );
      if (args.type === 'verification') return challengeResponse(init);
      assert.equal(verifySignature(init), true);
      state.events.push(args);
      state.bodies.push(init.body);
      return new Response(null, { status: state.status });
    },
  });
  if (chat === CHAT)
    assert.equal(
      content(await call(worker, env, 'verify_group_access', { chat_id: chat })).state,
      'active',
    );
  assert.ok(
    (
      await (
        await worker.fetch(
          rpc('events/subscribe', subscription({ arguments: { chat_id: chat } })),
          env,
        )
      ).json()
    ).result.id,
  );
  return { env, worker, state };
}

test('photo caption and safe identifiers persist and reach signed events and private history', async (t) => {
  const { env, worker, state } = await fixture(t);
  const payload = mediaUpdate(1, {
    photo: [
      { ...file, width: 100, height: 80 },
      { ...file, file_id: 'large_photo', width: 800, height: 600 },
    ],
    caption: 'A caption',
    media_group_id: 'album_1',
  });
  assert.equal((await worker.fetch(telegramRequest(payload), env)).status, 200);
  assert.equal(state.events.length, 1);
  const data = state.events[0].data;
  assert.equal(data.text, '[Telegram photo message]\nA caption');
  assert.deepEqual(data.media, {
    type: 'photo',
    caption: 'A caption',
    media_group_id: 'album_1',
    files: [{ kind: 'photo', ...file, file_id: 'large_photo', width: 800, height: 600 }],
  });
  const row = await env.DB.prepare('SELECT media_json,text FROM inbox').first();
  assert.deepEqual(JSON.parse(row.media_json), data.media);
  for (const include_outgoing of [false, true]) {
    const history = content(
      await call(worker, env, 'get_recent_messages', { chat_id: '10001', include_outgoing }),
    ).messages;
    assert.deepEqual(history[0].media, data.media);
    assert.equal(history[0].text, data.text);
    assert.equal(history[0].media_json, undefined);
  }
});

test('file-bearing Telegram types produce notifications without media interpretation', async (t) => {
  const { env, worker, state } = await fixture(t);
  let id = 10;
  const types = ['animation', 'audio', 'document', 'sticker', 'video', 'video_note', 'voice'];
  for (const type of types) {
    const fields = {
      [type]: {
        ...file,
        width: 10,
        height: 20,
        duration: 1.5,
        mime_type: 'video/mp4',
        is_animated: true,
        is_video: false,
      },
    };
    if (type === 'animation') fields.document = { ...file, file_id: 'compat_document' };
    assert.equal((await worker.fetch(telegramRequest(mediaUpdate(id++, fields)), env)).status, 200);
    const data = state.events.at(-1).data;
    assert.equal(data.media.type, type);
    assert.equal(data.media.files[0].kind, type);
    assert.equal(data.media.files[0].file_id, file.file_id);
    assert.equal(data.media.files[0].duration, 1.5);
  }
  assert.equal(state.events.length, types.length);
});

test('live photos and paid media retain only available bounded file metadata', async (t) => {
  const { env, worker, state } = await fixture(t);
  await worker.fetch(
    telegramRequest(
      mediaUpdate(30, {
        live_photo: { ...file, photo: [{ ...file, file_id: 'static_photo' }] },
        photo: [{ ...file, file_id: 'compat_photo' }],
      }),
    ),
    env,
  );
  assert.equal(state.events[0].data.media.type, 'live_photo');
  assert.deepEqual(
    state.events[0].data.media.files.map((f) => f.file_id),
    ['synthetic_file', 'static_photo'],
  );
  await worker.fetch(
    telegramRequest(
      mediaUpdate(31, {
        paid_media: {
          star_count: 10,
          paid_media: [
            { type: 'preview', width: 200 },
            { type: 'photo', photo: [file] },
            { type: 'video', video: file },
            { type: 'live_photo', live_photo: { ...file, photo: [file] } },
          ],
        },
      }),
    ),
    env,
  );
  assert.equal(state.events[1].data.media.type, 'paid_media');
  assert.equal(state.events[1].data.media.files.length, 4);
  assert.equal(JSON.stringify(state.events[1]).includes('star_count'), false);
  await worker.fetch(
    telegramRequest(mediaUpdate(32, { paid_media: { paid_media: [{ type: 'preview' }] } })),
    env,
  );
  assert.deepEqual(state.events[2].data.media, { type: 'paid_media' });
});

test('other ordinary content types notify without disclosing personal payloads', async (t) => {
  const { env, worker, state } = await fixture(t);
  let id = 40;
  for (const type of [
    'contact',
    'location',
    'venue',
    'story',
    'dice',
    'game',
    'poll',
    'checklist',
    'invoice',
    'giveaway',
    'giveaway_winners',
    'rich_message',
  ]) {
    await worker.fetch(
      telegramRequest(
        mediaUpdate(id++, {
          [type]: {
            phone_number: 'PRIVATE_PHONE',
            latitude: 12.345,
            longitude: 67.89,
            vcard: 'PRIVATE_VCARD',
            title: 'PRIVATE_TITLE',
            user: { id: 99999 },
            file_id: 'nested_personal_file',
          },
        }),
      ),
      env,
    );
    assert.deepEqual(state.events.at(-1).data.media, { type });
    assert.equal(state.events.at(-1).data.text, `[Telegram ${type} message]`);
  }
  assert.equal(state.events.length, 12);
  const stored = JSON.stringify((await env.DB.prepare('SELECT * FROM inbox').all()).results);
  for (const value of [
    'PRIVATE_PHONE',
    '12.345',
    '67.89',
    'PRIVATE_VCARD',
    'PRIVATE_TITLE',
    'nested_personal_file',
    '99999',
  ])
    assert.equal(stored.includes(value), false);
});

test('unknown content always produces a generic receipt without inspecting arbitrary payloads', async (t) => {
  const { env, worker, state } = await fixture(t);
  const cases = [
    {
      future_attachment: {
        arbitrary: 'PRIVATE_VALUE',
        asset: { ...file, filename: 'PRIVATE_NAME' },
      },
    },
    { future_media: { private_data: 'PRIVATE_VALUE' } },
    {
      future_card: {
        label: 'PRIVATE_VALUE',
        contact: { phone_number: 'PRIVATE_PHONE' },
        location: { latitude: 12.345 },
      },
    },
    { future_card: { a: { b: { c: { file_id: 'PRIVATE_DEEP_ID', secret: 'PRIVATE_SECRET' } } } } },
    { future_fileless: { opaque: true } },
    { future_service: { file_id: 'PRIVATE_UNKNOWN_SERVICE_ID' } },
    { new_chat_card: { label: 'PRIVATE_VALUE' } },
    { unknown_flag: true },
    {},
    {
      reply_to_message: { photo: [file] },
      external_reply: { document: file },
      forward_origin: { file_id: 'PRIVATE_QUOTED_ID' },
    },
  ];
  for (const fields of cases) {
    await worker.fetch(telegramRequest(mediaUpdate(60 + state.events.length, fields)), env);
    assert.deepEqual(state.events.at(-1).data.media, { type: 'unknown' });
    assert.equal(state.events.at(-1).data.text, '[Telegram unknown content message]');
  }
  assert.equal(state.events.length, cases.length);
  const serialized =
    JSON.stringify(state.events) +
    JSON.stringify((await env.DB.prepare('SELECT * FROM inbox').all()).results);
  for (const value of [
    'PRIVATE_',
    'future_attachment',
    'future_card',
    'future_service',
    'synthetic_file',
    '12.345',
  ])
    assert.equal(serialized.includes(value), false);
  await worker.fetch(
    telegramRequest(
      mediaUpdate(85, {
        caption: 'Unknown caption',
        media_group_id: 'unknown_album',
        future_card: { private: 'PRIVATE_VALUE' },
      }),
    ),
    env,
  );
  assert.deepEqual(state.events.at(-1).data.media, {
    type: 'unknown',
    caption: 'Unknown caption',
    media_group_id: 'unknown_album',
  });
  assert.equal(
    state.events.at(-1).data.text,
    '[Telegram unknown content message]\nUnknown caption',
  );
});

test('explicit known services and non-message update roots never become media events', async (t) => {
  const { env, worker, state } = await fixture(t);
  let id = 70;
  const serviceFields = [
    'new_chat_photo',
    'pinned_message',
    'forum_topic_created',
    'video_chat_started',
    'successful_payment',
    'users_shared',
    'web_app_data',
    'giveaway_created',
    'community_chat_joined',
    'gift_upgrade_sent',
    'chat_owner_left',
    'chat_owner_changed',
  ];
  for (const key of serviceFields)
    await worker.fetch(
      telegramRequest(
        mediaUpdate(id++, { [key]: { ...file }, caption: 'Do not deliver lifecycle events' }),
      ),
      env,
    );
  const photo = mediaUpdate(id++, { photo: [file] });
  for (const key of [
    'edited_message',
    'channel_post',
    'edited_channel_post',
    'business_message',
    'guest_message',
  ])
    await worker.fetch(telegramRequest({ update_id: id++, [key]: photo.message }), env);
  await worker.fetch(
    telegramRequest({ update_id: id++, poll_answer: { poll_id: 'synthetic' } }),
    env,
  );
  assert.equal(state.events.length, 0);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM inbox').first()).n, 0);
});

for (const [chat, forum] of [
  ['10001', false],
  [CHAT, false],
  [CHAT, true],
])
  test(`generic unknown receipts preserve duplicate and history boundaries: ${chat === '10001' ? 'private' : forum ? 'forum' : 'group'}`, async (t) => {
    const { env, worker, state } = await fixture(t, { chat, forum });
    const thread = forum ? 70 : null;
    const value = mediaUpdate(
      650,
      { future_card: { a: { b: { c: { file_id: 'PRIVATE_DEEP_ID' } } } } },
      chat,
      thread,
    );
    state.status = 503;
    assert.equal((await worker.fetch(telegramRequest(value), env)).status, 503);
    value.message.future_card = { changed: 'PRIVATE_CHANGED' };
    state.time += 10000;
    state.status = 204;
    assert.equal((await worker.fetch(telegramRequest(value), env)).status, 200);
    await worker.fetch(telegramRequest(value), env);
    assert.equal(state.events.length, 2);
    assert.equal(state.bodies[0], state.bodies[1]);
    assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM inbox').first()).n, 1);
    const args = { chat_id: chat, ...(forum ? { message_thread_id: thread } : {}) };
    for (const include_outgoing of [false, true]) {
      const messages = content(
        await call(worker, env, 'get_recent_messages', { ...args, include_outgoing }),
      ).messages;
      assert.equal(messages.length, 1);
      assert.deepEqual(messages[0].media, { type: 'unknown' });
      assert.equal(messages[0].text, '[Telegram unknown content message]');
      if (forum) assert.equal(messages[0].message_thread_id, 70);
    }
    if (forum)
      assert.deepEqual(
        content(
          await call(worker, env, 'get_recent_messages', { chat_id: chat, message_thread_id: 80 }),
        ).messages,
        [],
      );
    const bad = mediaUpdate(651, { future_card: {} }, chat, thread);
    bad.message.from.id = 30003;
    await worker.fetch(telegramRequest(bad), env);
    assert.equal(state.events.length, 2);
    assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM inbox').first()).n, 1);
    if (chat === CHAT)
      assert.equal(
        (await env.DB.prepare('SELECT state FROM group_access').first()).state,
        'active',
      );
  });

test('gift-upgrade lifecycle attachments never wake the dot even without captions', async (t) => {
  const { env, worker, state } = await fixture(t);
  await worker.fetch(
    telegramRequest(mediaUpdate(90, { gift_upgrade_sent: { gift: { sticker: file } } })),
    env,
  );
  assert.equal(state.events.length, 0);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM inbox').first()).n, 0);
});

test('text-bearing messages preserve the original text-only event and history shape', async (t) => {
  const { env, worker, state } = await fixture(t);
  const value = update(91, 'Original text');
  value.message.future_attachment = file;
  value.message.rich_message = { blocks: [] };
  await worker.fetch(telegramRequest(value), env);
  assert.equal(state.events[0].data.text, 'Original text');
  assert.equal(Object.hasOwn(state.events[0].data, 'media'), false);
  const message = content(await call(worker, env, 'get_recent_messages', { chat_id: '10001' }))
    .messages[0];
  assert.equal(Object.hasOwn(message, 'media'), false);
  assert.equal(Object.hasOwn(message, 'media_json'), false);
});

test('opaque media identifiers and MIME types reject trailing newlines as invalid optional metadata', async (t) => {
  const { env, worker, state } = await fixture(t);
  await worker.fetch(
    telegramRequest(
      mediaUpdate(92, {
        document: { file_id: 'bad\n', file_unique_id: 'valid_unique', mime_type: 'text/plain\n' },
        media_group_id: 'bad_album\n',
      }),
    ),
    env,
  );
  assert.deepEqual(state.events[0].data.media, {
    type: 'document',
    files: [{ kind: 'document', file_unique_id: 'valid_unique' }],
  });
});

test('albums remain individual idempotent messages; retries freeze original media and caption', async (t) => {
  const { env, worker, state } = await fixture(t);
  state.status = 503;
  const payload = mediaUpdate(100, {
    photo: [file],
    caption: 'Original',
    media_group_id: 'same_album',
  });
  assert.equal((await worker.fetch(telegramRequest(payload), env)).status, 503);
  payload.message.caption = 'Changed duplicate';
  payload.message.photo[0].file_id = 'changed_file';
  state.time += 10000;
  state.status = 204;
  assert.equal((await worker.fetch(telegramRequest(payload), env)).status, 200);
  assert.equal(state.bodies[0], state.bodies[1]);
  await worker.fetch(telegramRequest(payload), env);
  assert.equal(state.events.length, 2);
  await worker.fetch(
    telegramRequest(mediaUpdate(101, { video: file, media_group_id: 'same_album' })),
    env,
  );
  assert.equal(state.events.length, 3);
  assert.notEqual(state.events[1].eventId, state.events[2].eventId);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM inbox').first()).n, 2);
});

test('media metadata is bounded and sensitive descriptive fields are omitted', async (t) => {
  const { env, worker, state } = await fixture(t);
  const caption = '😀'.repeat(1100);
  await worker.fetch(
    telegramRequest(
      mediaUpdate(110, {
        document: {
          file_id: 'x'.repeat(513),
          file_unique_id: 'safe_unique',
          file_size: -1,
          width: Infinity,
          duration: -2,
          mime_type: 'text/plain\nPRIVATE',
          file_name: 'PRIVATE_NAME',
          thumbnail: { ...file },
        },
        caption,
        caption_entities: [{ url: 'PRIVATE_URL' }],
        media_group_id: 'x'.repeat(513),
      }),
    ),
    env,
  );
  const media = state.events[0].data.media;
  assert.equal([...media.caption].length, 1024);
  assert.equal(media.caption_truncated, true);
  assert.deepEqual(media.files, [{ kind: 'document', file_unique_id: 'safe_unique' }]);
  assert.equal(media.media_group_id, undefined);
  assert.equal(JSON.stringify(state.events).includes('PRIVATE'), false);
  await worker.fetch(
    telegramRequest(
      mediaUpdate(111, {
        paid_media: {
          paid_media: Array.from({ length: 20 }, (_, n) => ({
            type: 'video',
            video: { ...file, file_id: `file_${n}` },
          })),
        },
      }),
    ),
    env,
  );
  assert.equal(state.events[1].data.media.files.length, 10);
  assert.equal(state.events[1].data.media.files_truncated, true);
});

for (const forum of [false, true])
  test(`approved group media keeps sender, ${forum ? 'topic' : 'chat'} history and access safeguards`, async (t) => {
    const { env, worker, state } = await fixture(t, { chat: CHAT, forum });
    const thread = forum ? 70 : null;
    await worker.fetch(telegramRequest(mediaUpdate(120, { sticker: file }, CHAT, thread)), env);
    if (forum)
      for (const next of [80, 1])
        await worker.fetch(
          telegramRequest(mediaUpdate(120 + next, { photo: [file] }, CHAT, next)),
          env,
        );
    const historyArgs = { chat_id: CHAT, ...(forum ? { message_thread_id: 70 } : {}) };
    for (const include_outgoing of [false, true]) {
      const messages = content(
        await call(worker, env, 'get_recent_messages', { ...historyArgs, include_outgoing }),
      ).messages;
      assert.equal(messages.length, 1);
      assert.equal(messages[0].media.type, 'sticker');
      assert.equal(messages[0].sender_id, '20002');
      if (forum) assert.equal(messages[0].message_thread_id, 70);
    }
    const before = state.events.length;
    for (const change of [
      (m) => (m.from.id = 30003),
      (m) => (m.from.is_bot = true),
      (m) => (m.sender_chat = { id: Number(CHAT) }),
    ]) {
      const bad = mediaUpdate(300 + state.events.length, { photo: [file] }, CHAT, thread);
      change(bad.message);
      await worker.fetch(telegramRequest(bad), env);
    }
    assert.equal(state.events.length, before);
    assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM inbox').first()).n, before);
    assert.equal((await env.DB.prepare('SELECT state FROM group_access').first()).state, 'active');
    await call(worker, env, 'pause_group_access', { chat_id: CHAT });
    await worker.fetch(telegramRequest(mediaUpdate(400, { photo: [file] }, CHAT, thread)), env);
    assert.equal(state.events.length, before);
  });

test('private media still requires secret, owner, matching sender and both allowlists', async (t) => {
  const { env, worker, state } = await fixture(t);
  let id = 500;
  const photo = () => mediaUpdate(id++, { photo: [file] });
  assert.equal((await worker.fetch(telegramRequest(photo(), 'invalid'), env)).status, 401);
  for (const change of [
    (m) => (m.from.id = 20002),
    (m) => (m.from.is_bot = true),
    (m) => (m.sender_chat = { id: 10001 }),
    (m) => (m.chat.id = 20002),
    (m) => (m.is_topic_message = true),
  ]) {
    const bad = photo();
    change(bad.message);
    await worker.fetch(telegramRequest(bad), env);
  }
  assert.equal(state.events.length, 0);
  await worker.fetch(telegramRequest(photo()), env);
  assert.equal(state.events.length, 1);
  const unauthorized = await worker.fetch(
    rpc(
      'tools/call',
      { name: 'get_recent_messages', arguments: { chat_id: '10001' } },
      'not-owner',
    ),
    env,
  );
  assert.equal(unauthorized.status, 403);
  env.TELEGRAM_ALLOWED_USER_IDS = '20002';
  await worker.fetch(telegramRequest(photo()), env);
  assert.equal(state.events.length, 1);
  assert.ok((await call(worker, env, 'get_recent_messages', { chat_id: '10001' })).body.error);
});

test('media expires with the inbox and text rows survive the additive migration unchanged', async (t) => {
  const db = new TestDatabase(4);
  db.sqlite.exec(
    `INSERT INTO inbox(event_id,bot_id,update_id,chat_id,sender_id,message_id,text,occurred_at,received_at) VALUES ('legacy','123456',1,'10001','10001',11,'Legacy text','2026-10-23T12:00:00.000Z',${NOW})`,
  );
  const journal = JSON.parse(
    readFileSync(new URL('../drizzle/meta/_journal.json', import.meta.url), 'utf8'),
  );
  for (const entry of journal.entries.slice(4))
    db.sqlite.exec(readFileSync(new URL(`../drizzle/${entry.tag}.sql`, import.meta.url), 'utf8'));
  const { env, worker, state } = await fixture(t, { db });
  await worker.fetch(telegramRequest(mediaUpdate(600, { voice: file })), env);
  const messages = content(
    await call(worker, env, 'get_recent_messages', { chat_id: '10001' }),
  ).messages;
  assert.equal(messages[0].media.type, 'voice');
  assert.equal(messages[1].text, 'Legacy text');
  assert.equal(Object.hasOwn(messages[1], 'media'), false);
  state.time += 7 * 86400000 + 1;
  assert.deepEqual(
    content(
      await call(worker, env, 'get_recent_messages', { chat_id: '10001', include_outgoing: true }),
    ).messages,
    [],
  );
  await call(worker, env, 'retry_pending_events', {});
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM inbox').first()).n, 0);
});
