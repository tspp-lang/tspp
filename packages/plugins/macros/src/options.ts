import type { TSPPTypeScript } from "@tspp/plugin-sdk/compiler";
import type * as TS from "typescript-upstream";

import type { MacroTimeout } from "./sdk";
import type { MacroDeclarationSyntax } from "./syntax";

export const macroDiagnosticCodes = {
    notAMacro: 18079,
    failed: 18080,
    notAStatement: 18081,
    returnedPromise: 18082,
    unsupportedOption: 18083,
    duplicateOption: 18084,
    invalidTimeout: 18085,
} as const;

export const maximumMacroTimeoutMs = 2_147_483_647;

export interface MacroOptionDiagnostic {
    readonly start: number;
    readonly length: number;
    readonly code: number;
    readonly message: string;
}

export interface MacroOptions {
    /** False when the options are invalid; the macro then does not run. */
    readonly valid: boolean;
    readonly timeout: MacroTimeout | undefined;
    readonly diagnostics: readonly MacroOptionDiagnostic[];
}

const timeoutShape = `{ type: "fixed"; value: number; unit: "ms" | "s"; } | { type: "benchmark"; multiplier: number; }`;

/** Reads `macro({ timeout: ... })`. Positions in the result are offsets into the authored source. */
export function readMacroOptions(ts: TSPPTypeScript, declaration: MacroDeclarationSyntax): MacroOptions {
    const options = declaration.options;
    if (!options || !options.text.trim()) return { valid: true, timeout: undefined, diagnostics: [] };
    // The options text is parsed on its own inside parentheses, so positions are offset by the opening one.
    const text = `(${options.text})`;
    const sourceFile = ts.createSourceFile("macro-options.ts", text, ts.ScriptTarget.Latest, /*setParentNodes*/ true);
    const diagnostics: MacroOptionDiagnostic[] = [];
    const report = (node: TS.Node, code: number, message: string) => {
        const start = tokenStart(ts, text, node.pos);
        diagnostics.push({ start: options.start + start - 1, length: node.end - start, code, message });
    };
    const statement = sourceFile.statements[0];
    const expression = sourceFile.statements.length === 1 && ts.isExpressionStatement(statement) && ts.isParenthesizedExpression(statement.expression)
        ? statement.expression.expression
        : undefined;
    if (!expression || !ts.isObjectLiteralExpression(expression)) {
        diagnostics.push({ start: options.start, length: options.text.length, code: macroDiagnosticCodes.unsupportedOption, message: "The macro options must be an object literal." });
        return { valid: false, timeout: undefined, diagnostics };
    }
    let timeout: MacroTimeout | undefined;
    const seen = new Set<string>();
    for (const property of expression.properties) {
        const name = property.name && (ts.isIdentifier(property.name) ? ts.idText(property.name) : ts.isStringLiteral(property.name) ? property.name.text : undefined);
        if (!ts.isPropertyAssignment(property) || name === undefined) {
            report(property, macroDiagnosticCodes.unsupportedOption, "Each macro option must be a property assignment.");
            continue;
        }
        if (seen.has(name)) {
            report(property.name, macroDiagnosticCodes.duplicateOption, `The macro option '${name}' may only be specified once.`);
            continue;
        }
        seen.add(name);
        if (name !== "timeout") {
            report(property.name, macroDiagnosticCodes.unsupportedOption, `The macro option '${name}' is not supported.`);
            continue;
        }
        timeout = readTimeout(ts, property.initializer);
        if (!timeout) report(property, macroDiagnosticCodes.invalidTimeout, `The 'timeout' option must match '${timeoutShape}'.`);
    }
    return { valid: !diagnostics.length, timeout, diagnostics };
}

function readTimeout(ts: TSPPTypeScript, expression: TS.Expression): MacroTimeout | undefined {
    if (!ts.isObjectLiteralExpression(expression)) return undefined;
    const properties = new Map<string, TS.Expression>();
    for (const element of expression.properties) {
        if (!ts.isPropertyAssignment(element)) return undefined;
        const name = ts.isIdentifier(element.name) ? ts.idText(element.name) : ts.isStringLiteralLike(element.name) ? element.name.text : undefined;
        if (name === undefined || properties.has(name)) return undefined;
        properties.set(name, element.initializer);
    }
    const type = properties.get("type");
    if (!type || !ts.isStringLiteralLike(type)) return undefined;
    const number = (node: TS.Expression | undefined) => node && ts.isNumericLiteral(node) ? Number(node.text) : NaN;
    if (type.text === "fixed" && properties.size === 3) {
        const value = number(properties.get("value"));
        const unit = properties.get("unit");
        if (!unit || !ts.isStringLiteralLike(unit) || unit.text !== "ms" && unit.text !== "s") return undefined;
        if (!Number.isFinite(value) || value <= 0 || value * (unit.text === "s" ? 1000 : 1) > maximumMacroTimeoutMs) return undefined;
        return { type: "fixed", value, unit: unit.text };
    }
    if (type.text === "benchmark" && properties.size === 2) {
        const multiplier = number(properties.get("multiplier"));
        if (Number.isFinite(multiplier) && multiplier > 0 && multiplier <= maximumMacroTimeoutMs) return { type: "benchmark", multiplier };
    }
    return undefined;
}

/** The start of the first token at or after `pos`. */
export function tokenStart(ts: TSPPTypeScript, text: string, pos: number): number {
    const scanner = ts.createScanner(ts.ScriptTarget.Latest, /*skipTrivia*/ true, ts.LanguageVariant.Standard, text, /*onError*/ undefined, pos);
    scanner.scan();
    return scanner.getTokenStart();
}

export interface MacroTimeoutBudget {
    readonly valid: boolean;
    readonly timeoutMs: number;
    readonly description: string;
}

let cachedBenchmarkMs: number | undefined;

function measureBenchmarkMs(): number {
    if (cachedBenchmarkMs !== undefined) return cachedBenchmarkMs;
    const start = globalThis.performance.now();
    let checksum = 0;
    for (let index = 0; index < 1_000_000; index++) checksum = (checksum + Math.imul(index, 31)) % 1_000_000_007;
    if (checksum < 0) throw new Error("The macro benchmark produced an invalid result.");
    cachedBenchmarkMs = Math.max(1, globalThis.performance.now() - start);
    return cachedBenchmarkMs;
}

export function describeTimeout(timeout: MacroTimeout | undefined, defaultTimeoutMs: number, benchmarkOverrideMs: number | undefined): MacroTimeoutBudget {
    if (!timeout) return { valid: true, timeoutMs: defaultTimeoutMs, description: "default fixed budget" };
    if (timeout.type === "benchmark") {
        const benchmarkMs = benchmarkOverrideMs ?? measureBenchmarkMs();
        const timeoutMs = Math.min(maximumMacroTimeoutMs, Math.ceil(benchmarkMs * timeout.multiplier));
        return { valid: true, timeoutMs, description: `${timeout.multiplier}x local benchmark (${benchmarkMs.toFixed(2)} ms)` };
    }
    const timeoutMs = Math.ceil(timeout.unit === "s" ? timeout.value * 1000 : timeout.value);
    return { valid: true, timeoutMs, description: `${timeout.value}${timeout.unit} fixed budget` };
}
