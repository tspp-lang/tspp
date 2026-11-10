const assert = require("node:assert/strict");
const test = require("node:test");
const { solveWithDefaultZ3 } = require("../dist/solver-default");

// z3-solver once read the SMT text from reclaimed stack memory, so a fraction of a percent of queries failed to
// parse at random. Many distinct, multi-line queries make that corruption show up as an "error" answer.
test("keeps every query intact while Z3 evaluates it asynchronously", async t => {
  const queries = Array.from({ length: 800 }, (_, index) => ({
    script: [
      `(define-fun |shifted| ((|offset| Int)) Bool (forall ((|value| Int)) (=> (>= |value| 0) (>= (+ |value| |offset|) |offset|))))`,
      `(define-fun-rec |triangular| ((|value| Int)) Int (ite (<= |value| 0) 0 (+ |value| (|triangular| (- |value| 1)))))`,
      `(declare-const |value| Int)`,
      `(assert (>= |value| ${index}))`,
    ].join("\n"),
    goal: `(> (+ |value| 1) ${index})`,
  }));
  // Calibrate on the same workload so the stress test tolerates slower machines.
  const sample = queries.slice(0, 200);
  const calibrationStart = performance.now();
  const calibration = await solveWithDefaultZ3(sample);
  const calibrationMs = performance.now() - calibrationStart;
  assert.equal(calibration.length, sample.length);
  assert.deepEqual(calibration.filter(answer => answer.status !== "unsat"), []);
  const budgetMs = Math.ceil(calibrationMs * (queries.length / sample.length) * 1.5);
  t.diagnostic(`Calibrated ${queries.length}-query budget: ${budgetMs} ms (${sample.length} queries in ${Math.round(calibrationMs)} ms)`);

  const start = performance.now();
  const answers = await solveWithDefaultZ3(queries, budgetMs);
  t.diagnostic(`Completed ${answers.length} queries in ${Math.round(performance.now() - start)} ms`);
  assert.equal(answers.length, queries.length);
  assert.deepEqual(answers.filter(answer => answer.status !== "unsat"), []);
});
