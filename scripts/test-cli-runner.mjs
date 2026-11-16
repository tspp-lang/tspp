import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'packages/compiler/bin/tspp');
const compiler = path.join(root, 'packages/compiler/built/local/typescript.js');
const { TSPP_PLUGIN_API_VERSION } = createRequire(compiler)('@tspp/plugin-sdk');

function project(t, files) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tspp-runner-test-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    for (const [name, text] of Object.entries(files)) {
        const filename = path.join(directory, name);
        fs.mkdirSync(path.dirname(filename), { recursive: true });
        fs.writeFileSync(filename, typeof text === 'string' ? text : JSON.stringify(text));
    }
    return directory;
}

function run(directory, ...args) {
    return spawnSync(process.execPath, [cli, ...args], { cwd: directory, encoding: 'utf8', timeout: 60000 });
}

function success(result) {
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return result.stdout.trim();
}

test('help, version and explicit compiler mode', t => {
    const directory = project(t, { 'main.tspp': 'console.log("executed");' });
    assert.match(success(run(directory)), /tspp <file.tspp>/);
    assert.match(success(run(directory, '--help')), /--compile/);
    assert.match(success(run(directory, '--version')), /Version \d/);
    for (const args of [['-p', '.'], ['--noEmit'], ['--init']]) {
        const result = run(directory, ...args);
        assert.equal(result.status, 1);
        assert.match(result.stderr, /require --compile/);
    }
    assert.equal(success(run(directory, '--compile', 'main.tspp')), '');
    assert.ok(fs.existsSync(path.join(directory, 'main.js')));
    fs.unlinkSync(path.join(directory, 'main.js'));
    assert.equal(success(run(directory, '-c', 'main.tspp', '--noEmit')), '');
    assert.ok(!fs.existsSync(path.join(directory, 'main.js')));
});

test('CJS imports, require targets, native dependencies, argv and no emitted files', t => {
    const directory = project(t, {
        'main.tspp': `declare const process: any; declare function require(name: string): any;
import { value } from './dep.js';
import { other } from './other.ts';
const required = require('./required.tspp');
const native = require('./native.cjs');
console.log(JSON.stringify([value, other, required.answer, native, process.argv.slice(1)]));`,
        'dep.tspp': 'export const value: number = 40;',
        'other.ts': 'export const other: number = 1;',
        'required.tspp': 'export const answer: number = 2;',
        'native.cjs': 'module.exports = 3;',
    });
    const actual = JSON.parse(success(run(directory, 'main.tspp', 'hello world', '--compile', '-p')));
    assert.deepEqual(actual, [40, 1, 2, 3, [path.join(directory, 'main.tspp'), 'hello world', '--compile', '-p']]);
    assert.ok(!fs.existsSync(path.join(directory, 'main.js')));
    assert.ok(!fs.existsSync(path.join(directory, 'dep.js')));
});

test('ESM static and dynamic imports, CJS dependency and original import.meta.url', t => {
    const directory = project(t, {
        'package.json': { type: 'module' },
        'main.tspp': `import native from './native.cjs';
import { value } from './dep.js';
const lazy = await import('./lazy.tspp');
console.log(value + lazy.other + native, import.meta.url);`,
        'dep.tspp': 'export const value: number = 20;',
        'lazy.tspp': 'export const other: number = 22;',
        'native.cjs': 'module.exports = 0;',
        'native.d.cts': 'declare const value: number; export = value;',
    });
    assert.equal(success(run(directory, 'main.tspp')), `42 ${pathToFileURL(path.join(directory, 'main.tspp')).href}`);
});

test('configuration is found from entry and noEmit does not prevent execution', t => {
    const directory = project(t, {
        'tsppconfig.json': { compilerOptions: { target: 'es2022', module: 'commonjs', noEmit: true }, include: ['src'] },
        'src/main.tspp': 'console.log("config runs");',
    });
    assert.equal(success(run(os.tmpdir(), path.join(directory, 'src/main.tspp'))), 'config runs');
    assert.ok(!fs.existsSync(path.join(directory, 'src/main.js')));
});

