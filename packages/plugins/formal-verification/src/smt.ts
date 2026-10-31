export interface Sort<T = unknown> {
    readonly name: "Bool" | "Int" | "Real" | "String";
    readonly __value?: T;
}

export interface Term<T = unknown> { readonly __smtTerm?: T; }
export type LogicFunction = (...arguments_: any[]) => any;
export type Parameter = readonly [name: string, sort: Sort<any>];

export const Bool: Sort<boolean> = { name: "Bool" };
export const Int: Sort<bigint> = { name: "Int" };
export const Real: Sort<number> = { name: "Real" };
export const String: Sort<string> = { name: "String" };

function symbolic(name: string): LogicFunction {
    return () => { throw new Error(`SMT function '${name}' exists only during static verification.`); };
}

export function definePredicate(parameters: readonly Parameter[], body: (...values: any[]) => unknown): LogicFunction {
    void parameters; void body;
    return symbolic("predicate");
}

export function defineFunction(
    parameters: readonly Parameter[], result: Sort<any>, body: (...values: any[]) => unknown,
): LogicFunction {
    void parameters; void result; void body;
    return symbolic("function");
}

export function defineRecursiveFunction(
    parameters: readonly Parameter[], result: Sort<any>, body: (...values: any[]) => unknown,
): LogicFunction {
    void parameters; void result; void body;
    return symbolic("recursive function");
}

export function declareFunction(parameters: readonly Sort<any>[], result: Sort<any>): LogicFunction {
    void parameters; void result;
    return symbolic("declared function");
}

export function axiom(parameters: readonly Parameter[], body: (...values: any[]) => unknown): void {
    void parameters; void body;
}

export const and = (...values: unknown[]): Term<boolean> => (void values, {});
export const or = (...values: unknown[]): Term<boolean> => (void values, {});
export const not = (value: unknown): Term<boolean> => (void value, {});
export const implies = (left: unknown, right: unknown): Term<boolean> => (void left, void right, {});
export const eq = (left: unknown, right: unknown): Term<boolean> => (void left, void right, {});
export const lt = (left: unknown, right: unknown): Term<boolean> => (void left, void right, {});
export const le = (left: unknown, right: unknown): Term<boolean> => (void left, void right, {});
export const gt = (left: unknown, right: unknown): Term<boolean> => (void left, void right, {});
export const ge = (left: unknown, right: unknown): Term<boolean> => (void left, void right, {});
export const add = (left: unknown, right: unknown): Term => (void left, void right, {});
export const sub = (left: unknown, right: unknown): Term => (void left, void right, {});
export const mul = (left: unknown, right: unknown): Term => (void left, void right, {});
export const ite = (condition: unknown, whenTrue: unknown, whenFalse: unknown): Term =>
    (void condition, void whenTrue, void whenFalse, {});
export const apply = (fn: LogicFunction, ...arguments_: unknown[]): Term => (void fn, void arguments_, {});
export const forall = (parameters: readonly Parameter[], body: (...values: any[]) => unknown): Term<boolean> =>
    (void parameters, void body, {});
export const exists = (parameters: readonly Parameter[], body: (...values: any[]) => unknown): Term<boolean> =>
    (void parameters, void body, {});

export const js = {
    div: (left: unknown, right: unknown): Term<bigint> => (void left, void right, {}),
    rem: (left: unknown, right: unknown): Term<bigint> => (void left, void right, {}),
};
