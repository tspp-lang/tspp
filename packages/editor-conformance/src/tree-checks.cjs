// The syntax tree of a TS++ file has the shape services rely on, whatever plugins put in it and however broken the text is.
// Parsing is synchronous and plugin code can loop, so each file is parsed in a worker that can be stopped from outside.
const path = require("node:path");
const { Worker } = require("node:worker_threads");
const { finding } = require("./findings.cjs");
const { mutationPoints, describeMutation } = require("./tree-mutations.cjs");

const parseLimitMs = 20_000;
const parseLimitMb = 512;

/** Runs the worker from one mutation on; settles with where it stopped, if it had to be stopped. */
function runFrom(project, source, points, startIndex, onViolation) {
  return new Promise(resolve => {
    const worker = new Worker(path.join(__dirname, "tree-worker.cjs"), {
      workerData: { root: project.root, file: source.file, text: source.text, points, startIndex },
      resourceLimits: { maxOldGenerationSizeMb: parseLimitMb },
    });
    let current = startIndex;
    let timer;
    const settle = result => {
      clearTimeout(timer);
      worker.removeAllListeners();
      worker.on("error", () => undefined);
      void worker.terminate();
      resolve(result);
    };
    const watch = () => {
      clearTimeout(timer);
      timer = setTimeout(() => settle({ stoppedAt: current, reason: `no result after ${parseLimitMs / 1000}s` }), parseLimitMs);
    };
    watch();
    worker.on("message", message => {
      if (message.index !== undefined) {
        current = message.index;
        watch();
      }
      else if (message.violation) onViolation(message.violation, points[current]);
      else if (message.done) settle({});
    });
    worker.on("error", error => settle({ stoppedAt: current, reason: error.code === "ERR_WORKER_OUT_OF_MEMORY" ? `used over ${parseLimitMb} MB` : `threw ${error.message.split("\n")[0]}` }));
    worker.on("exit", () => settle({ stoppedAt: current, reason: "the worker exited" }));
  });
}

/** Every parse of a file ends, and every tree it gives has ranges that nest and go in source order. */
async function checkTree(project, source) {
  const { relative, text } = source;
  const points = mutationPoints(text);
  const findings = [];
  const seen = new Set();
  const report = (rule, point, message) => {
    const key = `${rule} ${message.replace(/\d+/g, "N")}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push(finding(rule, relative, text, point.at, `${message} (${describeMutation(text, point)})`));
  };
  let index = 0;
  while (index < points.length) {
    const { stoppedAt, reason } = await runFrom(project, source, points, index, (message, point) => report("tree/ranges-nest", point, message));
    if (stoppedAt === undefined) break;
    report("tree/parse-terminates", points[stoppedAt], `parsing ${reason}`);
    index = stoppedAt + 1;
  }
  return findings;
}

module.exports = { checkTree };
