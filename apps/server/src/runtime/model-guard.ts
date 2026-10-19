import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import type { AssistantMessage, Message, Model, Models } from '@earendil-works/pi-ai';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { defineExtension, GenerationTask, hook, type Harness } from '@earendil-works/pi-durable';
import { ModelCalls } from '../storage/conversation.js';

function failure(model: Model<string>, code: string): AssistantMessage {
  return {role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
    stopReason: 'error', errorMessage: code, timestamp: Date.now(),
    usage: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}}};
}

/** Hooks supply identity only. Dispatch is fail-closed even if a hook throws or is absent. */
export function guardedModels(source: Models, runtime: () => Harness) {
  const permits = new WeakMap<Message, {key: string; chatId: string}>();
  const extension = defineExtension({name: 'point.model-guard', hooks: [hook(GenerationTask, {
    beforeRequest(request, api) {
      const marker: Message = {role: 'system', content: '', timestamp: 0};
      permits.set(marker, {key: String(api.taskId), chatId: String(api.conversationId)});
      return {messages: [...request.messages, marker]};
    },
  })]});
  const streamSimple: Models['streamSimple'] = (model, request, options) => {
    const events = createAssistantMessageEventStream();
    const marker = request.messages.at(-1);
    const permit = marker && permits.get(marker);
    if (marker) permits.delete(marker);
    const finishError = (code: string) => events.push({type: 'error', reason: 'error', error: failure(model, code)});
    void (async () => {
      if (!permit) { finishError('MODEL_GUARD_REQUIRED'); return; }
      const h = runtime();
      const admitted = await h.commit(async tx => {
        const call = await tx.doc(ModelCalls, permit.key, permit.chatId);
        if (call.state !== 'new') {
          if (call.state === 'attempting') call.state = 'unknown';
          return false;
        }
        call.state = options?.signal?.aborted ? 'failed' : 'attempting';
        return call.state === 'attempting';
      }, context);
      if (!admitted) { finishError('MODEL_RESULT_NOT_RECOVERABLE'); return; }
      if (options?.signal?.aborted) {
        await h.commit(async tx => { (await tx.doc(ModelCalls, permit.key, permit.chatId)).state = 'failed'; }, context);
        finishError('MODEL_CANCELLED_BEFORE_DISPATCH'); return;
      }
      try {
        const upstream = source.streamSimple(model, {...request, messages: request.messages.slice(0, -1)}, options);
        for await (const event of upstream) {
          if (event.type !== 'done' && event.type !== 'error') events.push(event);
        }
        const response = await upstream.result();
        const ok = ['stop', 'length', 'toolUse'].includes(response.stopReason);
        await h.commit(async tx => { (await tx.doc(ModelCalls, permit.key, permit.chatId)).state = ok ? 'done' : 'unknown'; }, context);
        if (ok) events.end(response);
        else finishError('MODEL_RESULT_UNKNOWN');
      } catch {
        // If shutdown prevents this commit, the persisted attempting state blocks replay on reopen.
        await h.commit(async tx => { (await tx.doc(ModelCalls, permit.key, permit.chatId)).state = 'unknown'; }, context).catch(() => {});
        finishError('MODEL_RESULT_UNKNOWN');
      }
    })().catch(() => finishError('MODEL_GUARD_FAILED'));
    return events;
  };
  const models = new Proxy(source, {get(target, property) {
    if (property === 'streamSimple') return streamSimple;
    // No bypass through alternate model operations in this product slice.
    if (['stream', 'complete', 'completeSimple', 'fetchDeferred', 'cancelDeferred', 'images', 'classify'].includes(String(property))) {
      return () => { throw new Error('MODEL_OPERATION_NOT_ENABLED'); };
    }
    const value: unknown = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  }});
  return {models, extension};
}
