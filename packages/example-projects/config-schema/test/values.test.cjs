const assert = require('node:assert/strict');
const { test } = require('node:test');
const { ByteSize, Duration, Port, formatIssue, of } = require('../dist/index.js');

const decodedText = (type, input) => {
  const decoded = type.decode(input);
  return decoded._tag === 'Valid' ? String(decoded.value) : decoded.issues.map(formatIssue).join('\n');
};

test('durations read units, combinations, decimals, and milliseconds', () => {
  assert.equal(Duration.decode('1h30m').value.milliseconds, 5_400_000);
  assert.equal(Duration.decode('1.5s').value.milliseconds, 1_500);
  assert.equal(Duration.decode('2d').value.seconds, 172_800);
  assert.equal(Duration.decode(250).value.milliseconds, 250);
  assert.equal(decodedText(Duration, '90m'), '1h30m');
  assert.equal(decodedText(Duration, '0ms'), '0s');
  assert.equal(decodedText(Duration, '1500ms'), '1s500ms');
  assert.equal(JSON.stringify({ timeout: Duration.milliseconds(30_000) }), '{"timeout":"30s"}');
});

test('durations reject other text, negative values, and fractions of a millisecond', () => {
  for (const input of ['30', '1 h', '-1s', '1.5ms', 'soon', -1, true]) {
    assert.match(decodedText(Duration, input), /^<root>: expected a whole number of milliseconds such as 500ms/u, String(input));
  }
  assert.throws(() => Duration.milliseconds(0.5), RangeError);
});

test('byte sizes distinguish decimal and binary units and compute exactly', () => {
  assert.equal(ByteSize.decode('10MiB').value.bytes, 10 * 2 ** 20);
  assert.equal(ByteSize.decode('10MB').value.bytes, 10_000_000);
  assert.equal(ByteSize.decode('1.1MB').value.bytes, 1_100_000);
  assert.equal(ByteSize.decode('512 kb').value.bytes, 512_000);
  assert.equal(ByteSize.decode(1024).value.bytes, 1024);
  assert.equal(decodedText(ByteSize, '2048KiB'), '2MiB');
  assert.equal(decodedText(ByteSize, '1500B'), '1500B');
  assert.equal(decodedText(ByteSize, '0'), '0B');
  for (const input of ['1.5B', '1.0000001KB', 'big', -1]) {
    assert.match(decodedText(ByteSize, input), /^<root>: expected a whole number of bytes/u, String(input));
  }
});

test('ports accept whole numbers from 0 to 65535, including digits from text', () => {
  assert.equal(Port.decode(8080).value.number, 8080);
  assert.equal(Port.decode('0').value.number, 0);
  assert.equal(JSON.stringify(Port.decode(443).value), '443');
  for (const input of [65_536, -1, 80.5, '80a', null]) {
    assert.match(decodedText(Port, input), /^<root>: expected a port from 0 to 65535/u, String(input));
  }
});

test('of turns a value class into a schema with its label', () => {
  const schema = of(Duration);
  assert.equal(schema.label, 'duration');
  assert.equal(schema.parse('5m').milliseconds, 300_000);
});
