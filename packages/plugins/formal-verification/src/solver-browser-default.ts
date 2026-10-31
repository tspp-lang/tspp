import type { Z3Answer, Z3Query } from "./solver";

export function solveWithDefaultZ3(_queries: readonly Z3Query[]): Promise<readonly Z3Answer[]> {
    return Promise.reject(new Error("This browser host has not configured a Z3 solver."));
}
