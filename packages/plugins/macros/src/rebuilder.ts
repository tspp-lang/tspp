import type {
    TSPPProgramRebuild,
    TSPPProgramRebuilder,
    TSPPSourcePreprocessor,
    TSPPStatementReplacement,
    TSPPTypeScript,
} from "@tspp/plugin-sdk/compiler";
import type * as TS from "typescript-upstream";

import {
    type ExpandedMacroInvocation,
    expandCompileTimeMacros,
    type MacroCompilerHost,
    type MacroExpansionResult,
    type MacroInvocationEvents,
    reportMacroOptionDiagnostics,
} from "./expand";
import { findStatement, getProjectedElements } from "./nodes";
import type { MacroExpansion } from "./sdk";
import { getDeclarationPrefix, isMacroSourceFile, type MacroSourceSyntax, scanMacroSource } from "./syntax";
import { canUseMacroWorkers, MacroWorkerError, type MacroWorkerResult, runMacroExpansionWorker } from "./worker";

/** Scans by file name, for the latest projected text; a file is projected before its program is rebuilt. */
const syntaxByFileName = new Map<string, MacroSourceSyntax>();
const expansionsByProgram = new WeakMap<object, readonly MacroExpansion[]>();
/** True while this plugin builds programs of its own, which must not be rebuilt. */
let building = false;

const unusedDiagnosticCodes = new Set([6133, 6138, 6192, 6196, 6198, 6199, 6205]);

/** The replacement-free part of a program with macros, for `getMacroExpansions` and the playground. */
export function getMacroExpansions(program: object, fileName?: string): readonly MacroExpansion[] {
    const expansions = expansionsByProgram.get(program) ?? [];
    return fileName === undefined ? expansions : expansions.filter(expansion => expansion.fileName === fileName);
}

export function createMacroPreprocessor(ts: TSPPTypeScript): TSPPSourcePreprocessor {
    return {
        id: "macro-syntax",
        claims: [{ keyword: "macro", position: "declaration" }, { keyword: "macro", position: "statement" }],
        preprocess(fileName, sourceText) {
            if (!isMacroSourceFile(fileName) || !sourceText.includes("macro")) {
                syntaxByFileName.delete(fileName);
                return sourceText;
            }
            const syntax = scanMacroSource(ts, sourceText);
            if (syntax.declarations.length || syntax.invocations.length) syntaxByFileName.set(fileName, syntax);
            else syntaxByFileName.delete(fileName);
            return syntax.projected;
        },
        restoreFunctionPrefix(request) {
            const syntax = getSyntaxOfText(ts, request.fileName, request.sourceText);
            const declaration = syntax?.declarations
                .filter(candidate => candidate.name === request.name)
                .reduce<MacroSourceSyntax["declarations"][number] | undefined>((closest, candidate) =>
                    !closest || Math.abs(candidate.start - request.declarationStart) < Math.abs(closest.start - request.declarationStart) ? candidate : closest, undefined);
            return syntax && declaration && getDeclarationPrefix(syntax, declaration);
        },
    };
}

function getSyntaxOfText(ts: TSPPTypeScript, fileName: string, original: string): MacroSourceSyntax | undefined {
    const cached = syntaxByFileName.get(fileName);
    return cached?.original === original ? cached : isMacroSourceFile(fileName) ? scanMacroSource(ts, original) : undefined;
}

const syntaxBySourceFile = new WeakMap<TS.SourceFile, { readonly from: MacroSourceSyntax; readonly matches: boolean; }>();

/** The syntax found in a parsed file: its text has this plugin's rewrites, whatever other plugins rewrote around them. */
function getSyntax(sourceFile: TS.SourceFile): MacroSourceSyntax | undefined {
    const cached = syntaxByFileName.get(sourceFile.fileName);
    if (!cached) return undefined;
    let known = syntaxBySourceFile.get(sourceFile);
    if (known?.from !== cached) {
        let matches = sourceFile.text.length === cached.projected.length;
        for (let index = 0; matches && index < cached.projected.length; index++) {
            if (cached.projected[index] !== cached.original[index] && sourceFile.text[index] !== cached.projected[index]) matches = false;
        }
        known = { from: cached, matches };
        syntaxBySourceFile.set(sourceFile, known);
    }
    return known.matches ? cached : undefined;
}

