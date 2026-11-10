import { maskNonCode } from "@tspp/plugin-sdk";
import type { TSPPAnalysisArtifact, TSPPAnalysisDiagnostic, TSPPDiagnosticProvider, TSPPProgramAnalyzer, TSPPSourcePreprocessor, TSPPSyntaxCursor, TSPPTypeScript } from "@tspp/plugin-sdk/compiler";
import type * as TS from "typescript-upstream";

import {
    checkMlttType,
    inferMlttType,
    MlttTypeError,
    mlttBoolType,
    mlttFalse,
    mlttNatType,
    mlttSuccessor,
    mlttTrue,
    mlttZero,
    normalizeMlttTerm,
    printMlttTerm,
    type MlttExternal,
    type MlttTerm,
} from "./core";
import { indexedAccessLocations, keywordTypes, lowerTermToTypeNode } from "./lower";
import { termToKind, type TypeSyntaxModel } from "./kinds";
import { indexedAccessKey, parseDependentTypeText, startsBuiltinTerm, TermParser, type IndexedAccessLocation, type TermLocation, type TermTokens } from "./term-parser";

// Terms of the dependent type theory inside ordinary type syntax: the parts of an alias TypeScript has no spelling for.
// The kernel in `core` checks them and works out what they compute; `lower` hands the result to TypeScript as a type.

export function parseDependentType(text: string, aliases: ReadonlyMap<string, MlttTerm> = new Map()): MlttTerm {
    return parseDependentTypeText(text, aliases);
}

export function inferDependentTypeUniverse(term: MlttTerm): number {
    const inferred = normalizeMlttTerm(inferMlttType(term));
    if (inferred.kind !== "universe") {
        throw new Error("The right-hand side is a term, not a type.");
    }
    return inferred.level;
}

/** Tokens of the compiler's parser; `->` is two tokens there. */
export function cursorTokens(ts: TSPPTypeScript, cursor: TSPPSyntaxCursor): TermTokens {
    const kinds = ts.SyntaxKind;
    const text = () => {
        if (cursor.token() === kinds.EndOfFileToken) return undefined;
        return cursor.tokenText();
    };
    const isArrow = () => cursor.token() === kinds.MinusToken && cursor.lookAhead(() => cursor.nextToken() === kinds.GreaterThanToken && !cursor.hasPrecedingLineBreak());
    const current = () => isArrow() ? "->" : text();
    const advance = () => {
        if (isArrow()) cursor.nextToken();
        cursor.nextToken();
    };
    return {
        peek: (offset = 0) => {
            if (offset === 0) return current();
            return cursor.lookAhead(() => {
                for (let index = 0; index < offset; index++) advance();
                return current();
            });
        },
        next: advance,
        position: () => cursor.getTokenStart(),
    };
}

/** A declaration keyword followed by the name it declares: TypeScript's own, and those active plugins claim. */
function declaredNames(model: TypeSyntaxModel): RegExp {
    const keywords = ["type", "interface", "class", "enum", ...model.getDeclarationKeywords().filter(keyword => /^[A-Za-z]\w*$/.test(keyword))];
    return new RegExp(`\\b(?:${keywords.join("|")})\\s+([A-Za-z_$][\\w$]*)`, "g");
}

const namedImports = /\bimport\s+(?:type\s+)?(?:([A-Za-z_$][\w$]*)\s*,?\s*)?(?:\{([^}]*)\})?\s*from\b/g;

/** The names a file declares or imports itself; a type named `Pair` there is that type, not the built-in term. */
export function fileDeclaredNames(model: TypeSyntaxModel, sourceText: string): ReadonlySet<string> {
    const file = fileStateOf(model, sourceText);
    if (file.declared) return file.declared;
    const code = maskNonCode(sourceText);
    const names = new Set<string>();
    for (const match of code.matchAll(declaredNames(model))) names.add(match[1]);
    for (const match of code.matchAll(namedImports)) {
        if (match[1]) names.add(match[1]);
        for (const part of match[2]?.split(",") ?? []) {
            const name = part.trim().split(/\s+as\s+/).pop()?.replace(/^type\s+/, "");
            if (name) names.add(name);
        }
    }
    return file.declared = names;
}

