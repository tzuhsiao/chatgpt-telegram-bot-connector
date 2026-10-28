import test from 'node:test';
import assert from 'node:assert/strict';
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
} from './helpers.mjs';

const CHAT = '-1001234567890';
// Real 1x1 PNG; no image interpreter/transcoder runs in the connector.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9woAAAAASUVORK5CYII=',
  'base64',
);
const data = (response) => response.body.result?.structuredContent;
async function fixture(
  t,
  {
    group = false,
    forum = false,
    fields = { photo: [{ file_id: 'photo_1', file_unique_id: 'unique_1', file_size: PNG.length }] },
  } = {},
) {
  const env = environment();
  t.after(() => env.DB.close());
  if (group) env.TELEGRAM_ALLOWED_GROUPS = JSON.stringify({ [CHAT]: ['10001', '20002'] });
  const state = {
    now: NOW,
    bytes: PNG,
    getFiles: 0,
    downloads: 0,
    events: [],
    jobs: [],
    filePath: 'photos/file_1.png',
    fileInfo: {},
    response: null,
    hold: null,
    afterDownload: null,
  };
  const worker = createWorker({
    now: () => state.now,
    fetch: async (url, init) => {
      if (url.startsWith('https://api.telegram.org/file/')) {
        state.downloads++;
        if (state.hold) await state.hold;
        if (state.afterDownload) await state.afterDownload();
        return state.response ? state.response() : new Response(state.bytes);
      }
      const args = JSON.parse(init.body),
        method = new URL(url).pathname.split('/').at(-1);
      if (method === 'getChat')
        return Response.json({
          ok: true,
          result: { id: Number(CHAT), type: 'supergroup', ...(forum ? { is_forum: true } : {}) },
        });
      if (method === 'getChatMember')
        return Response.json({
          ok: true,
          result: { user: { id: 123456, is_bot: true }, status: 'administrator' },
        });
      if (method === 'getFile') {
        state.getFiles++;
        return state.resolveResponse
          ? state.resolveResponse()
          : Response.json({
              ok: true,
              result: {
                file_id: args.file_id,
                file_unique_id: 'unique_1',
                file_size: state.bytes.length,
                file_path: state.filePath,
                ...state.fileInfo,
              },
            });
      }
      if (args.type === 'verification') return challengeResponse(init);
      state.events.push(args);
      return new Response(null, { status: 204 });
    },
  });
  const chat = group ? CHAT : '10001';
  if (group)
    assert.equal(
      data(await call(worker, env, 'verify_group_access', { chat_id: chat })).state,
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
  const payload = update(1);
  delete payload.message.text;
  Object.assign(payload.message, fields);
  if (group) {
    payload.message.chat = {
      id: Number(CHAT),
      type: 'supergroup',
      ...(forum ? { is_forum: true } : {}),
    };
    payload.message.from.id = 20002;
  }
  if (forum) Object.assign(payload.message, { is_topic_message: true, message_thread_id: 7 });
  const args = {
    chat_id: chat,
    message_id: 11,
    update_id: 1,
    ...(forum ? { message_thread_id: 7 } : {}),
  };
  const receive = () =>
    worker.fetch(telegramRequest(payload), env, { waitUntil: (job) => state.jobs.push(job) });
  const drain = () => Promise.all(state.jobs.splice(0));
  const read = (overrides = {}) =>
    call(worker, env, 'get_message_media', { ...args, ...overrides });
  return { env, state, worker, payload, args, receive, drain, read };
}

test('eligible image prefetch preserves receipt and returns real MCP pixels without another download', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.receive()).status, 200);
  await f.drain();
  assert.equal(f.state.events.length, 1);
  assert.equal(f.state.downloads, 1);
  assert.equal(f.state.events[0].data.media.files[0].file_id, 'photo_1');
  const result = await f.read({ mode: 'auto' });
  assert.equal(data(result).state, 'ready');
  assert.deepEqual(result.body.result.content[1], {
    type: 'image',
    mimeType: 'image/png',
    data: PNG.toString('base64'),
  });
  assert.equal(f.state.downloads, 1);
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes('synthetic-token'));
  assert.ok(!serialized.includes('file_path'));
});

