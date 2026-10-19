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

test('the reference CLI lane is explicit and may only import node builtins', () => {
  const cli = source => violations(resolve('apps/server/src/cli.ts'), source);
  assert.deepEqual(cli("import {randomUUID} from 'node:crypto'"), []);
  assert.notEqual(cli("import {openRuntime} from './runtime/open.js'").length, 0);
  assert.notEqual(cli("import {createHttp} from './api/http.js'").length, 0);
  assert.notEqual(cli("import {Harness} from '@earendil-works/pi-durable'").length, 0);
});

test('new folders and absolute imports cannot silently bypass layering', () => {
  assert.notEqual(check("import x from '@earendil-works/pi-durable'", 'unregistered').length, 0);
  assert.notEqual(check("import x from 'file:///tmp/implementation.js'", 'api').length, 0);
});

test('domain and application cannot define Durable tasks', () => {
  for (const lane of ['domain', 'application']) {
    const errors = check('const Job = defineTask({ id: "job" });', lane);
    assert.notEqual(errors.length, 0);
    assert.match(errors.join('\n'), /defineTask/);
    assert.match(errors.join('\n'), /runtime/);
  }
  assert.notEqual(check('const Job = defineTask<Input, {phase: "order"}, Result>({ id: "job" });').length, 0);
});

test('Durable task check ignores comments and string literals', () => {
  assert.deepEqual(check('// defineTask({ id: "job" })\n/* defineTask({ id: "job" }) */'), []);
  assert.deepEqual(check('const a = "defineTask({ id: \'job\' })"; const b = \'defineTask(\';'), []);
  assert.deepEqual(check('const a = `defineTask({ id: "job" })`;'), []);
});

test('Durable task check still sees code inside template interpolations', () => {
  assert.notEqual(check('const id = `${defineTask({ id: "job" }).id}`;').length, 0);
});

test('runtime may define Durable tasks', () => {
  assert.deepEqual(check('const Job = defineTask<Input, {phase: "order"}, Result>({ id: "job" });', 'runtime'), []);
  assert.deepEqual(check('const Job = defineTask({ id: "job" });', 'runtime'), []);
});

test('Durable task check catches function-type generic arguments', () => {
  assert.notEqual(check('const Job = defineTask<Input, () => void, Result>({ id: "job" });').length, 0);
  assert.notEqual(check('const Job = defineTask<Input, () => void, Result>({ id: "job" });', 'application').length, 0);
});

test('runtime may define Durable tasks with function-type generic arguments', () => {
  assert.deepEqual(check('const Job = defineTask<Input, () => void, Result>({ id: "job" });', 'runtime'), []);
});