function fileStateOf(model: TypeSyntaxModel, sourceText: string) {
    if (model.file?.sourceText !== sourceText) model.file = { sourceText, aliases: new Map() };
    // Keep this very string: comparing an equal copy, as of a file parsed again, reads all of it on every call.
    model.file.sourceText = sourceText;
    return model.file;
}

/** Earlier aliases of the file being parsed, by name; a term refers to them by what they compute. */
export function fileAliases(model: TypeSyntaxModel, sourceText: string): Map<string, MlttTerm> {
    return fileStateOf(model, sourceText).aliases;
}

export function isTermStart(ts: TSPPTypeScript, model: TypeSyntaxModel, cursor: TSPPSyntaxCursor): boolean {
    const kinds = ts.SyntaxKind;
    if (cursor.token() === kinds.OpenParenToken || cursor.token() === kinds.OpenBraceToken) return isBinderStart(cursor, kinds);
    if (cursor.token() === kinds.LessThanToken) return isTermLambdaStart(ts, model, cursor);
    if (cursor.token() !== kinds.Identifier) return false;
    const name = cursor.tokenText();
    // An earlier alias with a term of its own, applied: `Inc<Two>` computes.
    if (fileAliases(model, cursor.getSourceText()).get(name)?.kind === "lambda") return cursor.lookAhead(() => cursor.nextToken() === kinds.LessThanToken);
    if (!startsBuiltinTerm(name, "<")) return false;
    if (fileDeclaredNames(model, cursor.getSourceText()).has(name)) return false;
    return startsBuiltinTerm(name, cursor.lookAhead(() => (cursor.nextToken(), cursor.tokenText())));
}

/**
 * `<n: Nat> =>> Succ<n>`, a function over values that the kernel computes. A constructor over types, or one whose body
 * is no term, such as `<N: Nat> =>> { length: N }`, stays a type constructor, which TypeScript instantiates.
 */
function isTermLambdaStart(ts: TSPPTypeScript, model: TypeSyntaxModel, cursor: TSPPSyntaxCursor): boolean {
    const kinds = ts.SyntaxKind;
    return cursor.lookAhead(() => {
        const sourceText = cursor.getSourceText();
        try {
            const term = new TermParser(cursorTokens(ts, cursor), {
                aliases: fileAliases(model, sourceText),
                shadowed: fileDeclaredNames(model, sourceText),
            }).parseOne();
            if (term.kind !== "lambda") return false;
            for (let current: MlttTerm = term; current.kind === "lambda"; current = current.body) {
                if (!current.parameterType || termToKind(current.parameterType).kind !== "term") return false;
            }
            return cursor.token() === kinds.SemicolonToken || cursor.token() === kinds.EndOfFileToken || cursor.hasPrecedingLineBreak();
        }
        catch {
            return false;
        }
    });
}

/**
 * A term with the TypeScript types it names replaced by what the checker knows of them: an alias anywhere, with a term
 * of its own, by that term, and a declaration with a kind, by a value of that kind. Parsing only knows earlier aliases
 * of the same file. Returns `term` itself when nothing changed.
 */