test('slow background download cannot block receipt or change its callback payload', async (t) => {
  const f = await fixture(t);
  let release;
  f.state.hold = new Promise((resolve) => (release = resolve));
  const receipt = await f.receive();
  assert.equal(receipt.status, 200);
  assert.equal(f.state.events.length, 1);
  release();
  await f.drain();
  assert.equal(data(await f.read()).state, 'ready');
});

test('private named-topic image prefetch keeps exact context through cache hits and revocation', async (t) => {
  const f = await fixture(t, { forum: true });
  assert.equal((await f.receive()).status, 200);
  await f.drain();
  assert.equal(f.state.events[0].data.message_thread_id, 7);
  for (const message_thread_id of [undefined, 1, 8])
    assert.ok((await f.read({ message_thread_id })).body.error);
  const result = await f.read({ mode: 'auto' });
  assert.equal(data(result).state, 'ready');
  assert.deepEqual(result.body.result.content[1], {
    type: 'image',
    mimeType: 'image/png',
    data: PNG.toString('base64'),
  });
  assert.equal(f.state.downloads, 1);
  f.env.TELEGRAM_ALLOWED_USER_IDS = '20002';
  assert.ok((await f.read()).body.error);
  assert.equal(f.state.downloads, 1);
});

test('private General media accepts ID 1 or omission and rechecks its raw retained identity', async (t) => {
  for (const wireThread of [undefined, 1]) {
    const f = await fixture(t);
    if (wireThread !== undefined) f.payload.message.message_thread_id = wireThread;
    await f.receive();
    await f.drain();
    for (const message_thread_id of [undefined, 1])
      assert.equal(data(await f.read({ message_thread_id, mode: 'auto' })).state, 'ready');
    assert.ok((await f.read({ message_thread_id: 7 })).body.error);
    assert.equal(f.state.downloads, 1);
  }
});

test('only known-size ordinary photos and explicit static stickers prefetch', async (t) => {
  for (const fields of [
    { photo: [{ file_id: 'photo_1', file_unique_id: 'unique_1' }] },
    { photo: [{ file_id: 'photo_1', file_unique_id: 'unique_1', file_size: 2000001 }] },
    {
      document: {
        file_id: 'photo_1',
        file_unique_id: 'unique_1',
        file_size: PNG.length,
        mime_type: 'image/png',
      },
    },
    {
      sticker: {
        file_id: 'photo_1',
        file_unique_id: 'unique_1',
        file_size: PNG.length,
        is_animated: true,
        is_video: false,
      },
    },
    { sticker: { file_id: 'photo_1', file_unique_id: 'unique_1', file_size: PNG.length } },
  ]) {
    const f = await fixture(t, { fields });
    await f.receive();
    await f.drain();
    assert.equal(f.state.downloads, 0);
    const auto = await f.read({ mode: 'auto' });
    assert.equal(data(auto).state, 'on_demand_required');
    const explicit = await f.read();
    assert.equal(data(explicit).state, 'ready');
  }
  const f = await fixture(t, {
    fields: {
      sticker: {
        file_id: 'photo_1',
        file_unique_id: 'unique_1',
        file_size: PNG.length,
        is_animated: false,
        is_video: false,
      },
    },
  });
  await f.receive();
  await f.drain();
  assert.equal(f.state.downloads, 1);
});

test('actual auto byte limit rejects metadata lies; explicit larger image read is bounded', async (t) => {
  const f = await fixture(t);
  f.state.bytes = Buffer.concat([PNG, Buffer.alloc(2000000 - PNG.length)]);
  await f.receive();
  await f.drain();
  assert.equal(data(await f.read({ mode: 'auto' })).state, 'ready');
  const g = await fixture(t);
  g.state.bytes = Buffer.concat([PNG, Buffer.alloc(2000001 - PNG.length)]);
  g.state.fileInfo.file_size = 10;
  await g.receive();
  await g.drain();
  assert.equal(data(await g.read({ mode: 'auto' })).state, 'unavailable');
  assert.equal(data(await g.read()).state, 'ready');
  const h = await fixture(t);
  h.state.bytes = Buffer.alloc(8000001);
  await h.receive();
  await h.drain();
  assert.equal(data(await h.read()).state, 'unavailable');
  assert.equal(h.state.events.length, 1);
});

