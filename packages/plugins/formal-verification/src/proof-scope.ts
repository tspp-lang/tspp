import type * as TS from "typescript-upstream";
import { nameText, ts } from "./host-api";
import { refinementFromType } from "./models";
import type { RefinementModel } from "./refinements";

export function collectTopLevelProofVariables(
    sourceFile: TS.SourceFile,
    refinements: ReadonlyMap<string, RefinementModel>,
): ReadonlySet<string> {
    const needed = new Set<string>();
    const declarations = new Map<string, TS.VariableDeclaration>();
    for (const statement of sourceFile.statements) {
        if (ts.isVariableStatement(statement)) collectDeclarations(statement, declarations, needed, refinements);
        else if (ts.isLabeledStatement(statement) && nameText(statement.label) === "assert") {
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
    statement: TS.VariableStatement,
    declarations: Map<string, TS.VariableDeclaration>,
    needed: Set<string>,
    refinements: ReadonlyMap<string, RefinementModel>,
): void {
    for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue;
        declarations.set(nameText(declaration.name), declaration);
        if (refinementFromType(declaration.type, refinements)) needed.add(nameText(declaration.name));
    }
}

function collectIdentifiers(node: TS.Node, names: Set<string>): void {
    if (ts.isIdentifier(node) && !ts.isPropertyAccessExpression(node.parent)) names.add(nameText(node));
    ts.forEachChild(node, child => collectIdentifiers(child, names));
}
