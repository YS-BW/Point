import {openRuntime} from '../../src/runtime/open.js';
import {createModels} from '@earendil-works/pi-ai/models';
import {fauxProvider, fauxAssistantMessage} from '@earendil-works/pi-ai/providers/faux';

const dir = process.argv[2];
const stopping = process.argv[3] === 'stopping';
if (!dir) throw new Error('Missing fixture directory');
let entered!: () => void;
const inflight = new Promise<void>(resolve => {entered = resolve;});
let abortEntered!: () => void;
const aborting = new Promise<void>(resolve => {abortEntered = resolve;});
const faux = fauxProvider();
faux.setResponses([async (_request, options) => {
  entered();
  await new Promise<void>(resolve => options?.signal?.addEventListener('abort', () => {
    abortEntered();
    if (!stopping) resolve();
  }, {once: true}));
  return fauxAssistantMessage('未交付的草稿');
}]);
const models = createModels(); models.setProvider(faux.provider);
const runtime = await openRuntime(dir, {models, model: {provider: 'faux', modelId: 'faux-1'}});
const chat = await runtime.chats.create({requestId: 'crash-chat', name: '项目方案'});
const command = await runtime.conversation.send({chatId: chat.id, requestId: 'crash-send', text: '给小王写方案'});
await inflight;
if (stopping) {
  const stop = await runtime.conversation.stop({chatId: chat.id, requestId: 'stop-before-crash'});
  const next = await runtime.conversation.send({chatId: chat.id, requestId: 'after-stop', text: '先列三个问题'});
  await aborting;
  process.send?.({chatId: chat.id, commandId: command.commandId, stopId: stop.commandId, nextId: next.commandId});
} else process.send?.({chatId: chat.id, commandId: command.commandId});
setInterval(() => {}, 1000);