function buildWithoutMacros(ts: TSPPTypeScript, options: TS.CreateProgramOptions): TS.Program {
    const previous = building;
    building = true;
    try {
        return ts.createProgram(options);
    }
    finally {
        building = previous;
    }
}

/** Expands every invocation in this thread; the macro worker uses it. */
export async function expandInThisThread(ts: TSPPTypeScript, options: TS.CreateProgramOptions, events: MacroInvocationEvents): Promise<MacroWorkerResult> {
    const program = buildWithoutMacros(ts, options);
    const host = options.host as MacroCompilerHost;
    const result = await expandCompileTimeMacros({ ts, program, host, getSyntax, createProgram: next => buildWithoutMacros(ts, next), ...events }, /*allowAsync*/ true);
    return {
        expansions: result.invocations.map(({ fileName, start, end, macroName, text }) => ({ fileName, start, end, macroName, text })),
        diagnostics: [...result.diagnostics, ...reportMacroOptionDiagnostics(ts, program, getSyntax)].map(diagnostic => ({
            fileName: diagnostic.file?.fileName,
            start: diagnostic.start,
            length: diagnostic.length,
            code: diagnostic.code,
            category: diagnostic.category,
            messageText: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
        })),
    };
}

export function createMacroRebuilder(ts: TSPPTypeScript): TSPPProgramRebuilder {
    return {
        id: "compile-time-macros",
        rebuild(program, request) {
            if (building || !program.getSourceFiles().some(sourceFile => getSyntax(sourceFile))) return undefined;
            const host = request.host as MacroCompilerHost;
            const optionDiagnostics = reportMacroOptionDiagnostics(ts, program, getSyntax);
            const hasInvocations = program.getSourceFiles().some(sourceFile => !sourceFile.isDeclarationFile && getSyntax(sourceFile)?.invocations.length);
            if (!hasInvocations && !optionDiagnostics.length) return undefined;
            const finish = (result: MacroExpansionResult) => createRebuild(ts, program, result, optionDiagnostics);
            const expansion = {
                ts,
                program,
                host,
                getSyntax,
                createProgram: (options: TS.CreateProgramOptions) => buildWithoutMacros(ts, options),
                invalidate: request.invalidate,
            };
            if (!request.async) return finish(expandCompileTimeMacros(expansion, /*allowAsync*/ false));
            if (request.compilerModulePath && !host.disableMacroWorkers && !host.evaluateMacroModule && canUseMacroWorkers()) {
                return runMacroExpansionWorker(program, request.compilerModulePath, host, sourceFile => getSyntax(sourceFile)?.original ?? sourceFile.text).then(
                    result => finish(restoreWorkerResult(ts, program, result)),
                    error => {
                        if (!(error instanceof MacroWorkerError)) throw error;
                        return finish(workerFailureResult(ts, program, error));
                    },
                );
            }
            return expandCompileTimeMacros(expansion, /*allowAsync*/ true).then(finish);
        },
    };
}

/**
 * Replaces each projected invocation with a statement that only names the macro and its targets in types, so the
 * rebuilt program still resolves, highlights, and counts them, followed by the generated statements. The naming
 * statement is removed before JavaScript emit.
 */
