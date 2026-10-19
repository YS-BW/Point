import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, type FauxResponseStep } from '@earendil-works/pi-ai/providers/faux';
import { openRuntime, type ModelBinding } from '../src/runtime/open.js';
import { IDENTITY_TEXT, SECTION_KEYS } from '../src/runtime/context.js';
import {
  MAX_PROFILE_PROMPT_CHARS, MAX_PROFILE_PROMPT_VALUE_CHARS, renderProfilePrompt, type ProfileEntry,
} from '../src/domain/profile.js';

/** The provider request shape tests rely on: the leading system message declares rendered sections. */
type CapturedSystem = {
  role: 'system';
  content: unknown;
  sections?: Readonly<Record<string, string | null>>;
};
type CapturedRequest = {messages: ReadonlyArray<{role: string; content: unknown; sections?: Readonly<Record<string, string | null>>}>};

function provider(responses: FauxResponseStep[]) {
  const faux = fauxProvider({tokensPerSecond: 100000});
  faux.setResponses(responses);
  const models = createModels();
  models.setProvider(faux.provider);
  return {faux, binding: {models, model: {provider: 'faux', modelId: 'faux-1'}} satisfies ModelBinding};
}

const capture = (captures: CapturedRequest[], text: string): FauxResponseStep => (request: unknown) => {
  captures.push(request as CapturedRequest);
  return fauxAssistantMessage(text);
};

async function fixture(t: TestContext, responses: FauxResponseStep[]) {
  const dir = await mkdtemp(join(tmpdir(), 'point-context-'));
  const p = provider(responses);
  const runtime = await openRuntime(dir, p.binding);
  t.after(async () => { await runtime.close(); await rm(dir, {recursive: true, force: true}); });
  return {runtime, faux: p.faux, dir};
}

async function send(runtime: Awaited<ReturnType<typeof openRuntime>>, chatId: string, requestId: string, text: string) {
  const receipt = await runtime.conversation.send({chatId, requestId, text});
  assert.equal((await runtime.conversation.wait(receipt.commandId)).status, 'answered');
}

function sectionsOf(request: CapturedRequest): Readonly<Record<string, string | null>> {
  const system = request.messages.find(message => message.role === 'system') as CapturedSystem | undefined;
  assert.ok(system, 'the model request has a leading system message');
  return system.sections ?? {};
}

test('model requests carry identity, current chat and saved profile sections, in order', async t => {
  const captures: CapturedRequest[] = [];
  const f = await fixture(t, [capture(captures, '好的')]);
  const chat = await f.runtime.chats.create({requestId: 'chat', name: '项目A'});
  await f.runtime.profile.remember({requestId: 'p1', key: 'tone', value: '简洁', kind: 'preference', sourceChatId: chat.id});
  await send(f.runtime, chat.id, 's1', '你好');

  const sections = sectionsOf(captures[0]!);
  assert.equal(sections[SECTION_KEYS.identity], IDENTITY_TEXT, 'identity is a raw, untagged section');
  assert.ok(sections[SECTION_KEYS.chat]?.includes(`当前会话：项目A；chatId=${chat.id}。`));
  assert.ok(sections[SECTION_KEYS.profile]?.includes('- [preference] tone: 简洁'));
  assert.deepEqual(Object.keys(sections), [SECTION_KEYS.identity, SECTION_KEYS.chat, SECTION_KEYS.profile],
    'sections render in installation order');
});

