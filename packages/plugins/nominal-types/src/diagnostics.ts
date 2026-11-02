import type { TSPPDiagnosticProvider, TSPPTypeScript } from "@tspp/plugin-sdk/compiler";
import type * as TS from "typescript-upstream";

import type { NominalDeclarations } from "./declarations";
import type { LoweredMatch, MatchPattern, ValueMatches } from "./match";

interface VariantInfo {
    readonly fieldNames: readonly string[];
    readonly fieldTypes: readonly TS.Type[];
}

/**
 * Reports what the lowered TypeScript cannot: a `newtype` over `any`, `unknown`, or `never`, and `match` patterns
 * that are unknown, malformed, duplicated, or not exhaustive. The tag tests a lowered `match` generates sit at zero
 * width inside it; the checker's comparison and narrowing errors on them only restate pattern errors and are dropped.
 */
/** Unused-declaration codes, which on a declaration's generated companions would only invite deleting them. */
const unusedCodes = new Set([6133, 6138, 6192, 6196, 6198, 6199, 6205]);

export function createNominalDiagnostics(ts: TSPPTypeScript, declarations: NominalDeclarations, values: ValueMatches): TSPPDiagnosticProvider {
    const matchRanges = new WeakMap<TS.SourceFile, readonly LoweredMatch[]>();

    function matchesIn(sourceFile: TS.SourceFile): readonly LoweredMatch[] {
        let found = matchRanges.get(sourceFile);
        if (!found) {
            const list: LoweredMatch[] = [];
            const visit = (node: TS.Node): void => {
                const lowered = values.matches.get(node);
                if (lowered) list.push(lowered);
                ts.forEachChild(node, visit);
            };
            if (values.count()) visit(sourceFile);
            matchRanges.set(sourceFile, found = list);
        }
        return found;
    }

    function tokenStart(sourceFile: TS.SourceFile, pos: number): number {
        const scanner = ts.createScanner(ts.ScriptTarget.Latest, /*skipTrivia*/ true, ts.LanguageVariant.Standard, sourceFile.text, undefined, pos);
        scanner.scan();
        return scanner.getTokenStart();
    }

    function checkMatch(match: LoweredMatch, checker: TS.TypeChecker, report: (code: number, message: string) => void): void {
        // A variable's declared type lists every variant; its narrowed type after an assignment may list only one.
        const entity = ts.isIdentifier(match.scrutinee) ? match.scrutinee : ts.isPropertyAccessExpression(match.scrutinee) ? match.scrutinee.name : undefined;
        const symbol = entity && checker.getSymbolAtLocation(entity);
        const matchedType = symbol && symbol.flags & (ts.SymbolFlags.Variable | ts.SymbolFlags.Property) ? checker.getTypeOfSymbol(symbol) : checker.getTypeAtLocation(match.scrutinee);
        const variantsOf = (type: TS.Type): Map<string, VariantInfo> => {
            const result = new Map<string, VariantInfo>();
            // Type objects of the command-line compiler have no helper methods, so read their flags.
            for (const constituent of type.flags & ts.TypeFlags.Union ? (type as TS.UnionType).types : [type]) {
                const tag = checker.getPropertyOfType(constituent, "_tag");
                const tagType = tag && checker.getTypeOfSymbol(tag) as TS.StringLiteralType | undefined;
                if (!tagType || !(tagType.flags & ts.TypeFlags.StringLiteral)) continue;
                const values = checker.getPropertyOfType(constituent, "_values");
                const valuesType = values && checker.getTypeOfSymbol(values);
                const fieldTypes = valuesType && checker.isTupleType(valuesType) ? checker.getTypeArguments(valuesType as TS.TypeReference) : [];
                const fieldNames = checker.getPropertiesOfType(constituent).map(property => ts.symbolName(property))
                    .filter(name => name !== "_tag" && name !== "_values" && name !== "__tsppNominal");
                result.set(tagType.value, { fieldNames, fieldTypes });
            }
            return result;
        };
        const variants = variantsOf(matchedType);
        const checkPattern = (pattern: MatchPattern, info: VariantInfo, invalid: { value: boolean; }): boolean => {
            if (pattern.elements.length !== info.fieldTypes.length) {
                invalid.value = true;
                report(18064, `Pattern '${pattern.variant}' expects ${info.fieldTypes.length} fields, but received ${pattern.elements.length}.`);
            }
            let irrefutable = true;
            const count = Math.min(pattern.elements.length, info.fieldTypes.length);
            for (let index = 0; index < count; index++) {
                const element = pattern.elements[index];
                if (element.kind !== "constructor") continue;
                irrefutable = false;
                const nested = variantsOf(info.fieldTypes[index]).get(element.variant);
                if (!nested) {
                    invalid.value = true;
                    report(18063, `Pattern '${element.variant}' does not belong to data type '${info.fieldNames[index] ?? index}'.`);
                    continue;
                }
                checkPattern(element, nested, invalid);
            }
            return irrefutable;
        };
        const isCovered = (patterns: readonly MatchPattern[], info: VariantInfo): boolean => {
            if (patterns.length === 0) return false;
            if (patterns.some(pattern => !pattern.elements.some(element => element.kind === "constructor"))) return true;
            for (let fieldIndex = 0; fieldIndex < info.fieldTypes.length; fieldIndex++) {
                const nestedPatterns: MatchPattern[] = [];
                let onlyThisFieldIsRefutable = true;
                for (const pattern of patterns) {
                    pattern.elements.forEach((element, index) => {
                        if (element.kind !== "constructor") return;
                        if (index === fieldIndex) nestedPatterns.push(element);
                        else onlyThisFieldIsRefutable = false;
                    });
                }
                if (!onlyThisFieldIsRefutable || nestedPatterns.length === 0) continue;
                const nestedVariants = variantsOf(info.fieldTypes[fieldIndex]);
                if (nestedVariants.size > 0 && [...nestedVariants].every(([name, nested]) => isCovered(nestedPatterns.filter(pattern => pattern.variant === name), nested))) return true;
            }
            return false;
        };

        const covered = new Set<string>();
        const unguardedPatterns = new Map<string, MatchPattern[]>();
        const invalid = { value: false };
        let hasWildcard = false;
        for (const arm of match.arms) {
            const wildcard = arm.patterns.find(pattern => pattern.variant === "_");
            if (hasWildcard) {
                report(18066, "A branch after the wildcard pattern is unreachable.");
                continue;
            }
            if (wildcard) {
                if (arm.patterns.length > 1) report(18067, "The wildcard pattern cannot be combined with other patterns.");
                if (wildcard.elements.length > 0) report(18068, "The wildcard pattern cannot contain nested patterns.");
                if (!arm.guarded) hasWildcard = true;
                continue;
            }
            if (arm.patterns.length > 1 && arm.patterns.some(pattern => pattern.elements.length > 0)) {
                report(18069, "Or-patterns support only variants without fields.");
            }
            const seenInArm = new Set<string>();
            for (const pattern of arm.patterns) {
                const info = variants.get(pattern.variant);
                if (!info) {
                    report(18063, `Pattern '${pattern.variant}' does not belong to data type '${checker.typeToString(matchedType)}'.`);
                    continue;
                }
                if (covered.has(pattern.variant) || seenInArm.has(pattern.variant)) {
                    report(18070, `Duplicate match branch for pattern '${pattern.variant}'.`);
                    continue;
                }
                seenInArm.add(pattern.variant);
                const irrefutable = checkPattern(pattern, info, invalid);
                if (arm.guarded) continue;
                if (irrefutable) covered.add(pattern.variant);
                else {
                    const patterns = unguardedPatterns.get(pattern.variant);
                    if (patterns) patterns.push(pattern);
                    else unguardedPatterns.set(pattern.variant, [pattern]);
                }
            }
        }
        if (!hasWildcard && variants.size > 0) {
            const missing = [...variants].filter(([name, info]) => !covered.has(name) && !isCovered(unguardedPatterns.get(name) ?? [], info)).map(([name]) => name);
            if (missing.length) report(18065, `Non-exhaustive match. Missing patterns: ${missing.join(", ")}.`);
        }
    }

    /**
     * Newtype constructors are erased abstractions: they may be called, named in `typeof`, imported, and exported, but a
     * value reference anywhere else would let the constructor escape into runtime values (TS18062, as before the
     * lowering moved out of the core).
     */
    function escapingConstructorReferences(sourceFile: TS.SourceFile, checker: TS.TypeChecker): TS.Identifier[] {
        const found: TS.Identifier[] = [];
        const visit = (node: TS.Node): void => {
            // Types (including `typeof` queries), imports, and exports never use the constructor as a value.
            if (node.pos < 0 || ts.isTypeNode(node) && !ts.isExpressionWithTypeArguments(node) || ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node) || ts.isExportDeclaration(node)) return;
            if (ts.isIdentifier(node)) {
                if (isValueReference(node)) {
                    let symbol = ts.isShorthandPropertyAssignment(node.parent) ? checker.getShorthandAssignmentValueSymbol(node.parent) : checker.getSymbolAtLocation(node);
                    if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
                    if (symbol?.declarations?.some(declarations.isNewtypeConstructor)) found.push(node);
                }
                return;
            }
            ts.forEachChild(node, visit);
        };
        visit(sourceFile);
        return found;
    }

    function isValueReference(node: TS.Identifier): boolean {
        const parent = node.parent;
        if (ts.isCallExpression(parent) && parent.expression === node) return false;
        if (ts.isPropertyAccessExpression(parent)) return parent.name !== node;
        if (ts.isShorthandPropertyAssignment(parent)) return parent.name === node;
        if (ts.isPropertyAssignment(parent) || ts.isBindingElement(parent) || ts.isPropertyDeclaration(parent) || ts.isMethodDeclaration(parent)
            || ts.isPropertySignature(parent) || ts.isEnumMember(parent) || ts.isGetAccessor(parent) || ts.isSetAccessor(parent)) {
            return (parent as TS.Node & { readonly name?: TS.Node; }).name !== node && (!ts.isBindingElement(parent) || parent.propertyName !== node);
        }
        if (ts.isLabeledStatement(parent) || ts.isBreakOrContinueStatement(parent) || ts.isJsxAttribute(parent)) return false;
        const named = parent as TS.Node & { readonly name?: TS.Node; };
        return named.name !== node || ts.isExportAssignment(parent);
    }

    return {
        id: "nominal-types",
        getSemanticDiagnostics: (sourceFile, checker) => {
            const diagnostics: TS.Diagnostic[] = [];
            const error = (start: number, end: number, code: number, messageText: string) =>
                diagnostics.push({ category: ts.DiagnosticCategory.Error, code, file: sourceFile, start, length: end - start, messageText });
            if (declarations.newtypeCount()) {
                for (const reference of escapingConstructorReferences(sourceFile, checker)) {
                    error(tokenStart(sourceFile, reference.pos), reference.end, 18062, `The extension value '${ts.idText(reference)}' can only be used as the target of a direct call.`);
                }
                const visit = (node: TS.Node): void => {
                    const underlying = declarations.newtypes.get(node);
                    if (underlying) {
                        const type = checker.getTypeFromTypeNode(underlying);
                        if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)) {
                            error(tokenStart(sourceFile, underlying.pos), underlying.end, 18075, "A nominal type cannot use 'any', 'unknown', or 'never' as its underlying type.");
                        }
                    }
                    ts.forEachChild(node, visit);
                };
                visit(sourceFile);
            }
            for (const match of matchesIn(sourceFile)) {
                // A match whose arms never read the scrutinee (only `_`, or arms lost to syntax errors) has nothing to check.
                if (!match.scrutinee.parent) continue;
                const start = tokenStart(sourceFile, match.start);
                checkMatch(match, checker, (code, message) => error(start, match.end, code, message));
            }
            return diagnostics;
        },
        filterDiagnostic: diagnostic => {
            if (!diagnostic.file || diagnostic.start === undefined) return true;
            const start = diagnostic.start;
            // Generated declarations are empty; an unused one, such as a brand's private member, has no source to delete.
            // Only this plugin's own declarations: other plugins lower to empty nodes too and may move such a diagnostic
            // onto authored text (type-computation reports an unused `let` binding on its name).
            if (unusedCodes.has(diagnostic.code) && (diagnostic.length === 0
                ? declarations.isGeneratedDeclaration(diagnostic.file, start)
                : declarations.isCompanionName(diagnostic.file, start))) return false;
            return !matchesIn(diagnostic.file).some(match =>
                diagnostic.length === 0 && match.start <= start && start <= match.end
                || match.patternRanges.some(range => range.start <= start && start < range.end));
        },
    };
}