test('download errors redirects unsafe paths and mismatched identities never expose bytes or credentials', async (t) => {
  for (const mutate of [
    (s) => (s.filePath = '../secret'),
    (s) => (s.filePath = 'https://evil.example/x'),
    (s) => (s.filePath = 'photos/%2e%2e/x'),
    (s) => (s.fileInfo.file_unique_id = 'other'),
    (s) =>
      (s.response = () =>
        new Response(null, { status: 302, headers: { location: 'https://evil.example' } })),
    (s) =>
      (s.response = () => {
        throw new Error(
          'https://api.telegram.org/file/bot123456:synthetic-token-not-a-secret/private',
        );
      }),
  ]) {
    const f = await fixture(t);
    mutate(f.state);
    await f.receive();
    await f.drain();
    const result = await f.read();
    assert.equal(data(result).state, 'unavailable');
    assert.equal(f.state.events.length, 1);
    assert.ok(!JSON.stringify(result).includes('synthetic-token'));
  }
});

test('untrusted binary and dimension bombs never become model images', async (t) => {
  for (const bytes of [
    Buffer.from('<svg><script>bad()</script></svg>'),
    Buffer.from('arbitrary binary'),
    (() => {
      const b = Buffer.from(PNG);
      b.writeUInt32BE(100000, 16);
      return b;
    })(),
  ]) {
    const f = await fixture(t);
    f.state.bytes = bytes;
    await f.receive();
    await f.drain();
    const result = await f.read();
    assert.equal(data(result).state, 'unsupported');
    assert.ok(
      !result.body.result.content.some((item) => item.type === 'image' || item.type === 'resource'),
    );
  }
});

test('retained message authorization rejects wrong IDs topics senders and logical expiry even on cache hits', async (t) => {
  const f = await fixture(t);
  await f.receive();
  await f.drain();
  for (const args of [
    { chat_id: '20002' },
    { message_id: 99 },
    { update_id: 99 },
    { message_thread_id: 7 },
    { file_id: 'photo_1' },
    { url: 'https://evil.example' },
  ])
    assert.ok((await f.read(args)).body.error);
  f.env.TELEGRAM_ALLOWED_USER_IDS = '20002';
  assert.ok((await f.read()).body.error);
  f.env.TELEGRAM_ALLOWED_USER_IDS = '10001';
  f.state.now += 7 * 86400000 + 1;
  assert.ok((await f.read()).body.error);
  const g = await fixture(t, { group: true, forum: true });
  await g.receive();
  await g.drain();
  assert.ok((await g.read({ message_thread_id: 8 })).body.error);
  await call(g.worker, g.env, 'pause_group_access', { chat_id: CHAT });
  assert.ok((await g.read()).body.error);
  assert.equal((await g.env.DB.prepare('SELECT count(*) n FROM media_cache').first()).n, 0);
});

test('revocation during download suppresses pixels and duplicate delivery cannot replace retained file context', async (t) => {
  const f = await fixture(t);
  f.state.afterDownload = () => {
    f.env.TELEGRAM_ALLOWED_USER_IDS = '20002';
  };
  await f.receive();
  await f.drain();
  assert.ok((await f.read()).body.error);
  const g = await fixture(t);
  await g.receive();
  await g.drain();
  g.payload.message.photo[0].file_id = 'substituted';
  await g.receive();
  await g.drain();
  assert.equal(g.state.downloads, 1);
  assert.equal(data(await g.read()).state, 'ready');
});