function createRebuild(ts: TSPPTypeScript, program: TS.Program, result: MacroExpansionResult, optionDiagnostics: readonly TS.Diagnostic[]): TSPPProgramRebuild {
    const checker = program.getTypeChecker();
    const factory = ts.factory;
    const replacements = new Map<string, TSPPStatementReplacement[]>();
    const anchors = new Set<string>();
    const namingStatements = new WeakSet<TS.Node>();
    const expansions: MacroExpansion[] = [];
    const byFile = new Map<string, ExpandedMacroInvocation[]>();
    for (const invocation of result.invocations) {
        const list = byFile.get(invocation.fileName);
        if (list) list.push(invocation);
        else byFile.set(invocation.fileName, [invocation]);
    }
    for (const sourceFile of program.getSourceFiles()) {
        const syntax = getSyntax(sourceFile);
        if (!syntax?.invocations.length) continue;
        const expanded = byFile.get(sourceFile.fileName) ?? [];
        replacements.set(sourceFile.fileName, syntax.invocations.map(invocation => {
            const generated = expanded.find(candidate => candidate.start === invocation.start && candidate.end === invocation.end);
            const meanings = getTargetMeanings(sourceFile, invocation.start, invocation.end);
            anchors.add(`${sourceFile.fileName}:${invocation.end}`);
            expansions.push({
                fileName: sourceFile.fileName,
                start: invocation.start,
                length: invocation.end - invocation.start,
                macroName: invocation.macro.text,
                text: generated?.text ?? "",
            });
            return {
                start: invocation.start,
                end: invocation.end,
                replace: statement => {
                    const elements = ts.isExpressionStatement(statement) ? getProjectedElements(ts, statement) : undefined;
                    if (!elements || !ts.isExpressionStatement(statement)) return [statement, ...generated?.statements ?? []];
                    const types = elements.map((element, index) => {
                        const name = toEntityName(element);
                        if (!name) return factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);
                        const type = index === 0 || meanings[index] !== "type" ? factory.createTypeQueryNode(name) : factory.createTypeReferenceNode(name);
                        return ts.setTextRange(type, { pos: element.pos, end: element.end });
                    });
                    // Every node keeps a source range, so editor services find the names and skip the rest.
                    const list = ts.setTextRange(factory.createNodeArray(types), elements);
                    const tuple = ts.setTextRange(factory.createTupleTypeNode(list), { pos: elements.pos, end: elements.end });
                    const empty = { pos: statement.expression.pos, end: statement.expression.pos };
                    const unknown = ts.setTextRange(factory.createAsExpression(
                        ts.setTextRange(factory.createNumericLiteral(0), empty),
                        ts.setTextRange(factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword), empty),
                    ), empty);
                    const expression = ts.setTextRange(factory.createAsExpression(unknown, tuple), statement.expression);
                    const naming = ts.setTextRange(factory.createExpressionStatement(expression), statement);
                    namingStatements.add(naming);
                    return [naming, ...generated?.statements ?? []];
                },
            };
        }));
    }
    const fileNames = new Set(replacements.keys());
    const erase: TS.TransformerFactory<TS.SourceFile> = context => sourceFile => {
        if (!fileNames.has(sourceFile.fileName)) return sourceFile;
        const visit = (node: TS.Node): TS.Node => namingStatements.has(node) ? factory.createNotEmittedStatement(node) : ts.visitEachChild(node, visit, context);
        return ts.visitEachChild(sourceFile, visit, context);
    };
    return {
        replacements,
        diagnostics: [...result.diagnostics, ...optionDiagnostics],
        // Generated declarations have no source text to edit, so reporting them as unused is not actionable.
        filterDiagnostic: diagnostic =>
            !(diagnostic.length === 0 && unusedDiagnosticCodes.has(diagnostic.code) && diagnostic.file && anchors.has(`${diagnostic.file.fileName}:${diagnostic.start}`)),
        transformers: { before: [erase] },
        onRebuilt: rebuilt => expansionsByProgram.set(rebuilt, expansions),
    };

    /** Whether each name of a projected invocation is a value (named with `typeof`) or only a type. */
    function getTargetMeanings(sourceFile: TS.SourceFile, start: number, end: number): readonly ("value" | "type")[] {
        const statement = findStatement(ts, sourceFile, start, end);
        const elements = statement && ts.isExpressionStatement(statement) ? getProjectedElements(ts, statement) : undefined;
        return (elements ?? []).map(element => {
            const symbol = resolve(element);
            return symbol && !(symbol.flags & ts.SymbolFlags.Value) && symbol.flags & ts.SymbolFlags.Type ? "type" : "value";
        });
    }

    function resolve(element: TS.Expression): TS.Symbol | undefined {
        let symbol: TS.Symbol | undefined;
        if (ts.isIdentifier(element)) {
            symbol = checker.getSymbolAtLocation(element)
                ?? checker.getSymbolsInScope(element, ts.SymbolFlags.Type | ts.SymbolFlags.Namespace | ts.SymbolFlags.Alias).find(candidate => ts.symbolName(candidate) === ts.idText(element));
        }
        else if (ts.isPropertyAccessExpression(element)) {
            let left = resolve(element.expression);
            if (left && left.flags & ts.SymbolFlags.Alias) left = checker.getAliasedSymbol(left);
            symbol = checker.getSymbolAtLocation(element.name) ?? left?.exports?.get(ts.escapeLeadingUnderscores(ts.idText(element.name)));
        }
        // A module's exported declarations appear in its scope as local placeholders without meanings of their own.
        if (symbol) symbol = checker.getExportSymbolOfSymbol(symbol);
        return symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
    }

    /** `a.b.c` as an entity name whose identifiers keep their source positions. */
    function toEntityName(expression: TS.Expression): TS.EntityName | undefined {
        if (ts.isIdentifier(expression)) return ts.setTextRange(factory.createIdentifier(ts.idText(expression)), expression);
        if (!ts.isPropertyAccessExpression(expression) || !ts.isIdentifier(expression.name)) return undefined;
        const left = toEntityName(expression.expression);
        if (!left) return undefined;
        const right = ts.setTextRange(factory.createIdentifier(ts.idText(expression.name)), expression.name);
        return ts.setTextRange(factory.createQualifiedName(left, right), expression);
    }
}

