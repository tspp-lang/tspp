import type { TSPPTypeScript } from "@tspp/plugin-sdk/compiler";
import type * as TS from "typescript-upstream";

import { findStatement, firstIdentifier, forEachDescendant, getProjectedElements, sourceFileOf, tokenStartOf } from "./nodes";
import { describeTimeout, macroDiagnosticCodes, type MacroTimeoutBudget, readMacroOptions } from "./options";
import {
    asyncEvaluations,
    type AsyncEvaluation,
    createMacroFactory,
    evaluateMacroModuleInNode,
    type Invocation,
    isPromiseLike,
    type MacroCompilerHost,
    nestedInvocations,
    remember,
    toInvocation,
} from "./runtime";
import type { MacroDiagnostic } from "./sdk";
import type { MacroDeclarationSyntax, MacroInvocationSyntax, MacroSourceSyntax } from "./syntax";

const defaultMacroTimeoutMs = 10_000;
const maximumNestedMacroExpansionDepth = 32;

export type { MacroCompilerHost } from "./runtime";

/** The generated statements for one invocation, inserted after it in the rebuilt program. */
export interface ExpandedMacroInvocation {
    readonly fileName: string;
    readonly start: number;
    readonly end: number;
    readonly macroName: string;
    readonly statements: readonly TS.Statement[];
    readonly text: string;
}

export interface MacroExpansionResult {
    readonly invocations: readonly ExpandedMacroInvocation[];
    readonly diagnostics: TS.Diagnostic[];
}

export interface MacroInvocationEvents {
    onInvocationStart?(info: { readonly timeoutMs: number; readonly description: string; readonly fileName: string; readonly start: number; readonly length: number; readonly macroName: string; }): void;
    onInvocationEnd?(): void;
}

export interface MacroExpansionOptions extends MacroInvocationEvents {
    readonly ts: TSPPTypeScript;
    readonly program: TS.Program;
    readonly host: MacroCompilerHost;
    /** Finds the macro syntax of a source file of `program`, if it has any. */
    getSyntax(sourceFile: TS.SourceFile): MacroSourceSyntax | undefined;
    /** Builds a program in which no macros are expanded. */
    createProgram(options: TS.CreateProgramOptions): TS.Program;
    /** Long-lived hosts settle promises later and are asked to rebuild then. */
    readonly invalidate?: () => void;
}

