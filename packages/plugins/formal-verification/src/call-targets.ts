import type * as TS from "typescript-upstream";
import type { TSPPAnalysisLocation } from "@tspp/plugin-sdk/compiler";
import { resolveCallTargetBySyntax, type ClassModel, type MethodTarget } from "./classes";
import { nameText, nodeStart, ts } from "./host-api";
import type { FunctionModel } from "./models";
import { declarationKey, rangeKey, type DeclarationKey, type DeclaredTarget, type SourceRangeKey } from "./program-index";

/** What a call is resolved against: the checker's answer when the host gave one, and this file's models. */
export interface CallResolver {
    readonly sourceFile: TS.SourceFile;
    readonly classes: ReadonlyMap<string, ClassModel>;
    readonly functions: ReadonlyMap<string, FunctionModel>;
    readonly callTargets: ReadonlyMap<SourceRangeKey, readonly TSPPAnalysisLocation[]> | undefined;
    readonly declarations: ReadonlyMap<DeclarationKey, DeclaredTarget>;
}

/**
 * The one modeled declaration every declaration the checker found for a call stands for. Several, or any that is not
 * modeled (an interface's method, an unmodeled class, a variable), mean the code that runs is not known.
 */
const checkerLocations = (call: TS.CallExpression | TS.NewExpression, resolver: CallResolver) =>
    resolver.callTargets?.get(rangeKey(nodeStart(call, resolver.sourceFile), call.end));

function checkedTarget(located: readonly TSPPAnalysisLocation[] | undefined, resolver: CallResolver): DeclaredTarget | undefined {
    const found = located?.map(location => resolver.declarations.get(declarationKey(location.fileName, location.start)));
    if (!found?.length || found.some(target => !target)) return undefined;
    const [first] = found as DeclaredTarget[];
    const same = (target: DeclaredTarget | undefined) => target?.kind === "member"
        ? first.kind === "member" && target.member === first.member
        : first.kind === "function" && target?.model === first.model;
    return found.every(same) ? first : undefined;
}

const usesChecker = (call: TS.Node, resolver: CallResolver) => !!resolver.callTargets && call.pos >= 0;

/** The modeled method or constructor a call runs, or undefined when that is unknown or unmodeled. */
export function resolveCallTarget(call: TS.CallExpression | TS.NewExpression, resolver: CallResolver): MethodTarget | undefined {
    if (!usesChecker(call, resolver)) return resolveCallTargetBySyntax(call, resolver.classes);
    const target = checkedTarget(checkerLocations(call, resolver), resolver);
    if (target?.kind !== "member") return undefined;
    let callee: TS.Expression = call.expression;
    while (ts.isParenthesizedExpression(callee) || ts.isNonNullExpression(callee)) callee = callee.expression;
    const receiver = ts.isPropertyAccessExpression(callee) ? callee.expression.kind : callee.kind;
    const kind: MethodTarget["receiver"] = ts.isNewExpression(call) || target.member.isStatic ? "static"
        : receiver === ts.SyntaxKind.SuperKeyword ? "super"
        : receiver === ts.SyntaxKind.ThisKeyword ? "this"
        : "instance";
    return { owner: target.owner, member: target.member, receiver: kind };
}

/**
 * The function a direct call runs: the checker's resolution, which reaches other files, or else this file's
 * function of that name. Logic functions are not functions here.
 */
export function resolveFunction(call: TS.CallExpression, resolver: CallResolver): FunctionModel | undefined {
    if (!ts.isIdentifier(call.expression)) return undefined;
    const located = usesChecker(call, resolver) ? checkerLocations(call, resolver) : undefined;
    if (located) {
        const target = checkedTarget(located, resolver);
        return target?.kind === "function" ? target.model : undefined;
    }
    const name = nameText(call.expression);
    // The standalone analyzer has no checker. A local declaration can shadow a modeled top-level function.
    for (let scope = call.parent; scope && !ts.isSourceFile(scope); scope = scope.parent) {
        if (ts.isBlock(scope) && scope.statements.some(statement =>
            ts.isFunctionDeclaration(statement) && statement.name && nameText(statement.name) === name)) return undefined;
    }
    return resolver.functions.get(name);
}
