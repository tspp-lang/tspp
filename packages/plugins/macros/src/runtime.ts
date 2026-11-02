import type { TSPPTypeScript } from "@tspp/plugin-sdk/compiler";
import type * as TS from "typescript-upstream";

import type { MacroDiagnostic } from "./sdk";

/** CompilerHost members a host may provide to run macros outside Node.js or to tune them; none is required. */
export interface MacroCompilerHost extends TS.CompilerHost {
    /** Resolves a macro dependency already exposed by a non-Node host runtime. */
    resolveMacroModule?(specifier: string, containingFile: string): unknown;
    /** Evaluates emitted CommonJS macro code in a host-provided runtime. */
    evaluateMacroModule?(
        javascript: string,
        fileName: string,
        requireLocal: (specifier: string) => unknown,
        module: { exports: Record<string, unknown>; },
    ): void;
    /** Overrides the default wait limit for macros without a `timeout` option. */
    macroTimeoutMs?: number;
    /** Overrides the measured local benchmark duration, for tests and specialized hosts. */
    macroBenchmarkMs?: number;
    /** Runs macros in this thread even when workers are available. */
    disableMacroWorkers?: boolean;
}

export type AsyncEvaluation =
    | { readonly kind: "pending"; }
    | { readonly kind: "resolved"; readonly result: unknown; readonly reported: readonly MacroDiagnostic[]; }
    | { readonly kind: "rejected"; readonly error: unknown; readonly reported: readonly MacroDiagnostic[]; };

/** Results of promises returned to synchronous builds, by program input and invocation. */
export const asyncEvaluations = new Map<string, AsyncEvaluation>();
const maximumAsyncEvaluations = 512;

/** Statements that `context.factory.createMacroInvocationStatement` returned, expanded again after their macro. */
export const nestedInvocations = new WeakMap<object, { readonly macro: TS.EntityName; readonly targets: readonly TS.EntityName[]; }>();

/** The position-independent part of an invocation the expander works on. */
export interface Invocation {
    readonly macroName: string;
    readonly macroParts: readonly string[];
    readonly targetNames: readonly (readonly string[])[];
    /** The projected statement of a source invocation; nested invocations have none. */
    readonly statement?: TS.ExpressionStatement;
}

// Bundlers rewrite literal `require` calls; Node.js modules are only reached through this alias, and only in Node.
const nodeRequire: NodeJS.Require | undefined = typeof require === "function" ? require : undefined;

/** Runs a CommonJS module in this process and serves non-local specifiers through Node's module loader. */
export function evaluateMacroModuleInNode(javascript: string, fileName: string, requireLocal: (specifier: string) => unknown, moduleRecord: { exports: Record<string, unknown>; }) {
    if (!nodeRequire) throw new Error("This host cannot evaluate macros: it provides neither Node.js nor CompilerHost.evaluateMacroModule.");
    let fileRequire: NodeJS.Require | undefined;
    const macroRequire = (specifier: string) => {
        const local = requireLocal(specifier);
        if (local !== undefined) return local;
        fileRequire ??= (nodeRequire("module") as typeof import("module")).createRequire(fileName);
        return fileRequire(specifier);
    };
    const directory = fileName.replace(/[\\/][^\\/]*$/, "") || "/";
    // The macro module is compiler-generated JavaScript and requires a CommonJS wrapper.
    const execute = new Function("require", "exports", "module", "__filename", "__dirname", javascript);
    execute(macroRequire, moduleRecord.exports, moduleRecord, fileName, directory);
}

export function remember(key: string, evaluation: AsyncEvaluation) {
    asyncEvaluations.delete(key);
    asyncEvaluations.set(key, evaluation);
    while (asyncEvaluations.size > maximumAsyncEvaluations) asyncEvaluations.delete(asyncEvaluations.keys().next().value!);
}

export function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
    return !!value && typeof value === "object" && typeof (value as PromiseLike<unknown>).then === "function";
}

/** `ts.factory` plus `createMacroInvocationStatement`, for macros that expand into further macro invocations. */
export function createMacroFactory(ts: TSPPTypeScript) {
    const factory = Object.create(ts.factory) as TS.NodeFactory & {
        createMacroInvocationStatement(macro: TS.EntityName, targets: readonly TS.EntityName[]): TS.Statement;
    };
    factory.createMacroInvocationStatement = (macro, targets) => {
        const statement = ts.factory.createExpressionStatement(ts.factory.createVoidZero());
        nestedInvocations.set(statement, { macro, targets });
        return statement;
    };
    return factory;
}

export function toInvocation(ts: TSPPTypeScript, nested: { readonly macro: TS.EntityName; readonly targets: readonly TS.EntityName[]; }): Invocation {
    const parts = (name: TS.EntityName): string[] => ts.isIdentifier(name) ? [ts.idText(name)] : [...parts(name.left), ts.idText(name.right)];
    const macroParts = parts(nested.macro);
    return { macroName: macroParts.join("."), macroParts, targetNames: nested.targets.map(parts) };
}
