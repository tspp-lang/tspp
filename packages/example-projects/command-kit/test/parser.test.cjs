const test = require('node:test');
const assert = require('node:assert/strict');
const {
  Command,
  flag,
  option,
  argument,
  optionalArgument,
  variadicArgument,
  text,
  integer,
  choice,
  customCodec,
  Decoded,
  DecodeFailed,
  formatDiagnostic,
} = require('../dist/index.js');
const { inspectParseResult, inspectDecodeResult } = require('./results.cjs');

function parsed(command, argv, options) {
  const result = inspectParseResult(command.parse(argv, options));
  assert.equal(result.kind, 'parsed', result.kind === 'error' ? formatDiagnostic(result.diagnostic) : result.kind);
  return result.invocation;
}

function failed(command, argv, options) {
  const result = inspectParseResult(command.parse(argv, options));
  assert.equal(result.kind, 'error');
  assert.ok(formatDiagnostic(result.diagnostic).length > 0);
  return result.diagnostic;
}

test('long options, aliases, equals values, and typed handles', () => {
  const verbose = flag('verbose', { short: 'v' });
  const port = option('port', integer(), { short: 'p' }).required();
  const name = argument('name', text());
  const cli = new Command('serve').option(verbose).option(port).argument(name);
  const result = parsed(cli, ['-v', '--port=8080', 'web']);
  assert.equal(result.get(verbose), true);
  assert.equal(result.get(port), 8080);
  assert.equal(result.get(name), 'web');
  assert.equal(parsed(cli, ['-p', '9090', 'api']).get(port), 9090);
});

test('short flag groups and negated flags have predictable values', () => {
  const verbose = flag('verbose', { short: 'v' });
  const quiet = flag('quiet', { short: 'q' });
  const cli = new Command('check').option(verbose).option(quiet);
  const result = parsed(cli, ['-vq', '--no-verbose']);
  assert.equal(result.get(verbose), false);
  assert.equal(result.get(quiet), true);
  assert.equal(parsed(cli, []).get(verbose), false);
});

test('negative option values and the end-of-options separator', () => {
  const offset = option('offset', integer()).required();
  const file = argument('file', text());
  const cli = new Command('shift').option(offset).argument(file);
  const result = parsed(cli, ['--offset', '-12', '--', '--draft.md']);
  assert.equal(result.get(offset), -12);
  assert.equal(result.get(file), '--draft.md');
});

test('required, optional, and variadic positional arguments', () => {
  const file = argument('file', text());
  const destination = optionalArgument('destination', text());
  const cli = new Command('copy').argument(file).argument(destination);
  assert.equal(parsed(cli, ['in.txt']).get(destination), undefined);
  assert.equal(parsed(cli, ['in.txt', 'out.txt']).get(destination), 'out.txt');
  failed(cli, []);
  failed(cli, ['in.txt', 'out.txt', 'extra']);

  const files = variadicArgument('files', text());
  const batch = new Command('batch').argument(files);
  assert.deepEqual(parsed(batch, []).get(files), []);
  assert.deepEqual(parsed(batch, ['one', 'two']).get(files), ['one', 'two']);

  const requiredFiles = variadicArgument('files', text(), { minCount: 1 });
  const requiredBatch = new Command('batch').argument(requiredFiles);
  failed(requiredBatch, []);
  assert.deepEqual(parsed(requiredBatch, ['one']).get(requiredFiles), ['one']);
});

test('command line values take precedence over environment and defaults', () => {
  const port = option('port', integer(), { env: 'APP_PORT' }).withDefault(3000);
  const cli = new Command('serve').option(port);
  assert.equal(parsed(cli, [], { env: {} }).get(port), 3000);
  assert.equal(parsed(cli, [], { env: { APP_PORT: '4000' } }).get(port), 4000);
  assert.equal(parsed(cli, ['--port', '5000'], { env: { APP_PORT: '4000' } }).get(port), 5000);
  failed(cli, [], { env: { APP_PORT: 'oops' } });
});

test('required options, invalid choices, missing values, and unknown flags produce diagnostics', () => {
  const mode = option('mode', choice(['fast', 'safe'])).required();
  const cli = new Command('run').option(mode);
  failed(cli, []);
  failed(cli, ['--mode']);
  failed(cli, ['--mode', 'unsafe']);
  failed(cli, ['--mode', 'fast', '--typo']);
  assert.equal(parsed(cli, ['--mode=safe']).get(mode), 'safe');
});

