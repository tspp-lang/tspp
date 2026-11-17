import type * as TS from "typescript-upstream";
import { nameText, ts } from "./host-api";
import { guardsCalls, participatesInVerification, refinementFromType } from "./models";
import { resolveCallTarget, resolveFunction } from "./call-targets";
import { addProof, diagnostic, initialState, type Context } from "./execution-state";
import { loopInvariants } from "./loops";
import type { Lowering } from "./lowered-code";

/** Whether a function without its own contract still contains an obligation that must be checked. */
export function owesProof(statement: TS.FunctionLikeDeclaration, context: Context): boolean {
    const visit = (node: TS.Node): boolean => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
            const model = resolveFunction(node, context);
            if (model && guardsCalls(model)) return true;
        }
        if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
            const target = resolveCallTarget(node, context);
            if (target && guardsCalls(target.member.model)) return true;
        }
        if (ts.isVariableDeclaration(node) && refinementFromType(node.type, context.refinements)) return true;
        if (ts.isWhileStatement(node) && loopInvariants(node, context).length) return true;
        return !!ts.forEachChild(node, child => visit(child) || undefined);
    };
    return !!statement.body && visit(statement.body);
}

/** Verify source function bodies and retain declarations whose diagnostics already explain missing coverage. */
export function verifyFunctionDeclarations(base: Context, executeStatements: Lowering["executeStatements"]): Set<TS.Node> {
    const { sourceFile, functions, logic } = base;
    const rejected = new Set<TS.Node>();
    for (const statement of sourceFile.statements) {
        if (ts.isFunctionDeclaration(statement) && statement.name && !statement.body) {
            const name = nameText(statement.name);
            const model = functions.get(name);
            const implementation = sourceFile.statements.some(other => ts.isFunctionDeclaration(other)
                && other.name && nameText(other.name) === name && !!other.body);
            if (model && !implementation && participatesInVerification(statement, model)) {
                diagnostic(base, statement, `Function '${name}' has no body to verify its contract.`);
                rejected.add(statement);
            }
        }
        // Generated declarations, such as data constructors, have no original body to report on.
        if (!ts.isFunctionDeclaration(statement) || !statement.name || !statement.body || statement.body.pos < 0) continue;
        const model = functions.get(nameText(statement.name));
        if (!model) continue;
        const context: Context = { ...base, currentFunction: model };
        const usesNumber = statement.parameters.some(parameter => parameter.type?.kind === ts.SyntaxKind.NumberKeyword)
            || statement.type?.kind === ts.SyntaxKind.NumberKeyword;
        if (usesNumber && !model.numberModel && !participatesInVerification(statement, model)) continue;
        if (usesNumber && !model.numberModel) {
            diagnostic(context, statement.name, new Error("A number proof requires numberModel: 'mathematical-real' or 'safe-integer'."));
            rejected.add(statement);
            continue;
        }
        if (!participatesInVerification(statement, model) && !owesProof(statement, context)) continue;
        if (model.verificationSafetyError) {
            diagnostic(context, statement.name, `Function '${model.name}' cannot be verified because ${model.verificationSafetyError}; record aliases need a post-state model.`);
            rejected.add(statement);
            continue;
        }
        const fallthrough = executeStatements(statement.body.statements, [initialState(model, logic)], context);
        if (model.ensures.length || model.returnRefinement) for (const state of fallthrough) {
            addProof(context, state, "false", statement.body, `${model.name} normal return definedness`);
        }
        base.nextTemporary = context.nextTemporary;
    }
    return rejected;
}
