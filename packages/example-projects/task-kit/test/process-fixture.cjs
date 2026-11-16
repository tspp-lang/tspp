const fs = require('node:fs');
const { spawn } = require('node:child_process');
const [mode, ready, events, label] = process.argv.slice(2);
function announce(value) {
  fs.writeFileSync(ready + '.tmp', JSON.stringify(value));
  fs.renameSync(ready + '.tmp', ready);
}
if (mode === 'parallel') {
  const path = require('node:path');
  const watcher = fs.watch(path.dirname(ready), (_event, name) => {
    if (String(name) === 'release') {
      fs.appendFileSync(events, JSON.stringify({ label: label + '-end' }) + '\n');
      watcher.close();
    }
  });
  fs.appendFileSync(events, JSON.stringify({ label: label + '-start' }) + '\n');
  announce({});
} else if (mode === 'child') {
  setInterval(() => {}, 1000);
  process.send({ pid: process.pid });
  process.disconnect();
} else if (mode === 'tree' || mode === 'tree-failure') {
  const child = spawn(process.execPath, [__filename, 'child'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  child.once('message', value => {
    announce({ pid: process.pid, childPid: value.pid });
    if (mode === 'tree-failure') process.exit(7);
  });
  setInterval(() => {}, 1000);
} else {
  announce({ pid: process.pid });
  setInterval(() => {}, 1000);
}