test('codecs report invalid integers without truncation or coercion', () => {
  const codec = integer();
  assert.deepEqual(inspectDecodeResult(codec.decode('-42')), { kind: 'decoded', value: -42 });
  for (const raw of ['', '1.5', '12px', '1e3', '9007199254740992']) {
    const result = inspectDecodeResult(codec.decode(raw));
    assert.equal(result.kind, 'error', raw);
    assert.equal(typeof result.message, 'string');
    assert.ok(result.message.length > 0);
  }
});

test('custom codecs preserve typed values and return user-facing errors', () => {
  const codec = customCodec('coordinate', (raw) => {
    const match = /^(\d+),(\d+)$/.exec(raw);
    return match ? Decoded({ x: Number(match[1]), y: Number(match[2]) }) : DecodeFailed('expected x,y');
  });
  const point = option('point', codec).required();
  const cli = new Command('plot').option(point);
  assert.deepEqual(parsed(cli, ['--point', '3,4']).get(point), { x: 3, y: 4 });
  const diagnostic = failed(cli, ['--point', 'oops']);
  assert.match(formatDiagnostic(diagnostic), /expected x,y/);
});

test('subcommands accept inherited options before and after their names', () => {
  const verbose = flag('verbose', { short: 'v' });
  const output = option('output', text(), { short: 'o' }).required();
  const child = new Command('build', 'Build the project').option(output);
  const root = new Command('tool').option(verbose).command(child);
  for (const argv of [['-v', 'build', '-o', 'dist'], ['build', '-v', '-o', 'dist']]) {
    const result = parsed(root, argv);
    assert.equal(result.command, child);
    assert.deepEqual(result.path, ['tool', 'build']);
    assert.equal(result.get(verbose), true);
    assert.equal(result.get(output), 'dist');
  }
  failed(root, ['build']);
  failed(root, ['unknown']);
});

test('nested subcommands retain the full command path', () => {
  const leaf = new Command('list');
  const root = new Command('tool').command(new Command('cache').command(leaf));
  const result = parsed(root, ['cache', 'list']);
  assert.equal(result.command, leaf);
  assert.deepEqual(result.path, ['tool', 'cache', 'list']);
});

test('help and version are returned as data before required-value validation', () => {
  const token = option('token', text()).required();
  const root = new Command('tool', 'An example CLI').version('1.2.3').option(token);
  const help = inspectParseResult(root.parse(['--help']));
  assert.equal(help.kind, 'help');
  assert.match(help.text, /tool/);
  assert.match(help.text, /--token/);
  const shortHelp = inspectParseResult(root.parse(['-h']));
  assert.equal(shortHelp.kind, 'help');
  const version = inspectParseResult(root.parse(['--version']));
  assert.equal(version.kind, 'version');
  assert.match(version.text, /1\.2\.3/);
});

test('child help describes the selected command and inherited options', () => {
  const root = new Command('tool').option(flag('verbose', { short: 'v' }));
  root.command(new Command('build', 'Compile sources').option(option('output', text()).required()));
  const help = inspectParseResult(root.parse(['build', '--help']));
  assert.equal(help.kind, 'help');
  assert.match(help.text, /build/);
  assert.match(help.text, /--output/);
  assert.match(help.text, /--verbose/);
});

test('parsing is repeatable and earlier invocations keep their own values', () => {
  const verbose = flag('verbose');
  const files = variadicArgument('files', text());
  const cli = new Command('tool').option(verbose).argument(files);
  const first = parsed(cli, ['--verbose', 'one']);
  const second = parsed(cli, ['two']);
  assert.equal(first.get(verbose), true);
  assert.deepEqual(first.get(files), ['one']);
  assert.equal(second.get(verbose), false);
  assert.deepEqual(second.get(files), ['two']);
  const argv = ['--verbose', 'three'];
  parsed(cli, argv);
  assert.deepEqual(argv, ['--verbose', 'three']);
  assert.throws(() => first.get(flag('foreign')));
});

test('usage mistakes return diagnostics and never call process.exit', () => {
  const exit = process.exit;
  process.exit = () => { throw new Error('The parser called process.exit'); };
  try {
    failed(new Command('tool'), ['--unknown']);
    failed(new Command('tool').argument(argument('file', text())), []);
  } finally {
    process.exit = exit;
  }
});

test('ambiguous command definitions fail when they are configured', () => {
  assert.throws(() => new Command('tool').option(flag('verbose')).option(flag('verbose')));
  assert.throws(() => new Command('tool').option(flag('verbose', { short: 'v' })).option(flag('version', { short: 'v' })));
  assert.throws(() => new Command('tool').command(new Command('build')).command(new Command('build')));
  assert.throws(() => new Command('tool').argument(variadicArgument('files', text())).argument(argument('extra', text())));
  assert.throws(() => new Command('tool').argument(argument('file', text())).command(new Command('build')));
  assert.throws(() => new Command('tool').command(new Command('build')).argument(argument('file', text())));
});