export function resolveTermNames(ts: TSPPTypeScript, model: TypeSyntaxModel, checker: TS.TypeChecker, term: MlttTerm, location: TS.Node, expected?: MlttTerm): MlttTerm {
    const visiting = new Set<TS.Symbol>();
    const accessesByRoot = new Map<TS.Node, Map<IndexedAccessLocation, TS.IndexedAccessTypeNode>>();
    const resolve = (current: MlttTerm, root: TS.Node, expectedKind?: MlttTerm["kind"]): MlttTerm => {
        const external = current.kind === "external" && current.identity ? current : undefined;
        if (external?.key === indexedAccessKey) {
            if (expectedKind !== "nat-type" && expectedKind !== "bool-type") return current;
            const access = indexedAccesses(root).get(external.identity as IndexedAccessLocation);
            if (!access) return current;
            const type = checker.getTypeFromTypeNode(access);
            const constraint = checker.getBaseConstraintOfType(type) ?? type;
            return resolveIndexedValue(ts, checker, external, constraint, expectedKind);
        }
        if (external && !keywordTypes.has(external.key)) {
            let symbol = checker.resolveName(external.key, root, ts.SymbolFlags.Type | ts.SymbolFlags.Alias, /*excludeGlobals*/ false);
            if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
            const declaration = symbol?.declarations?.[0];
            if (symbol && declaration && !visiting.has(symbol)) {
                if (ts.isTypeAliasDeclaration(declaration)) {
                    const body = model.terms.get(declaration.type);
                    if (body) {
                        visiting.add(symbol);
                        const resolved = resolve(body, declaration.type, expectedKind);
                        visiting.delete(symbol);
                        return resolved;
                    }
                }
                const kind = model.declarationKinds.get(declaration);
                if (kind?.kind === "term") return { ...external, type: kind.term };
            }
        }
        return mapChildren(current, (child, key) => resolve(child, root, expectedChildKind(current, key, expectedKind)));
    };
    return resolve(term, location, expected?.kind);

    function indexedAccesses(root: TS.Node): Map<IndexedAccessLocation, TS.IndexedAccessTypeNode> {
        const cached = accessesByRoot.get(root);
        if (cached) return cached;
        const accesses = new Map<IndexedAccessLocation, TS.IndexedAccessTypeNode>();
        const visit = (node: TS.Node): void => {
            if (ts.isIndexedAccessTypeNode(node)) {
                const location = indexedAccessLocations.get(node);
                if (location) accesses.set(location, node);
            }
            ts.forEachChild(node, visit);
        };
        visit(root);
        accessesByRoot.set(root, accesses);
        return accesses;
    }
}

/** An indexed access is an ordinary TypeScript type until used as a natural or boolean value. */
function expectedChildKind(term: MlttTerm, child: string, expected: MlttTerm["kind"] | undefined): MlttTerm["kind"] | undefined {
    switch (term.kind) {
        case "successor":
        case "nat-add": return "nat-type";
        case "nat-elim": return child === "scrutinee" ? "nat-type" : undefined;
        case "bool-elim": return child === "scrutinee" ? "bool-type" : child === "motive" ? undefined : expected;
        case "identity-type":
        case "identity-elim": return child === "left" || child === "right" ? term.type.kind : undefined;
        case "refl":
        case "annotation": return child === "term" ? term.type.kind : undefined;
        case "application": return child === "argument" && term.functionTerm.kind === "lambda" ? term.functionTerm.parameterType?.kind : undefined;
        default: return undefined;
    }
}

function resolveIndexedValue(ts: TSPPTypeScript, checker: TS.TypeChecker, access: MlttExternal, type: TS.Type, expected: "nat-type" | "bool-type"): MlttTerm {
    if (expected === "bool-type") {
        if (type === checker.getTrueType()) return mlttTrue();
        if (type === checker.getFalseType()) return mlttFalse();
        return type.flags & ts.TypeFlags.Boolean ? { ...access, type: mlttBoolType() } : access;
    }
    const isNatural = (candidate: TS.Type): candidate is TS.NumberLiteralType => {
        if (!(candidate.flags & ts.TypeFlags.NumberLiteral)) return false;
        const { value } = candidate as TS.NumberLiteralType;
        return Number.isSafeInteger(value) && value >= 0;
    };
    if (!isNatural(type)) {
        const isNaturalUnion = (type.flags & ts.TypeFlags.Union) && (type as TS.UnionType).types.every(isNatural);
        return isNaturalUnion ? { ...access, type: mlttNatType() } : access;
    }
    // A natural's normal form is unary, so keep large literals opaque rather than exhausting the stack.
    if (type.value > 1024) return { ...access, type: mlttNatType() };
    let value: MlttTerm = mlttZero();
    for (let index = 0; index < type.value; index++) value = mlttSuccessor(value);
    return value;
}