function restoreWorkerResult(ts: TSPPTypeScript, program: TS.Program, result: MacroWorkerResult): MacroExpansionResult {
    const invocations: ExpandedMacroInvocation[] = result.expansions.map(expansion => {
        const generated = ts.createSourceFile(`${expansion.fileName}.macro-result.ts`, expansion.text, ts.ScriptTarget.Latest, /*setParentNodes*/ true, ts.ScriptKind.TS);
        for (const statement of generated.statements) markSynthetic(ts, statement);
        return { ...expansion, statements: generated.statements };
    });
    const diagnostics = result.diagnostics.map(item => ({
        category: item.category as TS.DiagnosticCategory,
        code: item.code,
        file: item.fileName === undefined ? undefined : program.getSourceFile(item.fileName),
        start: item.start,
        length: item.length,
        messageText: item.messageText,
    }));
    return { invocations, diagnostics };
}

/** A worker that timed out or crashed still owes the program a rebuild, with the failure on the running invocation. */
function workerFailureResult(ts: TSPPTypeScript, program: TS.Program, error: MacroWorkerError): MacroExpansionResult {
    const sourceFile = error.fileName === undefined ? undefined : program.getSourceFile(error.fileName);
    if (!sourceFile || error.start === undefined || error.length === undefined) throw error;
    const macroName = error.macroName ?? "macro";
    return {
        invocations: [],
        diagnostics: [{
            category: ts.DiagnosticCategory.Error,
            code: 18080,
            file: sourceFile,
            start: error.start,
            length: error.length,
            messageText: `Macro '${macroName}' failed: ${error.message}`,
        }],
    };
}

/** Parsed worker results carry positions in another text; without positions they print and check as generated nodes. */
function markSynthetic(ts: TSPPTypeScript, node: TS.Node): void {
    ts.setTextRange(node, { pos: -1, end: -1 });
    ts.forEachChild(node, child => markSynthetic(ts, child));
}