test('value options support attached short values and terminate a flag group', () => {
  const verbose = flag('verbose', { short: 'v' });
  const port = option('port', integer(), { short: 'p' }).required();
  const cli = new Command('serve').option(verbose).option(port);
  assert.equal(parsed(cli, ['-p8080']).get(port), 8080);
  const grouped = parsed(cli, ['-vp=9090']);
  assert.equal(grouped.get(verbose), true);
  assert.equal(grouped.get(port), 9090);
  assert.equal(parsed(cli, ['--port', '3000', '-p4000']).get(port), 4000);
});

test('empty strings are values and explicit values override invalid environment values', () => {
  const label = option('label', text(), { env: 'APP_LABEL' }).withDefault('untitled');
  const port = option('port', integer(), { env: 'APP_PORT' }).withDefault(3000);
  const cli = new Command('serve').option(label).option(port);
  assert.equal(parsed(cli, ['--label=']).get(label), '');
  assert.equal(parsed(cli, ['--label', '']).get(label), '');
  assert.equal(parsed(cli, [], { env: { APP_LABEL: '' } }).get(label), '');
  assert.equal(parsed(cli, ['--port=8080'], { env: { APP_PORT: 'invalid' } }).get(port), 8080);
  failed(cli, [], { env: { APP_PORT: '' } });
});

test('literal dash and negative numbers are positional values', () => {
  const file = argument('file', text());
  const single = new Command('cat').argument(file);
  assert.equal(parsed(single, ['-']).get(file), '-');
  const offset = argument('offset', integer());
  assert.equal(parsed(new Command('shift').argument(offset), ['-25']).get(offset), -25);
});

test('flags decode environment values while command-line flags take precedence', () => {
  const verbose = flag('verbose', { env: 'VERBOSE', default: true });
  const cli = new Command('tool').option(verbose);
  assert.equal(parsed(cli, [], { env: {} }).get(verbose), true);
  assert.equal(parsed(cli, [], { env: { VERBOSE: '0' } }).get(verbose), false);
  assert.equal(parsed(cli, [], { env: { VERBOSE: 'true' } }).get(verbose), true);
  assert.equal(parsed(cli, ['--no-verbose'], { env: { VERBOSE: 'true' } }).get(verbose), false);
  failed(cli, [], { env: { VERBOSE: 'perhaps' } });
  failed(cli, ['--verbose=true']);
});

test('only the selected command contributes required options', () => {
  const root = new Command('tool');
  const build = new Command('build');
  const publish = new Command('publish').option(option('token', text()).required());
  root.command(build).command(publish);
  assert.equal(parsed(root, ['build']).command, build);
  failed(root, ['publish']);
});

test('reserved spellings and invalid definitions are rejected', () => {
  for (const name of ['help', 'version', 'no-color', '', '--verbose', 'has space']) {
    assert.throws(() => flag(name), name);
  }
  for (const short of ['h', 'V', 'vv', '1', '-']) {
    assert.throws(() => flag('verbose', { short }), short);
  }
  assert.throws(() => new Command(''));
  assert.throws(() => option('port', integer(), { env: 'APP-PORT' }));
  assert.throws(() => variadicArgument('files', text(), { minCount: -1 }));
  assert.throws(() => variadicArgument('files', text(), { minCount: 1.5 }));
  assert.throws(() => choice([]));
  assert.throws(() => choice(['same', 'same']));
  assert.throws(() => new Command('tool').argument(optionalArgument('optional', text())).argument(argument('required', text())));
});

test('failed ancestor option registration rolls back without corrupting children', () => {
  const childFlag = flag('verbose', { short: 'v' });
  const child = new Command('build').option(childFlag);
  const root = new Command('tool').command(child);
  assert.throws(() => root.option(flag('verbose')));
  assert.throws(() => root.option(flag('version-info', { short: 'v' })));
  assert.equal(root.options.length, 0);
  assert.equal(parsed(root, ['build', '-v']).get(childFlag), true);
  const quiet = flag('quiet', { short: 'q' });
  root.option(quiet);
  assert.equal(parsed(root, ['-q', 'build']).get(quiet), true);
});

test('failed child registration rolls back ownership and command trees remain acyclic', () => {
  const root = new Command('tool').option(flag('verbose'));
  const child = new Command('build').option(flag('verbose'));
  assert.throws(() => root.command(child));
  assert.equal(root.commands.length, 0);
  assert.equal(child.parent, undefined);
  const other = new Command('other').command(child);
  assert.equal(parsed(other, ['build']).command, child);
  assert.throws(() => root.command(child));
  assert.throws(() => child.command(other));
  assert.throws(() => root.command(root));
});