/** A term with `visit` applied to its direct subterms; the term itself when none of them changed. */
function mapChildren(term: MlttTerm, visit: (term: MlttTerm, key: string) => MlttTerm): MlttTerm {
    let changed = false;
    const mapped = Object.fromEntries(Object.entries(term).map(([key, value]) => {
        const next = mapValue(value, child => visit(child, key));
        if (next !== value) changed = true;
        return [key, next];
    }));
    return changed ? mapped as unknown as MlttTerm : term;
}

function mapValue(value: unknown, visit: (term: MlttTerm) => MlttTerm): unknown {
    if (Array.isArray(value)) {
        const next = value.map(item => mapValue(item, visit));
        return next.some((item, index) => item !== value[index]) ? next : value;
    }
    if (!value || typeof value !== "object") return value;
    if ("kind" in value) return visit(value as MlttTerm);
    // A case of a match on types, or one of its captures.
    let changed = false;
    const mapped = Object.fromEntries(Object.entries(value).map(([key, child]) => {
        const next = mapValue(child, visit);
        if (next !== child) changed = true;
        return [key, next];
    }));
    return changed ? mapped : value;
}

/** `(name: ...) ->` or `{name: ...} ->`, which an object or function type cannot continue into. */
function isBinderStart(cursor: TSPPSyntaxCursor, kinds: TSPPTypeScript["SyntaxKind"]): boolean {
    return cursor.lookAhead(() => {
        const open = cursor.token();
        const close = open === kinds.OpenParenToken ? kinds.CloseParenToken : kinds.CloseBraceToken;
        cursor.nextToken();
        if (cursor.token() !== kinds.Identifier) return false;
        cursor.nextToken();
        if (cursor.token() !== kinds.ColonToken) return false;
        let depth = 1;
        while (depth > 0) {
            cursor.nextToken();
            if (cursor.token() === kinds.EndOfFileToken) return false;
            if (cursor.token() === open) depth++;
            else if (cursor.token() === close) depth--;
        }
        return cursor.nextToken() === kinds.MinusToken && cursor.nextToken() === kinds.GreaterThanToken;
    });
}

/** Parses a term at the cursor and lowers it to the type node that stands for it. */
export function parseTermType(ts: TSPPTypeScript, model: TypeSyntaxModel, cursor: TSPPSyntaxCursor, start: number): TS.TypeNode {
    const sourceText = cursor.getSourceText();
    let term: MlttTerm | undefined;
    const builtins = new Set<string>();
    try {
        term = new TermParser(cursorTokens(ts, cursor), {
            aliases: fileAliases(model, sourceText),
            shadowed: fileDeclaredNames(model, sourceText),
            onBuiltin: name => builtins.add(name),
        }).parseOne();
    }
    catch (error) {
        const message = (error instanceof Error ? error.message : String(error)).replace(/ \(offset \d+\)$/, "");
        cursor.parseErrorAt(cursor.getTokenStart(), Math.max(cursor.getNodePos(), cursor.getTokenStart() + 1), message, diagnosticCodes.syntax);
        skipToEndOfDeclaration(ts, cursor);
    }
    // Empty, like every generated node: the authored text is no node's, and parent nodes span it.
    const node = term ? lowerTermToTypeNode(ts, cursor, model, term, start) : ts.setTextRange(cursor.factory.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword), { pos: start, end: start });
    if (term) {
        model.terms.set(node, term);
        model.termBuiltins.set(node, builtins);
    }
    model.authored.set(node, start);
    model.authoredEnds.set(node, cursor.getNodePos());
    model.used = true;
    return node;
}

function skipToEndOfDeclaration(ts: TSPPTypeScript, cursor: TSPPSyntaxCursor): void {
    const kinds = ts.SyntaxKind;
    while (cursor.token() !== kinds.SemicolonToken && cursor.token() !== kinds.EndOfFileToken && !cursor.hasPrecedingLineBreak()) cursor.nextToken();
}

const diagnosticCodes = { syntax: 19101, typeError: 19102, unchecked: 19103, shadowedBuiltin: 19104 } as const;
/** TypeScript's own code for the same message. */
const cannotFindName = 2304;
const cannotFindNamespace = 2503;

