/** Official AG-UI wire schema and encoder; never imported by the engine. */
import type { Event } from '@ag-ui/core';
import { EventSchema } from '@ag-ui/core/schemas';
import { EventEncoder } from '@ag-ui/encoder';
export { PROTOCOL_VERSION } from '@ag-ui/core';

// Retain string discriminants at the adapter boundary without duplicating payload types.
type WireEvent<E extends Event> = E extends Event ? Omit<E, 'type'> & {type: `${E['type']}`} : never;
export type AguiEvent = WireEvent<Event>;
const encoder = new EventEncoder({accept: 'text/event-stream'});
export function sseFrame(event: AguiEvent): string {
  return encoder.encodeSSE(EventSchema.parse(event) as Event);
}
/**
 * Frame with an SSE `id:` field carrying the frame-level cursor. The official encoder emits only
 * `data:`; the id line is part of the custom thread-stream binding, and standard consumers ignore it.
 */
export function sseFrameWithId(cursor: string, event: AguiEvent): string {
  return `id: ${cursor}\n${sseFrame(event)}`;
}
export function isAguiEvent(value: unknown): value is AguiEvent {
  return EventSchema.safeParse(value).success;
}