export function expandCompileTimeMacros(options: MacroExpansionOptions, allowAsync: true): Promise<MacroExpansionResult>;
export function expandCompileTimeMacros(options: MacroExpansionOptions, allowAsync: false): MacroExpansionResult;
export function expandCompileTimeMacros(options: MacroExpansionOptions, allowAsync: boolean): MacroExpansionResult | Promise<MacroExpansionResult> {
    const { ts, program, host } = options;
    const kinds = ts.SyntaxKind;
    const checker = program.getTypeChecker();
    const compilerOptions = program.getCompilerOptions();
    const diagnostics: TS.Diagnostic[] = [];
    let printer = ts.createPrinter();
    const moduleCache = new Map<string, Record<string, unknown>>();
    const factory = createMacroFactory(ts);
    let macroProgram: TS.Program | undefined;
    let macroHost: MacroCompilerHost | undefined;
    let inputKey: string | undefined;

    function getInputKey() {
        if (inputKey === undefined) {
            let hash = 5381;
            for (const sourceFile of program.getSourceFiles()) {
                const input = `${sourceFile.fileName}\0${sourceFile.text}\0`;
                for (let index = 0; index < input.length; index++) hash = (hash * 33 ^ input.charCodeAt(index)) >>> 0;
            }
            inputKey = hash.toString(16);
        }
        return inputKey;
    }

    function report(sourceFile: TS.SourceFile, start: number, length: number, messageText: string, code: number = macroDiagnosticCodes.failed, category: TS.DiagnosticCategory = ts.DiagnosticCategory.Error) {
        diagnostics.push({ category, code, file: sourceFile, start, length, messageText });
    }

    function getMacroProgram() {
        if (!macroProgram) {
            // The macro program binds its own copy of each source file: a caching host would otherwise hand it the
            // trees of `program`, and binding them again would detach them from `program`'s checker.
            const reparse = (source: TS.SourceFile | undefined, languageVersionOrOptions: TS.ScriptTarget | TS.CreateSourceFileOptions) =>
                !source || source.isDeclarationFile || !source.fileName.endsWith(".tspp")
                    ? source
                    : ts.createSourceFile(source.fileName, source.text, languageVersionOrOptions, /*setParentNodes*/ true, ts.ScriptKind.TS);
            macroHost = Object.create(host) as MacroCompilerHost;
            macroHost.getSourceFile = (fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile) =>
                reparse(host.getSourceFile(fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile), languageVersionOrOptions);
            if (host.getSourceFileByPath) {
                macroHost.getSourceFileByPath = (fileName, path, languageVersionOrOptions, onError, shouldCreateNewSourceFile) =>
                    reparse(host.getSourceFileByPath!(fileName, path, languageVersionOrOptions, onError, shouldCreateNewSourceFile), languageVersionOrOptions);
            }
            macroProgram = options.createProgram({
                rootNames: program.getRootFileNames(),
                options: {
                    ...compilerOptions,
                    declaration: false,
                    declarationMap: false,
                    emitDeclarationOnly: false,
                    incremental: false,
                    composite: false,
                    module: ts.ModuleKind.CommonJS,
                    noEmit: false,
                    noEmitOnError: false,
                    sourceMap: false,
                },
                host: macroHost,
            });
        }
        return macroProgram;
    }

    function isMacroFunction(node: TS.Node): node is TS.FunctionDeclaration {
        return ts.isFunctionDeclaration(node) && !!node.name && !!getMacroDeclaration(node);
    }

    function getMacroDeclaration(node: TS.FunctionDeclaration): MacroDeclarationSyntax | undefined {
        const name = node.name;
        if (!name) return undefined;
        const sourceFile = sourceFileOf(ts, node);
        const start = tokenStartOf(ts, sourceFile, name);
        return options.getSyntax(sourceFile)?.declarations.find(declaration => declaration.nameStart === start);
    }

    function evaluateMacroModule(sourceFile: TS.SourceFile, macroEntry = true): Record<string, unknown> {
        const cacheKey = `${macroEntry ? "macro" : "module"}:${sourceFile.fileName}`;
        const cached = moduleCache.get(cacheKey);
        if (cached) return cached;

        const buildProgram = getMacroProgram();
        const buildSource = buildProgram.getSourceFile(sourceFile.fileName);
        if (!buildSource) throw new Error(`Macro source '${sourceFile.fileName}' is not part of the program.`);
        let javascript = "";
        const retainedStatements = macroEntry ? getMacroDependencyStatements(sourceFile) : undefined;
        const transformers: TS.CustomTransformers | undefined = retainedStatements && {
            before: [context => emittedSource => {
                if (emittedSource.fileName !== buildSource.fileName) return emittedSource;
                const statements = emittedSource.statements.filter(statement => retainedStatements.has(`${statement.pos}:${statement.end}`));
                return context.factory.updateSourceFile(emittedSource, statements);
            }],
        };
        buildProgram.emit(
            buildSource,
            (fileName, text) => {
                if (/\.(?:c|m)?js$/i.test(fileName)) javascript = text;
            },
            /*cancellationToken*/ undefined,
            /*emitOnlyDtsFiles*/ false,
            transformers,
        );
        if (!javascript) throw new Error(`Macro source '${sourceFile.fileName}' did not produce JavaScript.`);

        const names = sourceFile.statements.filter(isMacroFunction).map(statement => ts.idText(statement.name!));
        javascript += `\nmodule.exports.__tsppLocalMacros = {${names.map(name => `${JSON.stringify(name)}: typeof ${name} === "function" ? ${name} : undefined`).join(",")}};`;

        const moduleRecord: { exports: Record<string, unknown>; } = { exports: {} };
        moduleCache.set(cacheKey, moduleRecord.exports);
        const requireLocal = (specifier: string) => {
            const hostModule = macroHost!.resolveMacroModule?.(specifier, sourceFile.fileName);
            if (hostModule !== undefined) return hostModule;
            const resolved = ts.resolveModuleName(specifier, sourceFile.fileName, buildProgram.getCompilerOptions(), macroHost!).resolvedModule;
            const dependency = resolved && buildProgram.getSourceFile(resolved.resolvedFileName);
            if (dependency && !dependency.isDeclarationFile && !dependency.fileName.endsWith(".json")) {
                return evaluateMacroModule(dependency, /*macroEntry*/ false);
            }
            return undefined;
        };
        try {
            evaluateHostMacroModule(javascript, sourceFile.fileName, requireLocal, moduleRecord);
        }
        catch (error) {
            moduleCache.delete(cacheKey);
            throw error;
        }
        moduleCache.set(cacheKey, moduleRecord.exports);
        return moduleRecord.exports;
    }

    function evaluateHostMacroModule(javascript: string, fileName: string, requireLocal: (specifier: string) => unknown, moduleRecord: { exports: Record<string, unknown>; }) {
        (host.evaluateMacroModule ?? evaluateMacroModuleInNode)(javascript, fileName, requireLocal, moduleRecord);
    }

    /** The macro functions and side-effect imports of a file, and the top-level statements they use. */
    function getMacroDependencyStatements(sourceFile: TS.SourceFile): Set<string> {
        const statements = new Set<TS.Statement>();
        const pending: TS.Statement[] = [];
        const add = (statement: TS.Statement) => {
            if (statements.has(statement)) return;
            statements.add(statement);
            pending.push(statement);
        };
        for (const statement of sourceFile.statements) {
            if (isMacroFunction(statement) || ts.isImportDeclaration(statement) && !statement.importClause) add(statement);
        }
        while (pending.length) {
            forEachDescendant(ts, pending.pop()!, node => {
                if (!ts.isIdentifier(node)) return;
                for (const declaration of checker.getSymbolAtLocation(node)?.declarations ?? []) {
                    if (sourceFileOf(ts, declaration) !== sourceFile) continue;
                    let current: TS.Node = declaration;
                    while (current.parent && current.parent !== sourceFile) current = current.parent;
                    if (current.parent === sourceFile && ts.isStatement(current)) add(current);
                }
            });
        }
        return new Set([...statements].map(statement => `${statement.pos}:${statement.end}`));
    }

    /** Finds the symbol a dotted name refers to from `location`, for any meaning. */
    function resolveEntity(parts: readonly string[], location: TS.Node, firstNode: TS.Node | undefined): TS.Symbol | undefined {
        let symbol = firstNode && checker.getSymbolAtLocation(firstNode)
            || checker.getSymbolsInScope(location, ts.SymbolFlags.Value | ts.SymbolFlags.Type | ts.SymbolFlags.Namespace | ts.SymbolFlags.Alias)
                .find(candidate => ts.symbolName(candidate) === parts[0]);
        for (const part of parts.slice(1)) {
            if (!symbol) return undefined;
            if (symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
            symbol = symbol.exports?.get(ts.escapeLeadingUnderscores(part)) ?? checker.getPropertyOfType(checker.getTypeOfSymbol(symbol), part);
        }
        // A module's exported declarations appear in its scope as local placeholders without meanings of their own.
        if (symbol) symbol = checker.getExportSymbolOfSymbol(symbol);
        return symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
    }

    function loadExternalMacro(invocation: Invocation, invocationSource: TS.SourceFile): unknown {
        const localName = invocation.macroParts[0];
        let aliasDeclaration: TS.Node | undefined;
        for (const statement of invocationSource.statements) {
            if (!ts.isImportDeclaration(statement)) continue;
            const clause = statement.importClause;
            if (clause?.name && ts.idText(clause.name) === localName) aliasDeclaration = clause;
            const bindings = clause?.namedBindings;
            if (bindings && ts.isNamespaceImport(bindings) && ts.idText(bindings.name) === localName) aliasDeclaration = bindings;
            if (bindings && ts.isNamedImports(bindings)) aliasDeclaration ??= bindings.elements.find(element => ts.idText(element.name) === localName);
            if (aliasDeclaration) break;
        }
        let current = aliasDeclaration;
        while (current && !ts.isImportDeclaration(current)) current = current.parent;
        if (!current) throw new Error(`The import for macro '${invocation.macroName}' could not be determined.`);
        if (!ts.isStringLiteral(current.moduleSpecifier)) return undefined;
        const moduleSpecifier = current.moduleSpecifier.text;
        const moduleRecord: { exports: Record<string, unknown>; } = { exports: {} };
        evaluateHostMacroModule(
            `module.exports = require(${JSON.stringify(moduleSpecifier)});`,
            invocationSource.fileName,
            specifier => host.resolveMacroModule?.(specifier, invocationSource.fileName),
            moduleRecord,
        );
        let value: any = moduleRecord.exports;
        if (aliasDeclaration && ts.isImportSpecifier(aliasDeclaration)) {
            const imported = aliasDeclaration.propertyName ?? aliasDeclaration.name;
            value = value[ts.isIdentifier(imported) ? ts.idText(imported) : imported.text];
        }
        else if (aliasDeclaration && ts.isImportClause(aliasDeclaration)) {
            value = value.default;
        }
        for (const part of invocation.macroParts.slice(1)) value = value?.[part];
        if (value === undefined) throw new Error(`Module '${moduleSpecifier}' does not export macro '${invocation.macroName}'.`);
        return value;
    }

    function executeInvocation(
        invocation: Invocation,
        location: { readonly sourceFile: TS.SourceFile; readonly start: number; readonly end: number; readonly node: TS.Node; },
        expansionDepth = 0,
    ): readonly TS.Statement[] | Promise<readonly TS.Statement[]> {
        const invocationSource = location.sourceFile;
        const { macroName } = invocation;
        const fail = (message: string, code: number = macroDiagnosticCodes.failed, category: TS.DiagnosticCategory = ts.DiagnosticCategory.Error) =>
            report(invocationSource, location.start, location.end - location.start, message, code, category);
        if (expansionDepth >= maximumNestedMacroExpansionDepth) {
            fail(`Macro expansion exceeded the maximum recursive depth of ${maximumNestedMacroExpansionDepth} while expanding '${macroName}'.`);
            return [];
        }
        const elements = invocation.statement && getProjectedElements(ts, invocation.statement);
        const symbol = resolveEntity(invocation.macroParts, location.node, elements && firstIdentifier(ts, elements[0]));
        const declaration = symbol?.declarations?.find(isMacroFunction);
        if (symbol && !declaration) {
            report(invocationSource, location.start, location.end - location.start, `'${macroName}' is not a macro function.`, macroDiagnosticCodes.notAMacro);
            return [];
        }
        if (!symbol) {
            // A source invocation names its macro in the rebuilt program, whose checker reports an unknown name.
            if (!invocation.statement) fail(`Macro '${macroName}' failed: Cannot find macro '${macroName}'.`);
            return [];
        }
        const budget = getTimeoutBudget(getMacroDeclaration(declaration!));
        if (!budget.valid) return [];
        let ended = false;
        const endInvocation = () => {
            if (ended) return;
            ended = true;
            options.onInvocationEnd?.();
        };
        options.onInvocationStart?.({
            ...budget,
            fileName: invocationSource.fileName,
            start: location.start,
            length: location.end - location.start,
            macroName,
        });
        let macro: unknown;
        try {
            if (declaration!.body) {
                const exports = evaluateMacroModule(sourceFileOf(ts, declaration!));
                const declarationName = ts.idText(declaration!.name!);
                macro = (exports.__tsppLocalMacros as Record<string, unknown> | undefined)?.[declarationName] ?? exports[declarationName];
            }
            else {
                macro = loadExternalMacro(invocation, invocationSource);
            }
            if (typeof macro !== "function") {
                const available = declaration!.body ? ` Available exports: ${Object.keys(evaluateMacroModule(sourceFileOf(ts, declaration!))).join(", ") || "(none)"}.` : "";
                throw new Error(`The implementation of macro '${macroName}' could not be loaded.${available}`);
            }

            const targets = invocation.targetNames.map((parts, index) => {
                const targetSymbol = resolveEntity(parts, location.node, elements && firstIdentifier(ts, elements[index + 1]));
                const declarations = targetSymbol?.declarations ?? [];
                const node = targetSymbol?.valueDeclaration ?? declarations[0];
                if (!targetSymbol || !node) throw new Error(`Target '${parts.join(".")}' could not be resolved.`);
                return { name: parts.join("."), symbol: targetSymbol, node, declarations, sourceFile: sourceFileOf(ts, node) };
            });
            const reported: MacroDiagnostic[] = [];
            const asyncKey = `${getInputKey()}:${invocationSource.fileName}:${location.start}:${location.end}:${macroName}:${expansionDepth}`;
            const cached = allowAsync ? undefined : asyncEvaluations.get(asyncKey);
            if (cached) {
                endInvocation();
                if (cached.kind === "pending") return [];
                return cached.kind === "rejected"
                    ? failInvocation(cached.error)
                    : expandNestedSync(finishInvocation(cached.result, cached.reported));
            }
            const result = (macro as (targets: readonly unknown[], context: Record<string, unknown>) => unknown)(targets, {
                program,
                checker,
                factory,
                typescript: {
                    factory,
                    SyntaxKind: { FunctionDeclaration: kinds.FunctionDeclaration, ExportKeyword: kinds.ExportKeyword },
                    NodeFlags: { Const: ts.NodeFlags.Const },
                },
                sourceFile: invocationSource,
                macroInvocation: invocation.statement,
                report: (item: MacroDiagnostic) => reported.push(item),
                fail: (message: string) => ({ kind: "macro-failure", diagnostics: [{ message }] }),
            });
            if (isPromiseLike(result)) {
                const awaited = awaitMacroResult(result, macroName, budget);
                if (!allowAsync) {
                    if (options.invalidate) {
                        const invalidate = options.invalidate;
                        remember(asyncKey, { kind: "pending" });
                        void awaited.then<AsyncEvaluation, AsyncEvaluation>(
                            value => ({ kind: "resolved", result: value, reported }),
                            error => ({ kind: "rejected", error, reported }),
                        ).then(evaluation => {
                            remember(asyncKey, evaluation);
                            invalidate();
                        });
                        endInvocation();
                        return [];
                    }
                    fail(`Macro '${macroName}' returned a Promise. Use the asynchronous compiler entry point to execute asynchronous macros.`, macroDiagnosticCodes.returnedPromise);
                    endInvocation();
                    return [];
                }
                return awaited.then(
                    value => finishInvocation(value, reported),
                    error => failInvocation(error),
                ).then(expandNestedAsync).finally(endInvocation);
            }
            const statements = finishInvocation(result, reported);
            if (allowAsync) return expandNestedAsync(statements).finally(endInvocation);
            const expanded = expandNestedSync(statements);
            endInvocation();
            return expanded;
        }
        catch (error) {
            const statements = failInvocation(error);
            endInvocation();
            return statements;
        }

        async function expandNestedAsync(statements: readonly TS.Statement[]): Promise<readonly TS.Statement[]> {
            const expanded: TS.Statement[] = [];
            for (const statement of statements) {
                const nested = nestedInvocations.get(statement);
                if (nested) expanded.push(...await executeInvocation(toInvocation(ts, nested), location, expansionDepth + 1));
                else expanded.push(statement);
            }
            return expanded;
        }

        function expandNestedSync(statements: readonly TS.Statement[]): readonly TS.Statement[] {
            const expanded: TS.Statement[] = [];
            for (const statement of statements) {
                const nested = nestedInvocations.get(statement);
                if (nested) expanded.push(...executeInvocation(toInvocation(ts, nested), location, expansionDepth + 1) as readonly TS.Statement[]);
                else expanded.push(statement);
            }
            return expanded;
        }

        function finishInvocation(result: unknown, reported: readonly MacroDiagnostic[]): readonly TS.Statement[] {
            try {
                for (const item of reported) {
                    fail(`Macro '${macroName}' failed: ${item.message}`, macroDiagnosticCodes.failed, item.category ?? ts.DiagnosticCategory.Error);
                }
                const record = result && typeof result === "object" ? result as Record<string, unknown> : undefined;
                if (record?.kind === "macro-failure") {
                    for (const item of Array.isArray(record.diagnostics) ? record.diagnostics : []) {
                        const message = item && typeof item === "object" && "message" in item ? String(item.message) : String(item);
                        const category = item && typeof item === "object" && "category" in item && typeof item.category === "number"
                            ? item.category as TS.DiagnosticCategory
                            : ts.DiagnosticCategory.Error;
                        fail(`Macro '${macroName}' failed: ${message}`, macroDiagnosticCodes.failed, category);
                    }
                    return [];
                }
                if (result === undefined || Array.isArray(result) && result.length === 0) return [];
                const statements: unknown[] = Array.isArray(result) ? result : [result];
                if (!statements.every(statement => statement && typeof statement === "object" && "kind" in statement && ts.isStatement(statement as TS.Node))) {
                    fail(`Macro '${macroName}' returned a value that is not a statement, statement array, failure, or undefined.`, macroDiagnosticCodes.notAStatement);
                    return [];
                }
                return statements as TS.Statement[];
            }
            catch (error) {
                return failInvocation(error);
            }
        }

        function failInvocation(error: unknown): readonly TS.Statement[] {
            fail(`Macro '${macroName}' failed: ${error instanceof Error ? error.message : String(error)}`);
            return [];
        }
    }

    function getTimeoutBudget(declaration: MacroDeclarationSyntax | undefined): MacroTimeoutBudget {
        const defaultTimeout = host.macroTimeoutMs ?? defaultMacroTimeoutMs;
        const macroOptions = declaration ? readMacroOptions(ts, declaration) : undefined;
        if (macroOptions && !macroOptions.valid) return { valid: false, timeoutMs: defaultTimeout, description: "invalid budget" };
        return describeTimeout(macroOptions?.timeout, defaultTimeout, host.macroBenchmarkMs);
    }

    function awaitMacroResult(result: PromiseLike<unknown>, macroName: string, budget: MacroTimeoutBudget): Promise<unknown> {
        const { timeoutMs } = budget;
        return new Promise((resolve, reject) => {
            const timer = globalThis.setTimeout(
                () => reject(new Error(`Macro '${macroName}' timed out after ${timeoutMs} ms (${budget.description}).`)),
                timeoutMs,
            );
            Promise.resolve(result).then(
                value => {
                    globalThis.clearTimeout(timer);
                    resolve(value);
                },
                error => {
                    globalThis.clearTimeout(timer);
                    reject(error);
                },
            );
        });
    }

    function expandedInvocation(sourceFile: TS.SourceFile, syntax: MacroInvocationSyntax, statements: readonly TS.Statement[]): ExpandedMacroInvocation {
        let text: string;
        try {
            text = statements.map(statement => printer.printNode(ts.EmitHint.Unspecified, statement, sourceFile)).join("\n");
        }
        catch (error) {
            // The printer may have stopped partway through a statement. Discard both the
            // invalid expansion and the printer's partial state before processing the next call.
            printer = ts.createPrinter();
            const reason = error instanceof Error ? error.message : String(error);
            report(sourceFile, syntax.start, syntax.end - syntax.start, `Macro '${syntax.macro.text}' returned an invalid syntax tree: ${reason}`);
            statements = [];
            text = "";
        }
        return {
            fileName: sourceFile.fileName,
            start: syntax.start,
            end: syntax.end,
            macroName: syntax.macro.text,
            statements,
            text,
        };
    }

    function sourceInvocations() {
        const result: { sourceFile: TS.SourceFile; syntax: MacroInvocationSyntax; invocation: Invocation; node: TS.Node; }[] = [];
        for (const sourceFile of program.getSourceFiles()) {
            if (sourceFile.isDeclarationFile) continue;
            for (const syntax of options.getSyntax(sourceFile)?.invocations ?? []) {
                const statement = findStatement(ts, sourceFile, syntax.start, syntax.end);
                if (!statement || !ts.isExpressionStatement(statement)) continue;
                result.push({
                    sourceFile,
                    syntax,
                    node: statement,
                    invocation: {
                        macroName: syntax.macro.text,
                        macroParts: syntax.macro.parts.map(part => part.text),
                        targetNames: syntax.targets.map(target => target.parts.map(part => part.text)),
                        statement,
                    },
                });
            }
        }
        return result;
    }

    const invocations = sourceInvocations();

    async function expandAsync(): Promise<MacroExpansionResult> {
        const expanded: ExpandedMacroInvocation[] = [];
        // Deliberately preserve source order so diagnostics and macro side effects are stable.
        for (const { sourceFile, syntax, invocation, node } of invocations) {
            expanded.push(expandedInvocation(sourceFile, syntax, await executeInvocation(invocation, { sourceFile, start: syntax.start, end: syntax.end, node })));
        }
        return { invocations: expanded, diagnostics };
    }

    if (allowAsync) return expandAsync();
    const expanded = invocations.map(({ sourceFile, syntax, invocation, node }) =>
        expandedInvocation(sourceFile, syntax, executeInvocation(invocation, { sourceFile, start: syntax.start, end: syntax.end, node }) as readonly TS.Statement[])
    );
    return { invocations: expanded, diagnostics };
}
