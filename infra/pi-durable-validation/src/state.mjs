import { defineDoc } from '@earendil-works/pi-durable';

export const State = defineDoc({
  kind: 'point.validation', version: 1, scope: 'conversation', history: 'latest', fork: 'initial',
  initial: () => ({ jobs: {}, requests: {}, preferences: {}, events: [] }),
});

export function event(state, type, jobId, data = {}) {
  state.eventSeq = (state.eventSeq ?? 0) + 1;
  state.events.push({ id: state.eventSeq, at: Date.now(), type, jobId, ...data });
  if (state.events.length > 200) state.events.splice(0, state.events.length - 200);
}

export const terminal = result => ({ status: 'terminal', outcome: { status: 'completed', result } });
export const next = checkpoint => ({ status: 'running', checkpoint });
