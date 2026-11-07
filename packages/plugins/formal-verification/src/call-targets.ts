import type * as TS from "typescript-upstream";
import type { TSPPAnalysisLocation } from "@tspp/plugin-sdk/compiler";
import { resolveCallTargetBySyntax, type ClassModel, type MethodTarget } from "./classes";
import { nameText, nodeStart, ts } from "./host-api";
import type { FunctionModel } from "./models";
import { declarationKey, rangeKey, type DeclaredTarget } from "./program-index";

/** What a call is resolved against: the checker's answer when the host gave one, and this file's models. */
export interface CallResolver {
    readonly sourceFile: TS.SourceFile;
    readonly classes: ReadonlyMap<string, ClassModel>;
    readonly functions: ReadonlyMap<string, FunctionModel>;
    readonly callTargets: ReadonlyMap<string, readonly TSPPAnalysisLocation[]> | undefined;
    readonly declarations: ReadonlyMap<string, DeclaredTarget>;
}

/**
 * The one modeled declaration every declaration the checker found for a call stands for. Several, or any that is not
 * modeled (an interface's method, an unmodeled class, a variable), mean the code that runs is not known.
 */
function checkedTarget(call: TS.CallExpression | TS.NewExpression, resolver: CallResolver): DeclaredTarget | undefined {
    const located = resolver.callTargets!.get(rangeKey(nodeStart(call, resolver.sourceFile), call.end));
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
    const target = checkedTarget(call, resolver);
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
    if (usesChecker(call, resolver)) {
        const target = checkedTarget(call, resolver);
        if (target?.kind === "function") return target.model;
    }
    return resolver.functions.get(nameText(call.expression));
}