/** Whether a term is well typed, against an alias's annotation when it has one. Throws what the kernel objects to. */
function checkTerm(term: MlttTerm, annotation: MlttTerm | undefined, name: string | undefined): void {
    if (annotation?.kind === "universe") {
        const level = inferDependentTypeUniverse(term);
        if (level !== annotation.level) throw new Error(`Type '${name}' has kind Type${level}, not Type${annotation.level}.`);
    }
    else if (annotation) checkMlttType(term, annotation);
    else inferMlttType(term);
}

function forEachTerm(ts: TSPPTypeScript, model: TypeSyntaxModel, sourceFile: TS.SourceFile, visitTerm: (node: TS.TypeNode, term: MlttTerm, alias: TS.TypeAliasDeclaration | undefined) => void): void {
    const visit = (node: TS.Node): void => {
        const term = model.terms.get(node);
        if (!term) return void ts.forEachChild(node, visit);
        const alias = ts.isTypeAliasDeclaration(node.parent) && node.parent.type === node ? node.parent : undefined;
        visitTerm(node as TS.TypeNode, term, alias);
    };
    visit(sourceFile);
}

/** The kernel's verdict on every term of a file, reported like any other type error. */
export function createTermDiagnostics(ts: TSPPTypeScript, model: TypeSyntaxModel): TSPPDiagnosticProvider {
    return {
        id: "terms",
        getSemanticDiagnostics(sourceFile, checker) {
            const diagnostics: TS.Diagnostic[] = [];
            /** The TypeScript types a term names must exist; its generated references cannot say where they were written. */
            const reportUnknownNames = (term: unknown, location: TS.Node): void => {
                if (!term || typeof term !== "object") return;
                const external = term as MlttExternal;
                const written = external.kind === "external" ? external.identity as TermLocation | undefined : undefined;
                if (written && external.key !== indexedAccessKey && !keywordTypes.has(external.key) && !checker.resolveName(external.key, location, ts.SymbolFlags.Type | ts.SymbolFlags.Namespace, /*excludeGlobals*/ false)) {
                    diagnostics.push({
                        category: ts.DiagnosticCategory.Error,
                        code: cannotFindName,
                        file: sourceFile,
                        start: written.start,
                        length: written.end - written.start,
                        messageText: `Cannot find name '${external.key}'.`,
                    });
                }
                for (const child of Object.values(term)) {
                    if (Array.isArray(child)) child.forEach(item => reportUnknownNames(item, location));
                    else reportUnknownNames(child, location);
                }
            };
            /** Parsing could only see this file's names: a built-in a type elsewhere also names would silently win over it. */
            const reportShadowedBuiltins = (node: TS.Node, location: TS.Node): void => {
                for (const name of model.termBuiltins.get(node) ?? []) {
                    if (!checker.resolveName(name, location, ts.SymbolFlags.Type, /*excludeGlobals*/ false)) continue;
                    const start = model.authored.get(node) ?? node.pos;
                    diagnostics.push({
                        category: ts.DiagnosticCategory.Error,
                        code: diagnosticCodes.shadowedBuiltin,
                        file: sourceFile,
                        start,
                        length: (model.authoredEnds.get(node) ?? node.end) - start,
                        messageText: `'${name}' here is the built-in term, but a type of that name is in scope. Rename the type, or import it into this file.`,
                    });
                }
            };
            forEachTerm(ts, model, sourceFile, (node, term, alias) => {
                reportUnknownNames(term, alias ?? node);
                reportShadowedBuiltins(node, alias ?? node);
                try {
                    const annotation = alias && model.termAnnotations.get(alias);
                    const resolvedAnnotation = annotation && resolveTermNames(ts, model, checker, annotation, node);
                    checkTerm(resolveTermNames(ts, model, checker, term, node, resolvedAnnotation), resolvedAnnotation, alias && ts.idText(alias.name));
                }
                catch (error) {
                    const start = model.authored.get(node) ?? node.pos;
                    diagnostics.push({
                        category: ts.DiagnosticCategory.Error,
                        code: error instanceof MlttTypeError ? diagnosticCodes.typeError : diagnosticCodes.syntax,
                        file: sourceFile,
                        start,
                        length: (model.authoredEnds.get(node) ?? node.end) - start,
                        messageText: error instanceof Error ? error.message : String(error),
                    });
                }
            });
            return diagnostics;
        },
        // The checker's own report is about a generated reference with no text to point at; this provider reports the name.
        filterDiagnostic: diagnostic => !(diagnostic.length === 0 && (diagnostic.code === cannotFindName || diagnostic.code === cannotFindNamespace)),
    };
}