test('concurrent reads share a durable lease; cache expires and retries without leaking chunks', async (t) => {
  const f = await fixture(t, {
    fields: { photo: [{ file_id: 'photo_1', file_unique_id: 'unique_1' }] },
  });
  await f.receive();
  let release, started;
  const began = new Promise((resolve) => (started = resolve));
  f.state.hold = new Promise((resolve) => (release = resolve));
  f.state.afterDownload = started;
  let settled = false;
  const first = f.read().finally(() => (settled = true));
  // Wait for the actual network request to acquire its lease, not an arbitrary delay.
  while (!f.state.downloads && !settled) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.state.downloads, 1, 'a retrieval request must reach the bounded downloader');
  const concurrent = f.read();
  setTimeout(release, 20);
  await began;
  assert.equal(data(await concurrent).state, 'ready');
  assert.equal(data(await first).state, 'ready');
  assert.equal(f.state.downloads, 1);
  f.state.hold = null;
  f.state.now += 600001;
  assert.equal(data(await f.read()).state, 'ready');
  assert.equal(f.state.downloads, 2);
  assert.equal((await f.env.DB.prepare('SELECT count(*) n FROM media_chunks').first()).n, 1);
});

test('the cache evicts ready entries for a new image while keeping admission bounded', async (t) => {
  const f = await fixture(t);
  await f.receive();
  await f.drain();
  for (let id = 2; id <= 33; id++) {
    f.payload.update_id = id;
    f.payload.message.message_id = id + 10;
    f.payload.message.photo[0].file_id = 'photo_' + id;
    await f.receive();
    await f.drain();
  }
  assert.equal(f.state.events.length, 33);
  assert.equal((await f.env.DB.prepare('SELECT count(*) n FROM media_cache').first()).n, 32);
  assert.equal(data(await f.read({ update_id: 33, message_id: 43 })).state, 'ready');
});

test('bot-loss updates and mid-download owner pause purge all private cache chunks', async (t) => {
  const f = await fixture(t, { group: true, forum: true });
  await f.receive();
  await f.drain();
  const lost = {
    update_id: 90,
    my_chat_member: {
      chat: { id: Number(CHAT), type: 'supergroup' },
      from: { id: 10001, is_bot: false },
      date: Math.floor(NOW / 1000),
      old_chat_member: { status: 'administrator', user: { id: 123456, is_bot: true } },
      new_chat_member: { status: 'left', user: { id: 123456, is_bot: true } },
    },
  };
  assert.equal((await f.worker.fetch(telegramRequest(lost), f.env)).status, 200);
  assert.equal((await f.env.DB.prepare('SELECT count(*) n FROM media_cache').first()).n, 0);
  assert.equal((await f.env.DB.prepare('SELECT count(*) n FROM media_chunks').first()).n, 0);
  const g = await fixture(t, {
    group: true,
    forum: true,
    fields: { photo: [{ file_id: 'photo_1', file_unique_id: 'unique_1' }] },
  });
  await g.receive();
  g.state.afterDownload = () => call(g.worker, g.env, 'pause_group_access', { chat_id: CHAT });
  assert.ok((await g.read()).body.error);
  assert.equal((await g.env.DB.prepare('SELECT count(*) n FROM media_chunks').first()).n, 0);
});

test('animated GIF bytes cannot masquerade as an ordinary static image', async (t) => {
  const gif = Buffer.from('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64');
  const f = await fixture(t);
  f.state.bytes = Buffer.concat([gif.subarray(0, -1), gif.subarray(27, -1), Buffer.from([59])]);
  await f.receive();
  await f.drain();
  assert.equal(data(await f.read()).state, 'unsupported');
});

test('cache expiry during chunk loading cannot return expired image content', async (t) => {
  const f = await fixture(t);
  await f.receive();
  await f.drain();
  const original = f.env.DB.prepare.bind(f.env.DB);
  f.env.DB.prepare = (sql) => {
    if (
      sql.startsWith('SELECT data FROM media_chunks') ||
      sql.startsWith('SELECT chunk_index,data')
    )
      f.state.now += 600001;
    return original(sql);
  };
  assert.equal(data(await f.read()).state, 'unavailable');
});

test('stream deadlines reject a body that ignores abort without blocking the receipt', async (t) => {
  const f = await fixture(t);
  f.state.response = () => new Response(new ReadableStream({ pull: () => new Promise(() => {}) }));
  await f.receive();
  assert.equal(f.state.events.length, 1);
  await f.drain();
  assert.equal(data(await f.read({ mode: 'auto' })).state, 'unavailable');
});

