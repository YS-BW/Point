import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { violations } from './check-boundaries.mjs';
const check = (source, lane = 'domain') => violations(resolve(`apps/server/src/${lane}/example.ts`), source);
test('boundary rejects static imports, reexports and import types across layers', () => {
  for (const source of ["import x from '../runtime/open.js'", "export * from '../storage/meta.js'", "type X = import('../api/http.js').X", "import {readFile} from 'node:fs'", "import x from '@ag-ui/core'"]) assert.notEqual(check(source).length, 0);
});
test('boundary rejects dynamic and nonliteral imports', () => {
  for (const source of ["import('../adapters/x.js')", 'import(name)', "require('../runtime/x.js')"]) assert.notEqual(check(source).length, 0);
});
test('boundary permits inward imports and SDK only at implementation edge', () => {
  assert.deepEqual(check("import type {Phase} from '../domain/lifecycle.js'", 'application'), []);
  assert.deepEqual(check("import {Harness} from '@earendil-works/pi-durable'", 'runtime'), []);
  assert.notEqual(check("import {Harness} from '@earendil-works/pi-durable'", 'api').length, 0);
});

test('new folders and absolute imports cannot silently bypass layering', () => {
  assert.notEqual(check("import x from '@earendil-works/pi-durable'", 'unregistered').length, 0);
  assert.notEqual(check("import x from 'file:///tmp/implementation.js'", 'api').length, 0);
});