test('an empty profile omits its section and chat sections are isolated per conversation', async t => {
  const captures: CapturedRequest[] = [];
  const f = await fixture(t, [capture(captures, 'A'), capture(captures, 'B'), capture(captures, 'C')]);
  const first = await f.runtime.chats.create({requestId: 'chat-a', name: '项目A'});
  const second = await f.runtime.chats.create({requestId: 'chat-b', name: '旅行'});
  await send(f.runtime, first.id, 'a1', 'A问题');
  await send(f.runtime, second.id, 'b1', 'B问题');
  const sectionsA = sectionsOf(captures[0]!);
  const sectionsB = sectionsOf(captures[1]!);
  assert.ok(!sectionsA[SECTION_KEYS.profile], 'an empty profile omits the whole section');
  assert.ok(!sectionsB[SECTION_KEYS.profile]);
  assert.ok(sectionsA[SECTION_KEYS.chat]?.includes('项目A'));
  assert.ok(!sectionsA[SECTION_KEYS.chat]?.includes('旅行'), 'a chat request never shows another chat');
  assert.ok(sectionsB[SECTION_KEYS.chat]?.includes('旅行'));
  assert.ok(!sectionsB[SECTION_KEYS.chat]?.includes('项目A'));
  assert.equal(sectionsA[SECTION_KEYS.identity], sectionsB[SECTION_KEYS.identity], 'identity is stable across chats');
  // Remember then forget: the section is omitted again instead of rendering empty.
  await f.runtime.profile.remember({requestId: 'p1', key: 'tone', value: '简洁', kind: 'preference', sourceChatId: first.id});
  await f.runtime.profile.forget({requestId: 'f1', key: 'tone'});
  await send(f.runtime, first.id, 'a2', '再说一次');
  assert.ok(!sectionsOf(captures[2]!)[SECTION_KEYS.profile], 'forgetting removes the profile section');
});

test('a single long profile value is truncated to 500 characters in the prompt', async t => {
  const captures: CapturedRequest[] = [];
  const f = await fixture(t, [capture(captures, 'ok')]);
  const chat = await f.runtime.chats.create({requestId: 'chat', name: '长值'});
  await f.runtime.profile.remember({
    requestId: 'p1', key: 'detail', value: 'y'.repeat(1000), kind: 'fact', sourceChatId: chat.id,
  });
  await send(f.runtime, chat.id, 's1', '你好');
  const profile = sectionsOf(captures[0]!)[SECTION_KEYS.profile];
  assert.ok(profile);
  const capped = `${'y'.repeat(MAX_PROFILE_PROMPT_VALUE_CHARS - 1)}…`;
  assert.ok(profile.includes(`- [fact] detail: ${capped}`), 'the rendered value is capped at 500 with an ellipsis');
  assert.ok(!profile.includes('y'.repeat(MAX_PROFILE_PROMPT_VALUE_CHARS)), 'no more than 500 value characters are injected');
  assert.ok(!profile.includes('y'.repeat(1000)), 'the full value is never injected verbatim');
});

test('the profile section stays within the 8000 character budget and marks omissions', async t => {
  const captures: CapturedRequest[] = [];
  const f = await fixture(t, [capture(captures, 'ok')]);
  const chat = await f.runtime.chats.create({requestId: 'chat', name: '大档案'});
  const entries: ProfileEntry[] = [];
  for (let index = 0; index < 20; index += 1) {
    entries.push(await f.runtime.profile.remember({
      requestId: `p${index}`, key: `k${String(index).padStart(2, '0')}`,
      value: `${'z'.repeat(3800)}${index}`, kind: 'fact', sourceChatId: chat.id,
    }));
  }
  await send(f.runtime, chat.id, 's1', '你好');
  const section = sectionsOf(captures[0]!)[SECTION_KEYS.profile];
  assert.ok(section);
  const expected = renderProfilePrompt(entries);
  assert.ok(expected);
  assert.ok(section.includes(expected), 'the section is exactly the budgeted profile render');
  assert.ok(expected.length <= MAX_PROFILE_PROMPT_CHARS, `rendered prompt is ${expected.length} characters`);
  assert.ok(section.length <= MAX_PROFILE_PROMPT_CHARS + 64, `section length ${section.length} stays bounded by its tags`);
  assert.match(expected, /\[profile truncated: \d+ entries omitted\]/);
  assert.ok(expected.includes('- [fact] k00:'), 'earliest entries are kept first');
  assert.ok(!expected.includes('k19:'), 'entries beyond the budget are omitted');
});