test('live byte reservations enforce global admission and expired leases are reclaimed', async (t) => {
  const f = await fixture(t, {
    fields: { photo: [{ file_id: 'photo_1', file_unique_id: 'unique_1' }] },
  });
  await f.receive();
  for (let i = 0; i < 4; i++)
    await f.env.DB.prepare(
      'INSERT INTO media_cache(cache_key,bot_id,chat_id,lease_token,state,allocated_bytes,expires_at) VALUES (?,?,?,?,?,?,?)',
    )
      .bind('reserved_' + i, '123456', '10001', 'lease', 'downloading', 8000000, NOW + 30000)
      .run();
  assert.equal(data(await f.read()).state, 'cache_full');
  assert.equal(f.state.downloads, 0);
  f.state.now += 30001;
  assert.equal(data(await f.read()).state, 'ready');
  assert.equal(f.state.downloads, 1);
});

test('maximum-size forum image retrieval stays within the D1 free-tier fifty-query budget', async (t) => {
  const f = await fixture(t, {
    group: true,
    forum: true,
    fields: { photo: [{ file_id: 'photo_1', file_unique_id: 'unique_1' }] },
  });
  await f.receive();
  f.state.bytes = Buffer.concat([PNG, Buffer.alloc(8000000 - PNG.length)]);
  let queries = 0;
  const original = f.env.DB.prepare.bind(f.env.DB);
  f.env.DB.prepare = (sql) => {
    queries++;
    return original(sql);
  };
  assert.equal(data(await f.read()).state, 'ready');
  assert.ok(queries <= 50, `retrieval used ${queries} D1 queries`);
});

test('background scheduling failure cannot turn an accepted receipt into a retry', async (t) => {
  const f = await fixture(t);
  let scheduled;
  const receipt = await f.worker.fetch(telegramRequest(f.payload), f.env, {
    waitUntil: (job) => {
      scheduled = job;
      throw new Error('Context unavailable');
    },
  });
  await scheduled;
  assert.equal(receipt.status, 200);
  assert.equal(f.state.events.length, 1);
});

test('an automatic responder read waits for concurrent prefetch without a second download', async (t) => {
  const f = await fixture(t);
  let release;
  f.state.hold = new Promise((resolve) => (release = resolve));
  await f.receive();
  while (!f.state.downloads) await new Promise((resolve) => setImmediate(resolve));
  const original = f.env.DB.prepare.bind(f.env.DB);
  f.env.DB.prepare = (sql) => {
    if (sql === 'SELECT * FROM media_cache WHERE cache_key=?') setTimeout(release, 20);
    return original(sql);
  };
  const result = await f.read({ mode: 'auto' });
  await f.drain();
  assert.equal(data(result).state, 'ready');
  assert.equal(f.state.downloads, 1);
});

test('media maintenance faults cannot suppress a private receipt', async (t) => {
  const f = await fixture(t),
    original = f.env.DB.prepare.bind(f.env.DB);
  f.env.DB.prepare = (sql) => {
    if (sql === 'DELETE FROM media_cache WHERE expires_at<=?')
      throw new Error('Cache maintenance failed');
    return original(sql);
  };
  assert.equal((await f.receive()).status, 200);
  await f.drain();
  assert.equal(f.state.events.length, 1);
});

test('failed on-demand reservations do not starve subsequent automatic images', async (t) => {
  const f = await fixture(t, {
    fields: { photo: [{ file_id: 'photo_1', file_unique_id: 'unique_1' }] },
  });
  f.state.fileInfo.file_size = 8000001;
  for (let id = 1; id <= 4; id++) {
    f.payload.update_id = id;
    f.payload.message.message_id = id + 10;
    f.payload.message.photo[0].file_id = 'file_' + id;
    await f.receive();
    await f.drain();
    assert.equal(data(await f.read({ update_id: id, message_id: id + 10 })).state, 'unavailable');
  }
  delete f.state.fileInfo.file_size;
  f.payload.update_id = 5;
  f.payload.message.message_id = 15;
  Object.assign(f.payload.message.photo[0], { file_id: 'small_5', file_size: PNG.length });
  await f.receive();
  await f.drain();
  assert.equal(data(await f.read({ update_id: 5, message_id: 15, mode: 'auto' })).state, 'ready');
});

