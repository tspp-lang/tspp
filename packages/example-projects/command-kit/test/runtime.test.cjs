const test = require('node:test');
const assert = require('node:assert/strict');
const { Command, argument, text } = require('../dist/index.js');
const { CommandOutput } = require('../dist/runtime.js');
const { runNode } = require('../dist/node.js');

function capture(command, argv, action) {
  const stdout = [];
  const stderr = [];
  const code = runNode(command, action, {
    argv, env: {}, stdout: value => stdout.push(value), stderr: value => stderr.push(value),
  });
  return { code, stdout, stderr };
}

test('terminal handlers receive action output and the runner returns its status', () => {
  const file = argument('file', text());
  const command = new Command('inspect').argument(file);
  const result = capture(command, ['package.json'], invocation =>
    new CommandOutput(3, `Read ${invocation.get(file)}`, 'One warning'));
  assert.deepEqual(result, { code: 3, stdout: ['Read package.json'], stderr: ['One warning'] });
});

test('help and version bypass actions and use the supplied terminal handler', () => {
  const command = new Command('inspect').version('0.1.0').argument(argument('file', text()));
  const unexpectedAction = () => { throw new Error('Action should not run'); };
  const help = capture(command, ['--help'], unexpectedAction);
  assert.equal(help.code, 0);
  assert.equal(help.stderr.length, 0);
  assert.match(help.stdout.join(''), /Usage: inspect/);
  assert.deepEqual(capture(command, ['--version'], unexpectedAction), {
    code: 0, stdout: ['0.1.0'], stderr: [],
  });
});

test('usage errors return status 2 and do not call the application action', () => {
  const command = new Command('inspect').argument(argument('file', text()));
  const result = capture(command, [], () => { throw new Error('Action should not run'); });
  assert.equal(result.code, 2);
  assert.deepEqual(result.stdout, []);
  assert.match(result.stderr.join(''), /file/);
});

test('runner does not hide application exceptions', () => {
  assert.throws(() => capture(new Command('inspect'), [], () => {
    throw new Error('Unexpected application bug');
  }), /Unexpected application bug/);
});
