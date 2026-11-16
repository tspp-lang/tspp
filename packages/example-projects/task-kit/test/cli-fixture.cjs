const { runTaskCli, command } = require('../dist/index.js');
const path = require('node:path');
const [rootDir, ready] = process.argv.slice(2);
const messages = [];
process.on('message', signal => process.emit(signal));
runTaskCli({ root: { description: 'signal test', run: command(process.execPath, path.join(__dirname, 'process-fixture.cjs'), 'tree', ready) } }, {
  rootDir, argv: ['root'], gracefulTimeoutMs: 30000,
  logger: { log: text => messages.push(text), warn: text => messages.push(text) },
}).then(code => { process.send({ code, messages }); process.disconnect(); }, error => { process.send({ error: String(error) }); process.disconnect(); });
