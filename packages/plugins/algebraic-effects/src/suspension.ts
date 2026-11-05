import type { TSPPTypeScript } from "@tspp/plugin-sdk/compiler";
import type * as TS from "typescript-upstream";

import type { EffectScope } from "./scope";
import type { EffectSyntax, HandleSyntax } from "./syntax";

export const suspensionCodes = {
    suspend: 19210,
    control: 19211,
    continuation: 19212,
    colored: 19213,
};

type Report = (node: TS.Node, code: number, message: string, category?: TS.DiagnosticCategory) => void;

/**
 * Where code may suspend, and what `control` clauses must look like. A function whose clause lists an effect with `suspend`
 * operations is a generator, and so is the body of a `handle` with `control` clauses; a `handle` without them is one when
 * something in it suspends. Everything between a suspension and the generator it suspends must be one of those bodies.
 */
export function createSuspensionChecks(ts: TSPPTypeScript, syntax: EffectSyntax, scope: EffectScope, checker: TS.TypeChecker, report: Report, generatorHandles: Set<TS.Node>) {
    /** Checks that `node` suspends directly in a generator, and records the `handle` bodies on the way as generators too. */
    const suspendsAt = (node: TS.Node, what: string) => {
        const passed: HandleSyntax[] = [];
        let inParameter = false;
        let ok = false;
        for (let current = node.parent; current; current = current.parent) {
            if (ts.isParameter(current)) inParameter = true;
            const handle = syntax.handleBodies.get(current);
            if (handle) {
                if (handle.control) {
                    ok = true;
                    break;
                }
                passed.push(handle);
                continue;
            }
            if (ts.isFunctionLike(current)) {
                ok = !inParameter && scope.isColored(current) && !!(current as TS.FunctionLikeDeclaration).body;
                break;
            }
        }
        if (ok) passed.forEach(handle => generatorHandles.add(handle.call));
        else {
            report(node, suspensionCodes.suspend, inParameter
                ? `${what} suspends, which a parameter's default value cannot.`
                : `${what} suspends, so it must stand in a function whose clause lists a suspending effect, or in the body of a 'handle' with 'control' clauses. A callback without a clause cannot suspend: give it the clause, or use a loop.`);
        }
    };

    const checkColoredFunction = (fn: TS.SignatureDeclaration) => {
        if (!scope.isColored(fn)) return;
        const modifiers = ts.canHaveModifiers(fn) ? ts.getModifiers(fn) ?? [] : [];
        if (modifiers.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword)) report(fn.name ?? fn, suspensionCodes.colored, "An async function cannot require a suspending effect: its handler decides when it continues.");
        if ((fn as TS.FunctionLikeDeclaration).asteriskToken) report(fn.name ?? fn, suspensionCodes.colored, "A generator cannot require a suspending effect: it would yield its own values among the effect's requests.");
    };

    /** A clause that is called once per suspension, and must resume or abort `k` once. */
    const checkContinuation = (method: TS.MethodDeclaration) => {
        const k = method.parameters[method.parameters.length - 1];
        if (!k || !ts.isIdentifier(k.name) || !method.body) {
            report(method.name, suspensionCodes.control, "A 'control' clause takes the continuation as its last parameter.");
            return;
        }
        const symbol = checker.getSymbolAtLocation(k.name);
        let uses = 0;
        const count = (node: TS.Node): void => {
            if (ts.isIdentifier(node) && node !== k.name && checker.getSymbolAtLocation(node) === symbol) uses++;
            ts.forEachChild(node, count);
        };
        count(method.body);
        if (!uses) report(method.name, suspensionCodes.continuation, `This clause never resumes or aborts '${ts.idText(k.name)}', so the 'handle' never settles.`, ts.DiagnosticCategory.Warning);
        // On the straight path of the clause, a second resumption is certain; anywhere else the run time catches it.
        const consumes = method.body.statements.filter(statement => {
            if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) return false;
            const callee = statement.expression.expression;
            return ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && checker.getSymbolAtLocation(callee.expression) === symbol
                && (ts.idText(callee.name as TS.Identifier) === "resume" || ts.idText(callee.name as TS.Identifier) === "abort");
        });
        if (consumes.length > 1) report(consumes[1], suspensionCodes.continuation, `'${ts.idText(k.name)}' has already been resumed or aborted here: a continuation runs once.`);
    };

    /** A suspending operation is handled by a `control` clause, and only such operations are. */
    const checkHandlers = (handle: HandleSyntax, effect: TS.Symbol) => {
        const suspending = scope.suspendingOperations(effect);
        for (const property of handle.handlers.properties) {
            const name = property.name && ts.isIdentifier(property.name) ? ts.idText(property.name) : undefined;
            if (!name) continue;
            const control = handle.controls.has(property);
            if (suspending.has(name) && !control) report(property.name!, suspensionCodes.control, `'${name}' suspends, so its handler is a 'control' clause, which takes the continuation: 'control ${name}(arguments, k) { ... }'.`);
            else if (!suspending.has(name) && control) report(property.name!, suspensionCodes.control, `'${name}' does not suspend, so it is handled by an ordinary clause, whose return value it resumes with.`);
            if (control && ts.isMethodDeclaration(property)) checkContinuation(property);
        }
    };

    return { suspendsAt, checkColoredFunction, checkHandlers };
}
