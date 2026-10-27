import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { TOOLS } from '../worker/tools.ts';

// Prompt templates are pasted into hosted tasks, so a stale tool name or a key
// template that send_message would reject only fails at runtime. Check them here.
const root = new URL('../', import.meta.url);
const promptFiles = (await readdir(new URL('prompts/', root))).filter((f) => f.endsWith('.md'));
const prompts = Object.fromEntries(
  await Promise.all(
    promptFiles.map(async (f) => [f, await readFile(new URL(`prompts/${f}`, root), 'utf8')]),
  ),
);
const docs = (
  await Promise.all(
    ['docs/normal-chat.md', 'docs/group-chat.md'].map((p) => readFile(new URL(p, root), 'utf8')),
  )
).join('\n');
const toolNames = new Set(TOOLS.map((t) => t.name));
const keyPattern = new RegExp(
  TOOLS.find((t) => t.name === 'send_message').inputSchema.properties.idempotency_key.pattern,
);

test('prompts reference only existing connector tools', () => {
  for (const [file, text] of Object.entries(prompts))
    for (const [, name] of text.matchAll(
      /`((?:get|send|set|verify|pause|configure|retry)_[a-z_]+)`/g,
    ))
      assert.ok(toolNames.has(name), `${file} references unknown tool ${name}`);
});

test('prompt idempotency key templates produce keys send_message accepts', () => {
  const samples = {
    chat_id: ['10001', '-1009007199254740'],
    thread_id: ['1', '9007199254740991'],
    anchor_message_id: ['1', '9007199254740991'],
    kind: ['reply', 'ack'],
    part: ['1', '4'],
  };
  let checked = 0;
  for (const [file, text] of Object.entries(prompts))
    for (const [, template] of text.matchAll(/`(tg-[a-z]+:v\d+:[^`]+)`/g)) {
      for (const pick of [0, 1]) {
        const key = template.replace(/<([a-z_]+)>/g, (_, name) => {
          assert.ok(samples[name], `${file}: unknown placeholder <${name}> in ${template}`);
          return samples[name][pick];
        });
        assert.match(key, keyPattern, `${file}: ${key}`);
        checked++;
      }
    }
  assert.ok(checked > 0, 'expected key templates in prompts');
});

test('every prompt placeholder is documented for the installer', () => {
  for (const [file, text] of Object.entries(prompts))
    for (const [placeholder] of text.matchAll(/\{\{[A-Z_]+\}\}/g))
      assert.ok(docs.includes(placeholder), `${file}: ${placeholder} is not documented`);
});
