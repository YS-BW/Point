/**
 * `point.ui.*` CUSTOM namespace: declarative contract only. No renderer, no HTML/JS/DOM
 * and no Durable writes may ever carry executable content. Components must be
 * pre-registered by the client; the server only validates and forwards bounded props.
 */

import { ApiError } from '../errors.js';

/** Registered component names. WP5 ships a placeholder only; the server emits none. */
export const UI_COMPONENT_NAMES: readonly string[] = Object.freeze(['point.placeholder']);
const COMPONENT_PATTERN = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*){1,4}$/;
const ARTIFACT_PATTERN = /^[A-Za-z0-9._:-]{1,512}$/;
const MAX_PROPS_BYTES = 2_048;
const MAX_DEPTH = 4;
const MAX_KEYS = 32;
const MAX_STRING_CHARS = 512;
const FORBIDDEN = /[<>]|javascript:|data:/i;

export type PointUiPayload = Readonly<{
  component: string;
  props?: Readonly<Record<string, unknown>>;
  artifactId?: string;
}>;

function bad(message: string): never {
  throw new ApiError(400, 'INVALID_COMMAND', message);
}

function checkValue(value: unknown, depth: number): void {
  if (depth > MAX_DEPTH) bad('ui props are too deep');
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return;
  if (typeof value === 'string') {
    if (Array.from(value).length > MAX_STRING_CHARS) bad('ui prop string is too long');
    if (FORBIDDEN.test(value)) bad('ui props must not contain HTML/JS/DOM');
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_KEYS) bad('ui prop array is too large');
    for (const item of value) checkValue(item, depth + 1);
    return;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>);
    if (keys.length > MAX_KEYS) bad('ui props have too many keys');
    for (const key of keys) {
      if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)) bad('invalid ui prop key');
      checkValue((value as Record<string, unknown>)[key], depth + 1);
    }
    return;
  }
  bad('ui props must be JSON-safe');
}

/** Validate the declarative payload; rejects unknown components, executable content and bounds. */
export function validatePointUiPayload(value: unknown): PointUiPayload {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) bad('ui payload must be an object');
  const payload = value as Record<string, unknown>;
  const component = payload.component;
  if (typeof component !== 'string' || !COMPONENT_PATTERN.test(component)) bad('invalid ui component name');
  if (!UI_COMPONENT_NAMES.includes(component)) bad('ui component is not registered');
  const result: {component: string; props?: Readonly<Record<string, unknown>>; artifactId?: string} = {component};
  if (payload.props !== undefined) {
    if (payload.props === null || typeof payload.props !== 'object' || Array.isArray(payload.props)) {
      bad('ui props must be an object');
    }
    checkValue(payload.props, 0);
    if (Buffer.byteLength(JSON.stringify(payload.props), 'utf8') > MAX_PROPS_BYTES) bad('ui props are too large');
    result.props = payload.props as Readonly<Record<string, unknown>>;
  }
  if (payload.artifactId !== undefined) {
    if (typeof payload.artifactId !== 'string' || !ARTIFACT_PATTERN.test(payload.artifactId)) bad('invalid ui artifact reference');
    result.artifactId = payload.artifactId;
  }
  return result;
}

/** Build the contract-only CUSTOM event; no renderer exists and nothing is persisted. */
export function pointUiEvent(value: unknown): Readonly<{type: 'CUSTOM'; name: string; value: PointUiPayload}> {
  return {type: 'CUSTOM', name: 'point.ui.component', value: validatePointUiPayload(value)};
}
