import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createWorker } from '../worker/index.js';
import { TestDatabase, environment, NOW, call, update, telegramRequest } from './helpers.mjs';

const migration = readFileSync(
  new URL('../drizzle/0006_message_reactions.sql', import.meta.url),
  'utf8',
);
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9woAAAAASUVORK5CYII=',
  'base64',
);
const media = {
  type: 'photo',
  files: [{ kind: 'photo', file_id: 'photo_1', file_unique_id: 'unique_1', file_size: PNG.length }],
};
const content = (result) => result.body.result?.structuredContent;
function fixture(t) {
  const db = new TestDatabase(6);
  t.after(() => db.close());
  const env = environment(db),
    reactions = [];
  const worker = createWorker({
    now: () => NOW,
    fetch: async (url, init) => {
      if (url.startsWith('https://api.telegram.org/file/')) return new Response(PNG);
      const method = new URL(url).pathname.split('/').at(-1),
        args = JSON.parse(init.body);
      if (method === 'getFile')
        return Response.json({
          ok: true,
          result: {
            file_id: 'photo_1',
            file_unique_id: 'unique_1',
            file_size: PNG.length,
            file_path: 'photos/synthetic.png',
          },
        });
      assert.equal(method, 'setMessageReaction');
      reactions.push(args);
      return Response.json({ ok: true, result: true });
    },
  });
  function legacy(id, metadata = null) {
    db.sqlite
      .prepare(
        `INSERT INTO inbox(event_id,bot_id,update_id,chat_id,sender_id,message_id,text,occurred_at,received_at,media_json)
      VALUES (?, '123456',?,'10001','10001',?,?,?, ?,?)`,
      )
      .run(
        'legacy-' + id,
        id,
        id + 10,
        metadata ? '[Telegram photo message]' : 'Legacy text',
        new Date(NOW).toISOString(),
        NOW,
        metadata ? JSON.stringify(metadata) : null,
      );
  }
  const react = (id) =>
    call(worker, env, 'set_message_reaction', {
      chat_id: '10001',
      message_id: id + 10,
      update_id: id,
      reaction: '👀',
      idempotency_key: 'synthetic-' + id,
    });
  return { db, env, worker, reactions, legacy, react };
}

test('schema-only migration labels old rows without a data backfill', (t) => {
  const { db, legacy } = fixture(t);
  legacy(1);
  legacy(2, media);
  const before = db.sqlite.prepare('SELECT * FROM inbox ORDER BY update_id').all();
  const changes = db.sqlite.prepare('SELECT total_changes() AS n').get().n;
  db.sqlite.exec(migration);
  assert.equal(
    db.sqlite.prepare('SELECT total_changes() AS n').get().n,
    changes,
    'Migration must not write existing row data',
  );
  const after = db.sqlite.prepare('SELECT * FROM inbox ORDER BY update_id').all();
  assert.deepEqual(
    after.map(({ reaction_album, ...row }) => row),
    before.map((row) => ({ ...row })),
  );
  assert.deepEqual(
    after.map((row) => row.reaction_album),
    [-1, -1],
  );
});

test('legacy text can react while legacy media stays excluded and model-readable', async (t) => {
  const { db, env, worker, reactions, legacy, react } = fixture(t);
  legacy(1);
  legacy(2, media);
  db.sqlite.exec(migration);
  assert.equal(content(await react(1)).state, 'applied');
  assert.ok((await react(2)).body.error);
  assert.deepEqual(
    reactions.map((args) => args.message_id),
    [11],
  );
  const image = await call(worker, env, 'get_message_media', {
    chat_id: '10001',
    message_id: 12,
    update_id: 2,
  });
  assert.equal(content(image).state, 'ready');
  assert.deepEqual(image.body.result.content[1], {
    type: 'image',
    mimeType: 'image/png',
    data: PNG.toString('base64'),
  });
});

test('new ingestion explicitly overrides the legacy default and rejects raw album edge cases', async (t) => {
  const { db, env, worker, reactions, react } = fixture(t);
  db.sqlite.exec(migration);
  // Current ingestion requires the full schema; the tests above isolate 0006.
  const later = JSON.parse(
    readFileSync(new URL('../drizzle/meta/_journal.json', import.meta.url), 'utf8'),
  ).entries.slice(7);
  for (const entry of later)
    db.sqlite.exec(readFileSync(new URL(`../drizzle/${entry.tag}.sql`, import.meta.url), 'utf8'));
  const cases = [
    { id: 10 },
    { id: 11, photo: true },
    { id: 12, photo: true, album: 'album_1' },
    { id: 13, photo: true, album: 'bad\n' },
    { id: 14, photo: true, album: null },
    { id: 15, album: {} },
    { id: 16, album: '' },
  ];
  for (const item of cases) {
    const payload = update(item.id);
    if (item.photo) {
      delete payload.message.text;
      payload.message.photo = [media.files[0]];
    }
    if (Object.hasOwn(item, 'album')) payload.message.media_group_id = item.album;
    await worker.fetch(telegramRequest(payload), env);
    assert.equal(
      db.sqlite.prepare('SELECT reaction_album FROM inbox WHERE update_id=?').get(item.id)
        .reaction_album,
      Object.hasOwn(item, 'album') ? 1 : 0,
    );
    const result = await react(item.id);
    if (Object.hasOwn(item, 'album')) assert.ok(result.body.error);
    else assert.equal(content(result).state, 'applied');
  }
  assert.deepEqual(
    reactions.map((args) => args.message_id),
    [20, 21],
  );
});
