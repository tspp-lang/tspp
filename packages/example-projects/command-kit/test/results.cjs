// Adapt the public result unions for assertions in the command behavior tests.
function inspectParseResult(result) {
  switch (result._tag) {
    case 'Parsed': return { kind: 'parsed', invocation: result.invocation };
    case 'HelpRequested': return { kind: 'help', text: result.text };
    case 'VersionRequested': return { kind: 'version', text: result.text };
    case 'ParseFailed': return { kind: 'error', diagnostic: result.diagnostic };
    default: throw new Error(`Unexpected parse result: ${result._tag}`);
  }
}

function inspectDecodeResult(result) {
  switch (result._tag) {
    case 'Decoded': return { kind: 'decoded', value: result.value };
    case 'DecodeFailed': return { kind: 'error', message: result.message };
    default: throw new Error(`Unexpected decode result: ${result._tag}`);
  }
}

module.exports = { inspectParseResult, inspectDecodeResult };
