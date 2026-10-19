/**
 * `point.ui.*` CUSTOM namespace: declarative contract only. No renderer, no HTML/JS/DOM
 * and no Durable writes may ever carry executable content. Components must be
 * pre-registered by the client; the server only validates and forwards bounded props.
 */

import { ApiError } from '../errors.js';

/** Registered component names. WP5 ships a placeholder only; the server emits none. */
export const UI_COMPONENT_NAMES: readonly string[] = Object.freeze(['point.placeholder']);
/** Strict component grammar; the exact name must also be in `UI_COMPONENT_NAMES`. */
const COMPONENT_PATTERN = /^[a-z][a-z0-9]{0,31}(?:\.[a-z][a-z0-9]{0,31}){1,3}$/;
/** Strict prop keys; prototype-pollution and uppercase keys are refused. */
const PROP_KEY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const ARTIFACT_PATTERN = /^[A-Za-z0-9._:-]{1,512}$/;
const MAX_PROPS_BYTES = 2_048;
const MAX_DEPTH = 4;
const MAX_KEYS = 32;
const MAX_STRING_CHARS = 512;
const CONTROL_CHARS = /\p{Cc}/u;
const RAW_MARKUP = /[<>]/;
const FORBIDDEN_SCHEME = /(?:javascript|data|vbscript):/i;
const ATTRIBUTE_INJECTION = /on[a-z0-9_]+\s*=/i;
const CODE_HINT = /(?:alert|eval|function|document|window|xmlhttprequest|fetch)\s*\(/i;
/** DOM property access such as `document.cookie`/`window.location` (after normalisation). */
const DOM_REFERENCE = /\b(?:document|window)\s*\./i;

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
    if (CONTROL_CHARS.test(value)) bad('ui props must not contain control characters or newlines');
    if (RAW_MARKUP.test(value)) bad('ui props must not contain HTML/JS/DOM');
    // Normalise before looking for schemes/attributes so whitespace cannot hide them.
    const normalized = value.replace(/[\s\p{Cc}]+/gu, '').toLowerCase();
    if (FORBIDDEN_SCHEME.test(normalized)) bad('ui props must not contain executable URI schemes');
    if (ATTRIBUTE_INJECTION.test(normalized)) bad('ui props must not contain inline event handlers');
    if (CODE_HINT.test(normalized)) bad('ui props must not contain executable code');
    if (DOM_REFERENCE.test(normalized)) bad('ui props must not reference the DOM');
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
      if (!PROP_KEY_PATTERN.test(key) || key === 'constructor' || key === 'prototype') bad('invalid ui prop key');
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
