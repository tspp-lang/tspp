export interface Sort<T = unknown> {
    readonly name: "Bool" | "Int" | "Real" | "String";
    readonly __value?: T;
}

export interface Term<T = unknown> { readonly __smtTerm?: T; }
type SymbolicValue<Value> = Value | Term<Value>;
type SymbolicValues<Values extends readonly unknown[]> = {
    readonly [Index in keyof Values]: SymbolicValue<Values[Index]>;
};
export type LogicFunction<Arguments extends readonly unknown[] = readonly unknown[], Result = unknown> =
    (...arguments_: SymbolicValues<Arguments>) => Result;
export type Parameter<T = unknown> = readonly [name: string, sort: Sort<T>];
type ParameterValues<Parameters extends readonly Parameter[]> = {
    readonly [Index in keyof Parameters]: Parameters[Index] extends Parameter<infer Value> ? Value : never;
};
type SortValues<Sorts extends readonly Sort[]> = {
    readonly [Index in keyof Sorts]: Sorts[Index] extends Sort<infer Value> ? Value : never;
};

export const Bool: Sort<boolean> = { name: "Bool" };
export const Int: Sort<bigint> = { name: "Int" };
export const Real: Sort<number> = { name: "Real" };
export const String: Sort<string> = { name: "String" };

function symbolic<Arguments extends readonly unknown[], Result>(name: string): LogicFunction<Arguments, Result> {
    return (..._arguments: SymbolicValues<Arguments>) => {
        throw new Error(`SMT function '${name}' exists only during static verification.`);
    };
}

export function definePredicate<const Parameters extends readonly Parameter[]>(
    parameters: Parameters,
    body: NoInfer<(...values: ParameterValues<Parameters>) => unknown>,
): LogicFunction<ParameterValues<Parameters>, boolean> {
    void parameters; void body;
    return symbolic("predicate");
}

export function defineFunction<const Parameters extends readonly Parameter[], Result>(
    parameters: Parameters,
    result: Sort<Result>,
    body: NoInfer<(...values: ParameterValues<Parameters>) => unknown>,
): LogicFunction<ParameterValues<Parameters>, Result> {
    void parameters; void result; void body;
    return symbolic("function");
}

export function defineRecursiveFunction<const Parameters extends readonly Parameter[], Result>(
    parameters: Parameters,
    result: Sort<Result>,
    body: NoInfer<(...values: ParameterValues<Parameters>) => unknown>,
): LogicFunction<ParameterValues<Parameters>, Result> {
    void parameters; void result; void body;
    return symbolic("recursive function");
}

export function declareFunction<const Parameters extends readonly Sort[], Result>(
    parameters: Parameters,
    result: Sort<Result>,
): LogicFunction<SortValues<Parameters>, Result> {
    void parameters; void result;
    return symbolic("declared function");
}

export function axiom<const Parameters extends readonly Parameter[]>(
    parameters: Parameters,
    body: NoInfer<(...values: ParameterValues<Parameters>) => unknown>,
): void {
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
export const add = <Value>(left: SymbolicValue<Value>, right: SymbolicValue<Value>): Term<Value> =>
    (void left, void right, {});
export const sub = <Value>(left: SymbolicValue<Value>, right: SymbolicValue<Value>): Term<Value> =>
    (void left, void right, {});
export const mul = <Value>(left: SymbolicValue<Value>, right: SymbolicValue<Value>): Term<Value> =>
    (void left, void right, {});
export const ite = <Value>(condition: unknown, whenTrue: SymbolicValue<Value>, whenFalse: SymbolicValue<Value>): Term<Value> =>
    (void condition, void whenTrue, void whenFalse, {});
export const apply = <Arguments extends readonly unknown[], Result>(
    fn: LogicFunction<Arguments, Result>,
    ...arguments_: SymbolicValues<Arguments>
): Term<Result> => (void fn, void arguments_, {});
export const forall = <const Parameters extends readonly Parameter[]>(
    parameters: Parameters,
    body: NoInfer<(...values: ParameterValues<Parameters>) => unknown>,
): Term<boolean> => (void parameters, void body, {});
export const exists = <const Parameters extends readonly Parameter[]>(
    parameters: Parameters,
    body: NoInfer<(...values: ParameterValues<Parameters>) => unknown>,
): Term<boolean> => (void parameters, void body, {});

export const js = {
    div: (left: unknown, right: unknown): Term<bigint> => (void left, void right, {}),
    rem: (left: unknown, right: unknown): Term<bigint> => (void left, void right, {}),
};
