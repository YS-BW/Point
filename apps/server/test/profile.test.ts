import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAX_PROFILE_ENTRIES, MAX_PROFILE_PROMPT_CHARS, MAX_PROFILE_PROMPT_VALUE_CHARS, MAX_PROFILE_VALUE_CHARS,
  ProfileError, exportUserMarkdown, parseForgetProfile, parseRememberProfile, renderProfilePrompt,
  truncateProfileValue, type ProfileEntry,
} from '../src/domain/profile.js';
import { openRuntime } from '../src/runtime/open.js';

/** A valid remember input; overrides let each test break exactly one field. */
const remember = (overrides: Readonly<Record<string, unknown>> = {}) => ({
  requestId: 'r1', key: 'tone', value: '简洁', kind: 'preference', sourceChatId: '2', ...overrides,
});
const forget = (overrides: Readonly<Record<string, unknown>> = {}) => ({requestId: 'f1', key: 'tone', ...overrides});

function hasCode(code: string) {
  return (error: unknown) => {
    assert.ok(error instanceof ProfileError, `expected ProfileError(${code}), got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  };
}

function entry(overrides: Partial<ProfileEntry> & {key: string; value: string}): ProfileEntry {
  return {kind: 'preference', sourceChatId: '2', updatedAt: 1, ...overrides};
}

async function directory(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'point-profile-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  return dir;
}

test('remember/forget input is strict and normalization is explicit', () => {
  assert.deepEqual(parseRememberProfile(remember({value: '  简洁  '})), {
    requestId: 'r1', key: 'tone', value: '简洁', kind: 'preference', sourceChatId: '2',
  });
  assert.equal(Array.from(parseRememberProfile(remember({value: '😀'.repeat(MAX_PROFILE_VALUE_CHARS)})).value).length,
    MAX_PROFILE_VALUE_CHARS, 'the 4000 limit counts Unicode code points');
  const invalidRemember = [
    null, [], {}, {...remember(), extra: true},
    {...remember(), requestId: ''}, {...remember(), requestId: 'bad id'}, {...remember(), requestId: 'x'.repeat(129)},
    {...remember(), key: ''}, {...remember(), key: 'bad key'}, {...remember(), key: 'x'.repeat(129)}, {...remember(), key: 7},
    {...remember(), value: ''}, {...remember(), value: '   '}, {...remember(), value: 42},
    {...remember(), value: 'x'.repeat(MAX_PROFILE_VALUE_CHARS + 1)},
    {...remember(), kind: 'other'}, {...remember(), kind: undefined}, {...remember(), sourceChatId: ''},
    {...remember(), sourceChatId: 2}, {...remember(), sourceChatId: 'bad id'},
  ];
  for (const input of invalidRemember) {
    assert.throws(() => parseRememberProfile(input), hasCode('INVALID_COMMAND'), `accepted ${JSON.stringify(input)}`);
  }
  assert.deepEqual(parseForgetProfile(forget()), {requestId: 'f1', key: 'tone'});
  for (const input of [null, [], {}, forget({extra: true}), {requestId: 'f1'}, {key: 'tone'},
    forget({requestId: ''}), forget({requestId: 'bad id'}), forget({key: 'bad key'})]) {
    assert.throws(() => parseForgetProfile(input), hasCode('INVALID_COMMAND'));
  }
});

test('profile prompt rendering sorts by key, caps values and honors the 8000 character budget', () => {
  assert.equal(renderProfilePrompt([]), undefined, 'an empty profile renders no section at all');
  assert.equal(renderProfilePrompt([
    entry({key: 'tone', value: '简洁', kind: 'preference'}),
    entry({key: 'goal', value: 'ship', kind: 'fact'}),
  ]), '- [fact] goal: ship\n- [preference] tone: 简洁');

  const long = renderProfilePrompt([entry({key: 'detail', value: 'y'.repeat(1000)})]);
  assert.ok(long);
  const capped = `${'y'.repeat(MAX_PROFILE_PROMPT_VALUE_CHARS - 1)}…`;
  assert.equal(Array.from(truncateProfileValue('y'.repeat(1000))).length, MAX_PROFILE_PROMPT_VALUE_CHARS);
  assert.equal(truncateProfileValue('short'), 'short');
  assert.ok(long.includes(`- [preference] detail: ${capped}`), 'values are capped at 500 code points including the ellipsis');
  assert.ok(!long.includes('y'.repeat(MAX_PROFILE_PROMPT_VALUE_CHARS)), 'never renders more than 500 value characters');

  const many = Array.from({length: MAX_PROFILE_ENTRIES}, (_, index) =>
    entry({key: `k${String(index).padStart(2, '0')}`, value: 'z'.repeat(4000), kind: 'fact'}));
  const bounded = renderProfilePrompt(many);
  assert.ok(bounded);
  assert.ok(bounded.length <= MAX_PROFILE_PROMPT_CHARS, `rendered prompt is ${bounded.length} characters`);
  assert.match(bounded, /\[profile truncated: \d+ entries omitted\]/);
  assert.ok(bounded.includes('- [fact] k00:'), 'earliest keys are kept first');
  assert.ok(!bounded.includes('k63:'), 'entries beyond the budget are omitted');
});

test('USER.md export is a pure documented string: no file is written', async () => {
  assert.equal(exportUserMarkdown([]),
    '# USER.md\n\n<!-- exported from point.profile; Durable documents are authoritative -->\n');
  const markdown = exportUserMarkdown([
    entry({key: 'tone', value: '简洁', kind: 'preference', sourceChatId: '2'}),
    entry({key: 'goal', value: 'ship', kind: 'fact', sourceChatId: '3'}),
  ]);
  assert.equal(markdown,
    '# USER.md\n\n<!-- exported from point.profile; Durable documents are authoritative -->\n\n'
    + '- [fact] goal: ship (source: chat 3)\n- [preference] tone: 简洁 (source: chat 2)\n');
});

test('remember/list/forget/export are explicit, idempotent and Durable', async t => {
  const dir = await directory(t);
  const runtime = await openRuntime(dir);
  try {
    assert.deepEqual(await runtime.profile.list(), []);
    const first = await runtime.profile.remember(remember());
    assert.deepEqual(Object.keys(first).sort(), ['key', 'kind', 'sourceChatId', 'updatedAt', 'value']);
    assert.equal(first.value, '简洁');
    assert.deepEqual(await runtime.profile.list(), [first]);

    // Updating an existing key is an explicit overwrite, not a duplicate entry.
    const updated = await runtime.profile.remember(remember({requestId: 'r2', value: '更简洁', kind: 'decision'}));
    assert.equal(updated.value, '更简洁');
    assert.equal(updated.kind, 'decision');
    assert.equal((await runtime.profile.list()).length, 1);

    // Same request key and same content replays the first entry; different content conflicts.
    assert.deepEqual(await runtime.profile.remember(remember()), first);
    await assert.rejects(runtime.profile.remember(remember({value: '另一段'})), hasCode('IDEMPOTENCY_CONFLICT'));

    // list() returns detached copies.
    const listed = await runtime.profile.list();
    (listed[0] as {value: string}).value = 'caller-mutation';
    assert.equal((await runtime.profile.list())[0]?.value, '更简洁');

    const markdown = await runtime.profile.exportMarkdown();
    assert.ok(markdown.includes('- [decision] tone: 更简洁 (source: chat 2)'));

    // The export never writes a USER.md (or any other file) next to the Durable state.
    const files = await readdir(dir);
    assert.ok(files.every(name => !/^USER\.md$/i.test(name)), `unexpected USER.md: ${files.join(', ')}`);

    // forget removes the entry, keeps its idempotent receipt, and does not touch history.
    const chat = await runtime.chats.create({requestId: 'chat', name: '档案来源'});
    assert.deepEqual(await runtime.profile.forget(forget()), {key: 'tone', removed: true});
    assert.deepEqual(await runtime.profile.list(), []);
    assert.deepEqual(await runtime.profile.forget(forget()), {key: 'tone', removed: true});
    assert.deepEqual(await runtime.profile.forget(forget({requestId: 'f2'})), {key: 'tone', removed: false});
    await assert.rejects(runtime.profile.forget(forget({key: 'other'})), hasCode('IDEMPOTENCY_CONFLICT'));
    assert.deepEqual((await runtime.conversation.history(chat.id)).items, []);
    assert.equal(await runtime.profile.exportMarkdown(), exportUserMarkdown([]));
  } finally {
    await runtime.close();
  }

  // Profile state is Durable: it survives a clean reopen.
  const reopened = await openRuntime(dir);
  try {
    await reopened.profile.remember(remember({requestId: 'r3', value: '持久'}));
    assert.deepEqual((await reopened.profile.list()).map(item => [item.key, item.value]), [['tone', '持久']]);
  } finally {
    await reopened.close();
  }
});

test('the profile caps at 64 entries but updating an existing key is always allowed', async t => {
  const dir = await directory(t);
  const runtime = await openRuntime(dir);
  try {
    for (let index = 0; index < MAX_PROFILE_ENTRIES; index += 1) {
      await runtime.profile.remember(remember({
        requestId: `r${index}`, key: `k${index}`, value: `v${index}`, kind: 'fact', sourceChatId: '1',
      }));
    }
    assert.equal((await runtime.profile.list()).length, MAX_PROFILE_ENTRIES);
    await assert.rejects(runtime.profile.remember(remember({
      requestId: 'overflow', key: 'extra', value: 'x', kind: 'fact', sourceChatId: '1',
    })), hasCode('PROFILE_LIMIT_REACHED'));
    const updated = await runtime.profile.remember(remember({
      requestId: 'update-at-limit', key: 'k0', value: 'updated', kind: 'preference', sourceChatId: '1',
    }));
    assert.equal(updated.value, 'updated');
    assert.equal((await runtime.profile.list()).length, MAX_PROFILE_ENTRIES);
    // list() is sorted by key.
    const keys = (await runtime.profile.list()).map(item => item.key);
    assert.deepEqual(keys, [...keys].sort());
  } finally {
    await runtime.close();
  }
});

test('nothing is inferred from chats: an untouched profile stays empty', async t => {
  const dir = await directory(t);
  const runtime = await openRuntime(dir);
  try {
    await runtime.chats.create({requestId: 'chat-1', name: '聊天一'});
    await runtime.chats.create({requestId: 'chat-2', name: '聊天二'});
    assert.deepEqual(await runtime.profile.list(), [], 'creating chats never extracts memory');
    assert.equal(await runtime.profile.exportMarkdown(), exportUserMarkdown([]));
  } finally {
    await runtime.close();
  }
});
