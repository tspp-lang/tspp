import type { TSPPTypeScript } from "@tspp/plugin-sdk/compiler";
import type * as TS from "typescript-upstream";

/** The macro and target expressions of a projected invocation `void [macro, ...targets];`. */
export function getProjectedElements(ts: TSPPTypeScript, statement: TS.ExpressionStatement): TS.NodeArray<TS.Expression> | undefined {
    const expression = statement.expression;
    if (!ts.isVoidExpression(expression) || !ts.isArrayLiteralExpression(expression.expression)) return undefined;
    return expression.expression.elements;
}

export function firstIdentifier(ts: TSPPTypeScript, expression: TS.Expression | undefined): TS.Identifier | undefined {
    let current = expression;
    while (current && ts.isPropertyAccessExpression(current)) current = current.expression;
    return current && ts.isIdentifier(current) ? current : undefined;
}

export function sourceFileOf(ts: TSPPTypeScript, node: TS.Node): TS.SourceFile {
    let current: TS.Node = node;
    while (!ts.isSourceFile(current)) current = current.parent;
    return current;
}

export function tokenStartOf(ts: TSPPTypeScript, sourceFile: TS.SourceFile, node: TS.Node): number {
    const scanner = ts.createScanner(ts.ScriptTarget.Latest, /*skipTrivia*/ true, ts.LanguageVariant.Standard, sourceFile.text, /*onError*/ undefined, node.pos);
    scanner.scan();
    return scanner.getTokenStart();
}

/** The statement whose range, after leading trivia, is exactly `start` to `end`. */
export function findStatement(ts: TSPPTypeScript, sourceFile: TS.SourceFile, start: number, end: number): TS.Statement | undefined {
    const visit = (node: TS.Node): TS.Statement | undefined => {
        if (node.pos > start || node.end < end) return undefined;
        if (ts.isStatement(node) && node.end === end && tokenStartOf(ts, sourceFile, node) === start) return node;
        return ts.forEachChild(node, visit);
    };
    return ts.forEachChild(sourceFile, visit);
}

export function forEachDescendant(ts: TSPPTypeScript, node: TS.Node, callback: (node: TS.Node) => void) {
    ts.forEachChild(node, child => {
        callback(child);
        forEachDescendant(ts, child, callback);
    });
}
