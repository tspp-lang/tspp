import ts from "typescript";
import { refinementFromType } from "./models";
import type { RefinementModel } from "./refinements";

export function isMacroFunction(
    statement: ts.FunctionDeclaration,
    sourceText: string,
    sourceFile: ts.SourceFile,
): boolean {
    const headerEnd = statement.body?.getStart(sourceFile) ?? statement.end;
    const headerStart = Math.max(0, statement.getStart(sourceFile) - 32);
    return /\bmacro\s+function\b/.test(sourceText.slice(headerStart, headerEnd));
}

export function collectTopLevelProofVariables(
    sourceFile: ts.SourceFile,
    refinements: ReadonlyMap<string, RefinementModel>,
): ReadonlySet<string> {
    const needed = new Set<string>();
    const declarations = new Map<string, ts.VariableDeclaration>();
    for (const statement of sourceFile.statements) {
        if (ts.isVariableStatement(statement)) collectDeclarations(statement, declarations, needed, refinements);
        else if (ts.isLabeledStatement(statement) && statement.label.text === "assert") {
            collectIdentifiers(statement.statement, needed);
        }
    }
    const pending = [...needed];
    while (pending.length) {
        const declaration = declarations.get(pending.pop()!);
        if (!declaration?.initializer) continue;
        const dependencies = new Set<string>();
        collectIdentifiers(declaration.initializer, dependencies);
        for (const dependency of dependencies) {
            if (needed.has(dependency)) continue;
            needed.add(dependency);
            pending.push(dependency);
        }
    }
    return needed;
}

function collectDeclarations(
    statement: ts.VariableStatement,
    declarations: Map<string, ts.VariableDeclaration>,
    needed: Set<string>,
    refinements: ReadonlyMap<string, RefinementModel>,
): void {
    for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue;
        declarations.set(declaration.name.text, declaration);
        if (refinementFromType(declaration.type, refinements)) needed.add(declaration.name.text);
    }
}

function collectIdentifiers(node: ts.Node, names: Set<string>): void {
    if (ts.isIdentifier(node) && !ts.isPropertyAccessExpression(node.parent)) names.add(node.text);
    ts.forEachChild(node, child => collectIdentifiers(child, names));
}
