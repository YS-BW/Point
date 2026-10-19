import ts from 'typescript';
import { readdir, readFile } from 'node:fs/promises';
import { resolve, relative, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve('apps/server/src');
const allowed = {
  domain: ['domain'], application: ['application', 'domain'],
  api: ['api', 'application', 'domain'],
  storage: ['storage', 'application', 'domain'],
  runtime: ['runtime', 'storage', 'adapters', 'application', 'domain'],
  adapters: ['adapters', 'application', 'domain'],
};
/** Composition-root modules are their own lanes with explicit import rules. */
const rootLanes = new Set(['main.ts', 'bootstrap.ts', 'config.ts', 'cli.ts']);
// AST-level invariant: domain/application describe the business model, not the
// Durable execution engine. Task definitions belong to runtime (agent-core.md #1/#10).
export function violations(path, source) {
  const lane = relative(root, path).split(sep)[0];
  const errors = [];
  if (!allowed[lane] && !rootLanes.has(lane)) errors.push(`unregistered architectural layer ${lane}`);
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  function check(spec) {
    if (typeof spec !== 'string') { errors.push('nonliteral module loading'); return; }
    if (/pi-coding-agent|deepseek-harness|@ag-ui/.test(spec) && !(spec.startsWith('@ag-ui/') && lane === 'api')) errors.push(`forbidden dependency ${spec}`);
    if (/^(?:file:|\/)/.test(spec)) errors.push('absolute module imports are not allowed');
    // The reference CLI is a standalone transport client: node builtins only, no internal/SDK imports.
    if (lane === 'cli.ts') {
      if (!spec.startsWith('node:')) errors.push(`cli.ts may only import node builtins (got ${spec})`);
      return;
    }
    if (!allowed[lane]) return;
    if (spec.startsWith('.')) {
      const target = relative(root, resolve(dirname(path), spec)).split(sep)[0];
      if (!allowed[lane].includes(target)) errors.push(`${lane} cannot import ${target}`);
    } else if (lane === 'domain' || lane === 'application') errors.push(`${lane} must be platform independent`);
    else if (spec.startsWith('@earendil-works/') && !['runtime', 'storage'].includes(lane)) errors.push(`SDK belongs in runtime/storage`);
  }
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) check(ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : undefined);
    if (ts.isImportEqualsDeclaration(node)) errors.push('import equals is not allowed');
    if (ts.isImportTypeNode(node)) check(ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal) ? node.argument.literal.text : undefined);
    if ((lane === 'domain' || lane === 'application') && ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'defineTask') errors.push(`${lane} must not define Durable tasks (found defineTask(...)); define tasks in runtime instead`);
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      check(node.arguments[0] && ts.isStringLiteral(node.arguments[0]) ? node.arguments[0].text : undefined);
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return errors;
}
async function files(dir) {
  const result = [];
  for (const entry of await readdir(dir, {withFileTypes: true})) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) result.push(...await files(path));
    else if (entry.name.endsWith('.ts')) result.push(path);
  }
  return result;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const errors = [];
  for (const file of await files(root)) for (const error of violations(file, await readFile(file, 'utf8'))) errors.push(`${relative(root, file)}: ${error}`);
  for (const path of ['package.json', 'apps/server/package.json']) {
    const json = JSON.parse(await readFile(path, 'utf8'));
    for (const [name, version] of Object.entries({...json.dependencies, ...json.devDependencies})) {
      if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) errors.push(`unlocked ${name}`);
      if (/pi-coding-agent|deepseek-harness/.test(name)) errors.push(`second engine ${name}`);
    }
  }
  if (errors.length) { process.stderr.write(errors.join('\n') + '\n'); process.exitCode = 1; }
  else process.stdout.write('Architecture boundaries passed\n');
}
