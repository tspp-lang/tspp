import type { TSPPTypeScript } from "@tspp/plugin-sdk/compiler";
import type * as TS from "typescript-upstream";

import { DIAGNOSTIC_MAPPED_SUPER, DIAGNOSTIC_QUALIFIED_SUPER, type MappedEntry, type SelectedSuper } from "./mapped-super";
import type { MultipleBases, MultipleInheritance } from "./multiple-inheritance";

export function resolveMappedIndex(ts: TSPPTypeScript, multiple: MultipleInheritance, info: MultipleBases, entry: Pick<MappedEntry, "key" | "label" | "index">, checker: TS.TypeChecker): number {
    if (entry.label) return entry.index;
    const symbolOf = (node: TS.Expression) => {
        let symbol = checker.getSymbolAtLocation(ts.isPropertyAccessExpression(node) ? node.name : node);
        if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
        return symbol;
    };
    const symbol = symbolOf(entry.key);
    return symbol ? info.bases.findIndex(base => symbolOf(base) === symbol) : entry.index;
}

export function checkMappedSuper(ts: TSPPTypeScript, multiple: MultipleInheritance, declaration: TS.ClassDeclaration, checker: TS.TypeChecker, report: (node: TS.Node, code: number, message: string) => void): void {
    const info = multiple.getMultipleBases(declaration);
    if (!info) return;
    if (info.mapped) {
        const seen = new Set<number>();
        for (const entry of info.mapped.entries) {
            const index = resolveMappedIndex(ts, multiple, info, entry, checker);
            if (entry.index < 0 && index >= 0) report(entry.key, DIAGNOSTIC_MAPPED_SUPER, `Use the base spelling from extends: '${multiple.entityText(info.bases[index])}'; alternate aliases cannot retain its type arguments.`);
            if (index < 0) report(entry.key, DIAGNOSTIC_MAPPED_SUPER, `Unknown mapped super base '${multiple.entityText(entry.key)}'; keys must identify direct bases.`);
            else if (seen.has(index)) report(entry.key, DIAGNOSTIC_MAPPED_SUPER, `Mapped super initializes '${multiple.entityText(info.bases[index])}' more than once.`);
            seen.add(index);
        }
        info.bases.forEach((base, index) => {
            if (!seen.has(index)) report(info.mapped!.call, DIAGNOSTIC_MAPPED_SUPER, `Mapped super is missing direct base '${multiple.entityText(base)}'; supply [] when it takes no arguments.`);
        });
    }
    const checkSelection = (node: TS.Node, selection: SelectedSuper): void => {
        const index = resolveMappedIndex(ts, multiple, info, { ...selection, label: false }, checker);
        if (index < 0) {
            report(node, DIAGNOSTIC_QUALIFIED_SUPER, `Qualified super must select a direct base; '${multiple.entityText(selection.key)}' is not one.`);
            return;
        }
        if (selection.index < 0) report(node, DIAGNOSTIC_QUALIFIED_SUPER, `Use the base spelling from extends: 'super[${multiple.entityText(info.bases[index])}]'; alternate aliases cannot retain its type arguments.`);
        const access = node.parent;
        if (!access || !ts.isPropertyAccessExpression(access) && !ts.isElementAccessExpression(access)) return;
        let outer: TS.Node = access;
        while (outer.parent && (ts.isParenthesizedExpression(outer.parent) || ts.isNonNullExpression(outer.parent) || ts.isAsExpression(outer.parent) || ts.isTypeAssertionExpression(outer.parent) || ts.isSatisfiesExpression(outer.parent))) outer = outer.parent;
        const parent = outer.parent;
        const assigned = (node: TS.Node): boolean => {
            const owner = node.parent;
            if (ts.isBinaryExpression(owner) && owner.left === node && owner.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && owner.operatorToken.kind <= ts.SyntaxKind.LastAssignment) return true;
            if ((ts.isForOfStatement(owner) || ts.isForInStatement(owner)) && owner.initializer === node) return true;
            if (ts.isArrayLiteralExpression(owner) || ts.isObjectLiteralExpression(owner) || ts.isSpreadElement(owner) || ts.isSpreadAssignment(owner)
                || ts.isPropertyAssignment(owner) && owner.initializer === node || ts.isParenthesizedExpression(owner)) return assigned(owner);
            return false;
        };
        if (assigned(outer)
            || (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(parent.operator) || ts.isDeleteExpression(parent)
            || ts.isTaggedTemplateExpression(parent) || ts.isCallExpression(parent) && !!parent.questionDotToken) {
            report(access, DIAGNOSTIC_QUALIFIED_SUPER, "Qualified super supports member reads and calls; assignment, update, delete, and tagged templates are unsupported.");
        }
        const name = ts.isPropertyAccessExpression(access) ? ts.idText(access.name) : ts.isStringLiteralLike(access.argumentExpression) ? access.argumentExpression.text : undefined;
        if (name === undefined) {
            report(access, DIAGNOSTIC_QUALIFIED_SUPER, "A qualified super member must use a fixed property name.");
            return;
        }
        const symbol = checker.getPropertyOfType(checker.getTypeAtLocation(node), name);
        if (symbol?.declarations?.some(member => ts.canHaveModifiers(member) && ts.getModifiers(member)?.some(modifier => modifier.kind === ts.SyntaxKind.AbstractKeyword))) {
            report(access, DIAGNOSTIC_QUALIFIED_SUPER, `Qualified super cannot call abstract member '${name}'.`);
        }
        if (!selection.isStatic && symbol?.declarations?.some(declaration => ts.isPropertyDeclaration(declaration) || ts.isParameter(declaration))) {
            report(access, DIAGNOSTIC_QUALIFIED_SUPER, `Qualified super cannot read instance field '${name}'; select a prototype method or accessor.`);
        }
    };
    const visit = (node: TS.Node): void => {
        if (node !== declaration && ts.isClassLike(node)) return;
        const selection = multiple.getSelectedSuper(node);
        if (selection) checkSelection(node, selection);
        ts.forEachChild(node, visit);
    };
    visit(declaration);
}