test('unsupported bytes retain no chunks or byte reservation', async (t) => {
  const f = await fixture(t, {
    fields: { document: { file_id: 'photo_1', file_unique_id: 'unique_1' } },
  });
  f.state.bytes = Buffer.from('binary document contents');
  await f.receive();
  assert.equal(data(await f.read()).state, 'unsupported');
  assert.equal((await f.env.DB.prepare('SELECT count(*) n FROM media_chunks').first()).n, 0);
  assert.equal((await f.env.DB.prepare('SELECT allocated_bytes n FROM media_cache').first()).n, 0);
});

test('malformed or oversized getFile responses are generic unavailable results', async (t) => {
  for (const body of ['<html>not JSON</html>', 'x'.repeat(65537)]) {
    const f = await fixture(t);
    f.state.resolveResponse = () => new Response(body);
    await f.receive();
    await f.drain();
    const result = await f.read();
    assert.equal(result.status, 200);
    assert.equal(data(result).state, 'unavailable');
  }
});

test('corrupt cached chunks return unavailable and are removed', async (t) => {
  const f = await fixture(t);
  await f.receive();
  await f.drain();
  await f.env.DB.prepare("UPDATE media_chunks SET data='!' ").run();
  const result = await f.read();
  assert.equal(result.status, 200);
  assert.equal(data(result).state, 'unavailable');
  assert.equal((await f.env.DB.prepare('SELECT count(*) n FROM media_cache').first()).n, 0);
});

test('multi-chunk image bytes survive base64 transport exactly; duplicate warming reads no chunks', async (t) => {
  const f = await fixture(t);
  f.state.bytes = Buffer.concat([PNG, Buffer.alloc(1999999 - PNG.length)]);
  await f.receive();
  await f.drain();
  assert.equal((await f.read()).body.result.content[1].data, f.state.bytes.toString('base64'));
  let chunkReads = 0;
  const original = f.env.DB.prepare.bind(f.env.DB);
  f.env.DB.prepare = (sql) => {
    if (
      sql.startsWith('SELECT data FROM media_chunks') ||
      sql.startsWith('SELECT chunk_index,data')
    )
      chunkReads++;
    return original(sql);
  };
  await f.receive();
  await f.drain();
  assert.equal(chunkReads, 0);
  assert.equal(f.state.downloads, 1);
});

test('malformed and animated image containers cannot bypass static dimension validation', async (t) => {
  const png = Buffer.from(PNG);
  png.writeUInt32BE(0xffffffff, 33);
  const gif = Buffer.from('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64');
  gif.writeUInt16LE(10, 28);
  const webp = Buffer.alloc(44);
  webp.write('RIFF', 0);
  webp.writeUInt32LE(36, 4);
  webp.write('WEBPVP8X', 8);
  webp.writeUInt32LE(10, 16);
  webp.write('ANIM', 30);
  webp.writeUInt32LE(6, 34);
  for (const bytes of [png, gif, webp]) {
    const f = await fixture(t);
    f.state.bytes = bytes;
    await f.receive();
    await f.drain();
    assert.equal(data(await f.read()).state, 'unsupported');
  }
});

test('ordinary JPEG photos and single-frame GIFs return their actual image content types', async (t) => {
  const jpeg =
    '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD8qqKKKAP/2Q==';
  for (const [encoded, mime] of [
    [jpeg, 'image/jpeg'],
    ['R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==', 'image/gif'],
  ]) {
    const f = await fixture(t);
    f.state.bytes = Buffer.from(encoded, 'base64');
    await f.receive();
    await f.drain();
    assert.deepEqual((await f.read()).body.result.content[1], {
      type: 'image',
      mimeType: mime,
      data: encoded,
    });
  }
});
