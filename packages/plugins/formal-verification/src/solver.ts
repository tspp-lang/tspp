import { solveWithDefaultZ3 } from "./solver-default";

export interface Z3Query {
    readonly script?: string;
    readonly goal: string;
}

export interface Z3Answer {
    readonly status: "sat" | "unsat" | "unknown" | "error";
    readonly output?: string;
    readonly message?: string;
}

export type Z3Solver = (queries: readonly Z3Query[]) => Promise<readonly Z3Answer[]>;

let activeSolver: Z3Solver = solveWithDefaultZ3;

/** Replaces the host-specific Z3 executor while keeping query construction and caching in the feature capsule. */
export function configureZ3Solver(solver: Z3Solver): () => void {
    const previous = activeSolver;
    activeSolver = solver;
    answerCache.clear();
    return () => {
        if (activeSolver === solver) activeSolver = previous;
        answerCache.clear();
    };
}

export const verificationProgramSemantics = `(define-fun tspp.js.sign ((value Int)) Int (ite (< value 0) (- 1) 1))
(define-fun tspp.js.trunc.div ((left Int) (right Int)) Int
  (* (tspp.js.sign left) (tspp.js.sign right) (div (ite (< left 0) (- left) left) (ite (< right 0) (- right) right))))
(define-fun tspp.js.trunc.rem ((left Int) (right Int)) Int
  (- left (* right (tspp.js.trunc.div left right))))`;

export function renderZ3Query(query: Z3Query): string {
    return [`(set-logic ALL)`, verificationProgramSemantics, query.script ?? "", `(assert (not ${query.goal}))`, `(check-sat)`, `(get-model)`]
        .filter(Boolean).join("\n");
}

export function solveWithZ3(queries: readonly Z3Query[]): Promise<readonly Z3Answer[]> {
    if (!queries.length) return Promise.resolve([]);
    return activeSolver(queries);
}

const answerCache = new Map<string, Z3Answer>();
const maximumCachedAnswers = 512;

export function clearZ3AnswerCache(): void {
    answerCache.clear();
}

/** Reuses deterministic solver answers by complete SMT obligation content. */
export async function solveWithZ3Cached(queries: readonly Z3Query[]): Promise<readonly Z3Answer[]> {
    const answers: (Z3Answer | undefined)[] = new Array(queries.length);
    const missing: Z3Query[] = [];
    const missingIndices: number[] = [];
    queries.forEach((query, index) => {
        const cached = answerCache.get(queryKey(query));
        if (cached) answers[index] = cached;
        else { missing.push(query); missingIndices.push(index); }
    });
    if (missing.length) {
        const solved = await solveWithZ3(missing);
        solved.forEach((answer, index) => {
            const target = missingIndices[index];
            answers[target] = answer;
            if (answer.status === "sat" || answer.status === "unsat") rememberAnswer(queryKey(queries[target]), answer);
        });
    }
    return answers as Z3Answer[];
}

function queryKey(query: Z3Query): string {
    return `${query.script ?? ""}\u0000${query.goal}`;
}

function rememberAnswer(key: string, answer: Z3Answer): void {
    answerCache.delete(key);
    answerCache.set(key, answer);
    if (answerCache.size > maximumCachedAnswers) answerCache.delete(answerCache.keys().next().value!);
}