test('type errors stop evaluation; runtime exit codes and original source locations survive', t => {
    const directory = project(t, {
        'bad.tspp': 'const value: number = "bad"; console.log("should never run");',
        'exit.tspp': 'declare const process: any; process.exitCode = 37;',
        'throw.tspp': 'const n: number = 1;\n\nthrow new Error("source-map-check");',
    });
    const bad = run(directory, 'bad.tspp');
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /TS2322/);
    assert.doesNotMatch(bad.stdout, /should never run/);
    assert.equal(run(directory, 'exit.tspp').status, 37);
    const thrown = run(directory, 'throw.tspp');
    assert.equal(thrown.status, 1);
    assert.match(thrown.stderr, /throw\.tspp:3:/);
});

test('configured asynchronous rebuilders and analyzers complete before execution', t => {
    const directory = project(t, {
        'tsppconfig.json': { compilerOptions: { target: 'es2022', module: 'commonjs', plugins: [{ name: 'runner-plugin', tspp: true }] } },
        'main.tspp': 'console.log("pipeline ran");',
        'node_modules/runner-plugin/package.json': { name: 'runner-plugin', main: 'index.cjs' },
        'node_modules/runner-plugin/index.cjs': `const fs = require('node:fs');
module.exports = {
manifest: { id: 'runner-test', version: '0.0.0', apiVersion: ${TSPP_PLUGIN_API_VERSION} },
facets: { compiler: { activate(context) {
context.compiler.registerProgramRebuilder({ id: 'async', async rebuild(program, request) {
if (!request.async) throw new Error('Async pipeline required');
await new Promise(resolve => setTimeout(resolve, 5));
fs.writeFileSync(require('node:path').join(program.getCurrentDirectory(), 'rebuilt'), 'yes');
} });
context.compiler.registerProgramAnalyzer({ id: 'async-analysis', async analyze(input) {
await new Promise(resolve => setTimeout(resolve, 5));
return [{ fileName: input.rootFileNames[0], start: 0, length: 1, category: 'error', code: 99001, message: 'runner analyzer stopped execution' }];
} });
} } }
};`,
    });
    const result = run(directory, 'main.tspp');
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr + result.stdout, /runner analyzer stopped execution/);
    assert.ok(fs.existsSync(path.join(directory, 'rebuilt')));
    assert.doesNotMatch(result.stdout, /pipeline ran/);
});

test('real asynchronous macro expansion executes its generated statements', t => {
    const directory = project(t, {
        'tsppconfig.json': { compilerOptions: { target: 'es2022', module: 'commonjs', strict: true, plugins: [{ name: 'ts-plus-plus/plugins/macros', tspp: true }] } },
        'main.tspp': fs.readFileSync(path.join(root, 'packages/examples/13-macros/src/03-async.tspp'), 'utf8'),
    });
    fs.symlinkSync(path.join(root, 'node_modules'), path.join(directory, 'node_modules'), 'junction');
    assert.match(success(run(directory, 'main.tspp')), /checkedAsyncName: 'Item'/);
});

test('release layout uses lib compiler with runtime helpers inside bin', t => {
    const directory = project(t, { 'main.tspp': 'console.log("release runner");' });
    const installed = path.join(directory, 'package');
    fs.cpSync(path.join(root, 'packages/compiler/bin'), path.join(installed, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(installed, 'lib'), { recursive: true });
    fs.symlinkSync(path.join(root, 'packages/compiler/node_modules'), path.join(installed, 'node_modules'), 'junction');
    for (const file of fs.readdirSync(path.dirname(compiler)).filter(file => /^(?:typescript\.js|lib\..*\.d\.ts)$/.test(file))) {
        fs.copyFileSync(path.join(path.dirname(compiler), file), path.join(installed, 'lib', file));
    }
    const result = spawnSync(process.execPath, [path.join(installed, 'bin/tspp'), 'main.tspp'], { cwd: directory, encoding: 'utf8', timeout: 60000 });
    assert.equal(success(result), 'release runner');
});
