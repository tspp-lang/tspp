const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { PassThrough } = require('node:stream');
const { watch } = require('node:fs');
const { spawn } = require('node:child_process');
const {
  command, defineTasks, runTasks, prepareTasks, executePlan, runTaskCli, formatPlan,
  parseEnv, interpolateEnv, taskCandidates, searchTasks, saveLastTask, readLastTask, selectTask,
} = require('../dist/index.js');

function output() {
  const lines = [];
  return { lines, log: message => lines.push(message), warn: message => lines.push(message) };
}
async function workspace(t) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tspp-task-kit-'));
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  return rootDir;
}
function record(file, label, ...args) {
  return command(process.execPath, '-e', String.raw`require('node:fs').appendFileSync(process.argv[1], JSON.stringify({label:process.argv[2],args:process.argv.slice(3),cwd:process.cwd(),env:process.env.VALUE,phase:process.env.TASK_EXECUTION_PHASE})+'\n')`, file, label, ...args);
}
async function records(file) { return (await fs.readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line)); }
function readiness(t, file) {
  let watcher;
  let timer;
  const promise = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(Error('child readiness timeout')), 30000);
    watcher = watch(path.dirname(file), (event, name) => {
      if (String(name) !== path.basename(file)) return;
      watcher.close(); clearTimeout(timer);
      fs.readFile(file, 'utf8').then(text => resolve(JSON.parse(text)), reject);
    });
    watcher.once('error', reject);
  });
  t.after(() => { watcher.close(); clearTimeout(timer); });
  return promise;
}
function processExists(pid, readStat = pid => readFileSync(`/proc/${pid}/stat`, 'utf8')) {
  try { process.kill(pid, 0); } catch { return false; }
  if (process.platform !== 'linux') return true;
  try {
    // kill(pid, 0) also succeeds for an exited descendant awaiting reaping by its new parent.
    const stat = readStat(pid);
    const state = stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3);
    return state !== 'Z' && state !== 'X';
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

test('Linux process liveness rejects zombies while retaining running descendants', { skip: process.platform !== 'linux' }, () => {
  assert.equal(processExists(process.pid), true);
  for (const state of ['R', 'S', 'D', 'T']) {
    assert.equal(processExists(process.pid, pid => `${pid} (worker ) name) ${state} 1 2 3`), true, state);
  }
  for (const state of ['Z', 'X']) {
    assert.equal(processExists(process.pid, pid => `${pid} (worker ) name) ${state} 1 2 3`), false, state);
  }
});

test('serial dependencies, shared-task deduplication, command order and root argument forwarding', async t => {
  const rootDir = await workspace(t);
  const file = path.join(rootDir, 'events');
  const tasks = defineTasks({
    shared: { description: 'shared', run: record(file, 'shared'), public: false, forwardArgs: true },
    left: { description: 'left', dependencies: ['shared'], run: record(file, 'left') },
    right: { description: 'right', dependencies: ['shared'], run: record(file, 'right') },
    root: { description: 'root', dependencies: ['left', 'right'], forwardArgs: true, run: [record(file, 'first'), record(file, 'last', 'fixed')] },
  });
  const plan = await runTasks(tasks, 'root', { rootDir, args: ['--name', 'two words', '&'], logger: output() });
  const events = await records(file);
  assert.deepEqual(events.map(item => item.label), ['shared', 'left', 'right', 'first', 'last']);
  assert.deepEqual(events.map(item => item.args), [[], [], [], [], ['fixed', '--name', 'two words', '&']]);
  assert.ok(events.every(item => item.phase === 'execute'));
  assert.equal(plan.tasks.length, 4);
  assert.match(formatPlan(plan), /shared.*\(shared\)/);
});

test('parallel dependencies start together, with root executing after both complete', async t => {
  const rootDir = await workspace(t);
  const file = path.join(rootDir, 'events');
  const concurrent = label => command(process.execPath, path.join(__dirname, 'process-fixture.cjs'), 'parallel', path.join(rootDir, label + '-ready'), file, label);
  const aReady = readiness(t, path.join(rootDir, 'a-ready')); const bReady = readiness(t, path.join(rootDir, 'b-ready'));
  const work = runTasks({ root: { description: 'root', dependencyMode: 'parallel', dependencies: ['a', 'b'], run: record(file, 'root') }, a: { description: 'a', run: concurrent('a') }, b: { description: 'b', run: concurrent('b') } }, 'root', { rootDir, logger: output() });
  await Promise.all([aReady, bReady]); await fs.writeFile(path.join(rootDir, 'release'), 'go'); await work;
  const labels = (await records(file)).map(item => item.label);
  assert.deepEqual(labels.slice(0, 2).sort(), ['a-start', 'b-start']);
  assert.equal(labels.at(-1), 'root');
});

test('prepares the entire graph before commands; dependency preparers may generate arguments', async t => {
  const rootDir = await workspace(t);
  const file = path.join(rootDir, 'events');
  const prepared = [];
  const prepare = label => async context => {
    assert.equal(await fs.stat(file).then(() => true, () => false), false);
    assert.ok(Object.isFrozen(context)); assert.ok(Object.isFrozen(context.env)); assert.ok(Object.isFrozen(context.args));
    prepared.push([context.taskName, context.isRoot, context.args]);
    return { args: [label, ...context.args] };
  };
  await runTasks({ root: { description: 'root', dependencies: ['dep'], prepare: prepare('root-generated'), forwardArgs: true, run: [record(file, 'first'), record(file, 'root')] }, dep: { description: 'dep', prepare: prepare('dep-generated'), run: record(file, 'dep') } }, 'root', { rootDir, args: ['forwarded'], logger: output() });
  assert.deepEqual(prepared, [['root', true, ['forwarded']], ['dep', false, []]]);
  assert.deepEqual((await records(file)).map(item => [item.label, item.args]), [['dep', ['dep-generated']], ['first', []], ['root', ['root-generated', 'forwarded']]]);
});

test('all missing references and cycles are rejected before preparation, including unused tasks', async t => {
  const rootDir = await workspace(t);
  let prepared = 0;
  const root = { description: 'root', prepare: () => { prepared++; return { args: [] }; } };
  await assert.rejects(runTasks({ root, unused: { description: 'unused', dependencies: ['missing'] } }, 'root', { rootDir }), /unknown task 'missing'/);
  await assert.rejects(runTasks({ root, a: { description: 'a', dependencies: ['b'] }, b: { description: 'b', dependencies: ['a'] } }, 'root', { rootDir }), /Circular.*a -> b -> a/);
  await assert.rejects(runTasks({ root }, 'missing', { rootDir }), /Unknown task/);
  assert.equal(prepared, 0);
});

test('preparation rejection prevents every command in the graph', async t => {
  const rootDir = await workspace(t); const file = path.join(rootDir, 'events');
  await assert.rejects(runTasks({ root: { description: 'root', dependencies: ['ok', 'bad'] }, ok: { description: 'ok', run: record(file, 'unreachable') }, bad: { description: 'bad', prepare: () => { throw Error('invalid selection'); } } }, 'root', { rootDir, logger: output() }), /invalid selection/);
  assert.equal(await fs.stat(file).then(() => true, () => false), false);
});

test('prepared plans retain immutable definitions, arguments and resolved environment', async t => {
  const rootDir = await workspace(t); const file = path.join(rootDir, 'events');
  await fs.writeFile(path.join(rootDir, '.env'), 'VALUE=original\n');
  const tasks = { root: { description: 'root', envFile: '.env', forwardArgs: true, run: record(file, 'original') } };
  const args = ['original'];
  const plan = await prepareTasks(tasks, 'root', { rootDir, args });
  tasks.root.run = record(file, 'changed'); args.push('changed');
  await fs.writeFile(path.join(rootDir, '.env'), 'VALUE=changed\n');
  assert.ok(Object.isFrozen(plan)); assert.ok(Object.isFrozen(plan.tasks)); assert.ok(Object.isFrozen(plan.tasks[0]));
  assert.ok(Object.isFrozen(plan.tasks[0].commands[0].args));
  await executePlan(plan, { logger: output() });
  const [event] = await records(file);
  assert.equal(event.label, 'original'); assert.equal(event.env, 'original'); assert.deepEqual(event.args, ['original']);
});

test('dry-run skips missing environment files, loaders, required files, and preparation', async t => {
  const rootDir = await workspace(t); const logger = output();
  const plan = await runTasks({ root: { description: 'root', envFile: 'missing.env', requireEnvFile: true, prepare: () => { throw Error('must not prepare'); }, run: command('missing-binary') } }, 'root', { rootDir, envFile: 'override.env', dryRun: true, loadEnvFile: () => { throw Error('must not load'); }, logger });
  assert.equal(plan.prepared, false); assert.match(logger.lines.join('\n'), /env: override.env/);
  await assert.rejects(executePlan(plan), /unprepared preview/);
  await runTasks({ root: { description: 'root', requireEnvFile: true } }, 'root', { rootDir, dryRun: true, logger });
});

test('prepare-only collects arguments and displays commands without executing', async t => {
  const rootDir = await workspace(t); const file = path.join(rootDir, 'events'); const logger = output();
  const plan = await runTasks({ root: { description: 'root', prepare: () => ({ args: ['two words'] }), run: record(file, 'never') } }, 'root', { rootDir, prepareOnly: true, logger });
  assert.equal(plan.prepared, true); assert.match(logger.lines.join('\n'), /"two words"/);
  assert.equal(await fs.stat(file).then(() => true, () => false), false);
});

test('dotenv supports empty values, comments, export, multiline quotes, escapes and CRLF', () => {
  assert.deepEqual({ ...parseEnv('EMPTY=\r\nNEXT=value\r\nALSO=\nexport LAST = "quoted # value" # comment\nSINGLE=\'line1\nline2\'\nESC="one\\ntwo"\nPLAIN=hello # comment\n') }, { EMPTY: '', NEXT: 'value', ALSO: '', LAST: 'quoted # value', SINGLE: 'line1\nline2', ESC: 'one\ntwo', PLAIN: 'hello' });
});

test('environment interpolation supports forward references/inheritance and rejects cycles/missing variables', () => {
  assert.deepEqual(interpolateEnv({ END: '${BASE}/${FORWARD}', FORWARD: 'value' }, { BASE: 'inherited' }), { BASE: 'inherited', END: 'inherited/value', FORWARD: 'value' });
  assert.throws(() => interpolateEnv({ A: '${B}', B: '${A}' }, {}), /circular.*A -> B -> A/);
  assert.throws(() => interpolateEnv({ A: '${MISSING}' }, {}), /undefined variable 'MISSING'/);
});

test('explicit environment overrides task files, custom loaders resolve from rootDir and task env wins', async t => {
  const rootDir = await workspace(t); const requests = [];
  const plan = await prepareTasks({ root: { description: 'root', envFile: 'ignored', env: { VALUE: 'override' }, dependencies: ['dep'] }, dep: { description: 'dep', envFile: 'also-ignored' } }, 'root', { rootDir, env: { BASE: 'inherited' }, envFile: 'encrypted.env', loadEnvFile: context => { requests.push(context); return 'VALUE=${BASE}\nFORWARD=${LATER}\nLATER=resolved'; } });
  assert.equal(requests.length, 1); assert.equal(requests[0].filePath, path.join(rootDir, 'encrypted.env'));
  assert.equal(plan.tasks[1].env.VALUE, 'override'); assert.equal(plan.tasks[1].env.FORWARD, 'resolved');
  assert.equal(plan.tasks[1].env.PROJECT_ROOT_DIR, rootDir); assert.equal(plan.tasks[1].env.ENV_FILE_PATH, 'encrypted.env');
});

test('requires an environment file for executable graphs, including dependencies', async t => {
  const rootDir = await workspace(t);
  await assert.rejects(prepareTasks({ root: { description: 'root', dependencies: ['dep'] }, dep: { description: 'dep', requireEnvFile: true } }, 'root', { rootDir, env: {} }), /requires an environment file/);
});

test('shared dependencies reject conflicting environment contexts before any preparation', async t => {
  const rootDir = await workspace(t); let count = 0;
  await assert.rejects(prepareTasks({ root: { description: 'root', dependencies: ['a', 'b'], prepare: () => { count++; return { args: [] }; } }, a: { description: 'a', env: { VALUE: 'a' }, dependencies: ['shared'] }, b: { description: 'b', env: { VALUE: 'b' }, dependencies: ['shared'] }, shared: { description: 'shared' } }, 'root', { rootDir }), /shared.*conflicting environments/);
  assert.equal(count, 0);
});

test('task working directories resolve against explicit rootDir', async t => {
  const rootDir = await workspace(t); const file = path.join(rootDir, 'events');
  await fs.mkdir(path.join(rootDir, 'sub'));
  await runTasks({ root: { description: 'root', cwd: 'sub', run: record(file, 'cwd') } }, 'root', { rootDir, logger: output() });
  assert.equal((await records(file))[0].cwd, path.join(rootDir, 'sub'));
});

test('search ranks exact/name/initial/description matches and requires all words', () => {
  const tasks = { 'public:docker:local': { description: 'Publish local image', details: 'Ship the docker image' }, 'test:unit': { description: 'Run unit tests' }, hidden: { description: 'hidden', public: false } };
  const candidates = taskCandidates(tasks);
  assert.equal(candidates.length, 2);
  assert.equal(searchTasks(candidates, '', 'test:unit')[0].value, 'test:unit');
  for (const query of ['public:docker:local', 'public', 'docker', 'pubdocker', 'pdl', 'pdkr', 'image', 'docker local']) assert.equal(searchTasks(candidates, query)[0]?.value, 'public:docker:local', query);
  assert.equal(searchTasks(candidates, 'docker tests').length, 0);
  assert.equal(taskCandidates(tasks, true).length, 3);
  assert.match(candidates[0].description, /Dependencies/);
});

test('selection history accepts missing/corrupt data and remembers last selection', async t => {
  const rootDir = await workspace(t); const file = path.join(rootDir, 'cache', 'selected.json');
  assert.equal(await readLastTask(file), undefined);
  await saveLastTask(file, 'test:unit'); assert.equal(await readLastTask(file), 'test:unit');
  await fs.writeFile(file, 'bad json'); assert.equal(await readLastTask(file), undefined);
  await fs.writeFile(file, '{"lastTask":32}'); assert.equal(await readLastTask(file), undefined);
  await saveLastTask(rootDir, 'ignored-error');
});

test('command-kit CLI handles help/list/list-all, parser errors, env options and forwarded arguments', async t => {
  const rootDir = await workspace(t); const file = path.join(rootDir, 'events'); const logger = output();
  const tasks = { root: { description: 'root', forwardArgs: true, run: record(file, 'root') }, hidden: { description: 'internal', public: false } };
  assert.equal(await runTaskCli(tasks, { rootDir, argv: ['--help'], logger }), 0); assert.match(logger.lines.join('\n'), /Usage:/);
  logger.lines.length = 0;
  assert.equal(await runTaskCli(tasks, { rootDir, argv: ['--list'], logger }), 0); assert.deepEqual(logger.lines, ['root: root']);
  logger.lines.length = 0;
  assert.equal(await runTaskCli(tasks, { rootDir, argv: ['--list-all'], logger }), 0); assert.equal(logger.lines.length, 2);
  for (const argv of [['--unknown'], ['--env'], ['root', 'hidden']]) assert.equal(await runTaskCli(tasks, { rootDir, argv, logger }), 2);
  assert.equal(await runTaskCli(tasks, { rootDir, argv: ['missing'], logger }), 1);
  await fs.writeFile(path.join(rootDir, '.env'), 'VALUE=cli');
  assert.equal(await runTaskCli(tasks, { rootDir, argv: ['root', '--env=.env', '--', '--not-a-runner-option', 'two words'], logger }), 0);
  const [event] = await records(file); assert.equal(event.env, 'cli'); assert.deepEqual(event.args, ['--not-a-runner-option', 'two words']);
});

test('CLI interactive selector receives public candidates/history and persists selected task before execution', async t => {
  const rootDir = await workspace(t); const cacheFile = path.join(rootDir, 'history'); const logger = output();
  await saveLastTask(cacheFile, 'root');
  assert.equal(await runTaskCli({ root: { description: 'root' }, hidden: { description: 'hidden', public: false } }, { rootDir, argv: [], cacheFile, logger, selectTask: async options => { assert.equal(options.lastTask, 'root'); assert.equal(options.candidates.length, 1); return 'root'; } }), 0);
  assert.equal(await readLastTask(cacheFile), 'root');
  assert.equal(await runTaskCli({ root: { description: 'root' } }, { rootDir, argv: [], logger, selectTask: async () => undefined }), 0);
});

test('interactive search filters, arrow-selects, shows details and restores terminal state', async () => {
  const input = new PassThrough(); input.isTTY = true; input.isRaw = false; input.setRawMode = value => { input.isRaw = value; return input; };
  const terminal = new PassThrough(); terminal.isTTY = true; terminal.columns = 100; terminal.rows = 40;
  let text = ''; terminal.on('data', chunk => { text += chunk; });
  const selection = selectTask({ candidates: taskCandidates({ alpha: { description: 'alpha' }, beta: { description: 'beta', details: 'full beta details' }, 'beta:two': { description: 'another beta' } }), input, output: terminal });
  input.emit('keypress', 'b', { name: 'b' }); input.emit('keypress', undefined, { name: 'down' }); input.emit('keypress', undefined, { name: 'return' });
  assert.equal(await selection, 'beta:two'); assert.equal(input.isRaw, false); assert.match(text, /full beta details/); assert.match(text, /Search tasks: b/);
  assert.equal(input.isPaused(), true);
});

test('non-interactive selection fails clearly; already aborted runs do not prepare', async t => {
  const rootDir = await workspace(t); const controller = new AbortController(); controller.abort(Error('stop requested'));
  await assert.rejects(runTasks({ root: { description: 'root', prepare: () => { throw Error('unreachable'); } } }, 'root', { rootDir, signal: controller.signal }), /stop requested/);
  const input = new PassThrough(); input.isTTY = false;
  await assert.rejects(selectTask({ candidates: [], input }), /Non-interactive/);
});

test('spawn failures stop dependent commands and remove CLI signal listeners', async t => {
  const rootDir = await workspace(t); const file = path.join(rootDir, 'events');
  const before = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
  assert.equal(await runTaskCli({ root: { description: 'root', dependencies: ['bad'], run: record(file, 'never') }, bad: { description: 'bad', run: command('task-kit-does-not-exist-928743') } }, { rootDir, argv: ['root'], logger: output(), gracefulTimeoutMs: 100 }), 1);
  assert.deepEqual([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')], before);
  assert.equal(await fs.stat(file).then(() => true, () => false), false);
});

test('cancellation terminates owned processes and leaves independent executions running', { timeout: 60000 }, async t => {
  const rootDir = await workspace(t); const controller = new AbortController();
  const readyFile = path.join(rootDir, 'ready'); const ready = readiness(t, readyFile);
  const cancelled = runTasks({ root: { description: 'cancelled', run: command(process.execPath, path.join(__dirname, 'process-fixture.cjs'), 'tree', readyFile) } }, 'root', { rootDir, signal: controller.signal, gracefulTimeoutMs: 100, logger: output() });
  const rejected = assert.rejects(cancelled, /user cancellation/);
  const file = path.join(rootDir, 'independent');
  const independent = runTasks({ root: { description: 'independent', run: command(process.execPath, '-e', 'setTimeout(()=>require("node:fs").writeFileSync(process.argv[1],"finished"),400)', file) } }, 'root', { rootDir, logger: output() });
  const pids = await ready;
  controller.abort(Error('user cancellation'));
  await rejected; await independent;
  assert.equal(processExists(pids.pid), false); assert.equal(processExists(pids.childPid), false);
  assert.equal(await fs.readFile(file, 'utf8'), 'finished');
});

test('parallel command failure cancels and settles its running sibling before returning', { timeout: 60000 }, async t => {
  const rootDir = await workspace(t); const file = path.join(rootDir, 'ready'); const ready = readiness(t, file);
  const trigger = path.join(rootDir, 'trigger');
  const failure = command(process.execPath, '-e', 'const fs=require("node:fs"); const [dir,name]=process.argv.slice(1);const watcher=fs.watch(dir,(_event,file)=>{if(String(file)===name){watcher.close();process.exit(9)}});fs.writeFileSync(dir+"/failure-ready.tmp","{}");fs.renameSync(dir+"/failure-ready.tmp",dir+"/failure-ready")', rootDir, 'trigger');
  const failureReady = readiness(t, path.join(rootDir, 'failure-ready'));
  const work = runTasks({ root: { description: 'root', dependencyMode: 'parallel', dependencies: ['failure', 'slow'] }, failure: { description: 'failure', run: failure }, slow: { description: 'slow', run: command(process.execPath, path.join(__dirname, 'process-fixture.cjs'), 'long', file) } }, 'root', { rootDir, gracefulTimeoutMs: 100, logger: output() });
  const rejected = assert.rejects(work, /exit 9/);
  const [pids] = await Promise.all([ready, failureReady]);
  await fs.writeFile(trigger, 'fail');
  await rejected;
  assert.equal(processExists(pids.pid), false);
});

test('a failed parent cannot leave a live descendant behind', { timeout: 60000 }, async t => {
  const rootDir = await workspace(t); const file = path.join(rootDir, 'ready'); const ready = readiness(t, file);
  const work = runTasks({ root: { description: 'failed parent', run: command(process.execPath, path.join(__dirname, 'process-fixture.cjs'), 'tree-failure', file) } }, 'root', { rootDir, gracefulTimeoutMs: 100, logger: output() });
  const rejected = assert.rejects(work, /exit 7/);
  const pids = await ready; await rejected;
  assert.equal(processExists(pids.pid), false); assert.equal(processExists(pids.childPid), false);
});

test('CLI programmatic dryRun/prepareOnly defaults never execute commands', async t => {
  const rootDir = await workspace(t); const file = path.join(rootDir, 'events');
  const tasks = { root: { description: 'root', run: record(file, 'never') } };
  assert.equal(await runTaskCli(tasks, { rootDir, argv: ['root'], dryRun: true, logger: output() }), 0);
  assert.equal(await runTaskCli(tasks, { rootDir, argv: ['root'], prepareOnly: true, logger: output() }), 0);
  assert.equal(await fs.stat(file).then(() => true, () => false), false);
});

test('CLI second SIGINT escalates immediately, kills its process tree and returns 130', { timeout: 60000 }, async t => {
  const rootDir = await workspace(t); const file = path.join(rootDir, 'ready'); const ready = readiness(t, file);
  const cli = spawn(process.execPath, [path.join(__dirname, 'cli-fixture.cjs'), rootDir, file], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  t.after(() => cli.kill());
  const result = new Promise((resolve, reject) => { cli.once('message', resolve); cli.once('error', reject); });
  const pids = await ready;
  cli.send('SIGINT'); cli.send('SIGINT');
  const outcome = await result;
  assert.equal(outcome.code, 130); assert.match(outcome.messages.join('\n'), /Repeated signal/);
  assert.equal(processExists(pids.pid), false); assert.equal(processExists(pids.childPid), false);
});

test('Windows command shims preserve arguments containing spaces and shell characters', { skip: process.platform !== 'win32' }, async t => {
  const rootDir = await workspace(t); const file = path.join(rootDir, 'args.json');
  const script = path.join(rootDir, 'record.cjs');
  await fs.writeFile(script, 'require("node:fs").writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)))');
  const shim = path.join(rootDir, 'record.cmd');
  await fs.writeFile(shim, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
  const args = ['two words', 'x&y', 'a|b', '(value)', '"quoted"'];
  await runTasks({ root: { description: 'cmd shim', run: command(shim, file), forwardArgs: true } }, 'root', { rootDir, args, logger: output() });
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), args);
});