/** Publishes what each alias's term and type normalize to, for the editor's normal form view. */
export function createNormalFormAnalyzer(ts: TSPPTypeScript, model: TypeSyntaxModel): TSPPProgramAnalyzer {
    return {
        id: "mltt-types",
        async analyze(input) {
            const artifacts: TSPPAnalysisArtifact[] = [];
            const warnings: TSPPAnalysisDiagnostic[] = [];
            for (const { fileName, text } of input.sourceFiles) {
                if (!fileName.endsWith(".tspp")) continue;
                const sourceFile = ts.createSourceFile(`${fileName}.normal-forms.tspp`, text, ts.ScriptTarget.Latest, /*setParentNodes*/ true, ts.ScriptKind.TS);
                forEachTerm(ts, model, sourceFile, (node, term, alias) => {
                    if (model.unchecked.has(node)) {
                        const start = model.authored.get(node) ?? node.pos;
                        warnings.push({
                            fileName,
                            start,
                            length: Math.max(1, (model.authoredEnds.get(node) ?? node.end) - start),
                            code: diagnosticCodes.unchecked,
                            category: "warning",
                            source: "TS++ dependent types",
                            message: "Part of this term has no type in TypeScript: it is 'unknown' there, and only the kernel checks it.",
                        });
                    }
                    if (!alias) return;
                    const name = ts.idText(alias.name);
                    try {
                        const normalType = normalizeMlttTerm(inferMlttType(term));
                        const start = model.authored.get(node) ?? node.pos;
                        artifacts.push({
                            kind: "type-computation/normal-form",
                            fileName,
                            start,
                            length: Math.max(1, (model.authoredEnds.get(node) ?? node.end) - start),
                            name: `${name} normal form`,
                            language: "plaintext",
                            status: "proved",
                            content: `${name} : ${printMlttTerm(normalType)}\n${name} = ${printMlttTerm(normalizeMlttTerm(term))}\n`,
                        });
                    }
                    catch {
                        // The diagnostic provider has already reported why this term does not check.
                    }
                });
            }
            Object.defineProperty(warnings, "artifacts", { value: artifacts });
            return warnings;
        },
    };
}

/** `select<auto, string>(...)` leaves a call's type arguments to inference, by erasing them before parsing. */
export const partialInferencePreprocessor: TSPPSourcePreprocessor = {
    id: "partial-inference",
    claims: [{ keyword: "auto", position: "type" }],
    preprocess(_fileName, source) {
        const code = maskNonCode(source);
        const characters = source.split("");
        for (const match of code.matchAll(/<[^<>\r\n]*\bauto\b[^<>\r\n]*>(?=\s*\()/gu)) {
            for (let index = match.index; index < match.index + match[0].length; index++) characters[index] = " ";
        }
        return characters.join("");
    },
};

/** A type alias with a term body, as a hover shows it. */
export function dependentAliasAt(sourceText: string, position: number): { readonly nameStart: number; readonly nameEnd: number; readonly display: string; } | undefined {
    const code = maskNonCode(sourceText);
    const pattern = /\btype\s+([A-Za-z_$][\w$]*)\s*:\s*([^=;]+?)\s*=(?!>)\s*([^;]+);/g;
    for (const match of code.matchAll(pattern)) {
        const nameStart = match.index + match[0].indexOf(match[1]);
        const nameEnd = nameStart + match[1].length;
        if (nameStart <= position && position <= nameEnd) {
            return { nameStart, nameEnd, display: `type ${match[1]}: ${match[2]} = ${match[3].trim()}` };
        }
    }
    return undefined;
}
