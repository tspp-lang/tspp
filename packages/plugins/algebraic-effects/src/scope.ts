import type { TSPPTypeScript } from "@tspp/plugin-sdk/compiler";
import type * as TS from "typescript-upstream";

import type { EffectSyntax, HandleSyntax } from "./syntax";

/** Where capabilities are in scope at run time: a parameter of a function with a clause, or the body of a `handle`. */
export type EffectContext =
    | { readonly kind: "clause"; readonly fn: TS.Node; }
    | { readonly kind: "handle"; readonly handle: HandleSyntax; };

/** One effect a context offers. */
export interface ContextEntry {
    readonly symbol: TS.Symbol;
    readonly type: TS.Type;
    /** The property of the capability object that holds it. */
    readonly name: string;
}

export interface EffectScope {
    /** The symbol of the effect `type` applies, if it applies one. */
    effectOf(type: TS.Type): TS.Symbol | undefined;
    isEffect(symbol: TS.Symbol | undefined): boolean;
    /** The node that stands for `context`, for telling contexts apart. */
    keyOf(context: EffectContext): TS.Node;
    /** What is lexically in scope at `at`, nearest first. */
    contextsAt(at: TS.Node): readonly EffectContext[];
    /** What `context` itself declares or handles. */
    entriesOf(context: EffectContext): readonly ContextEntry[];
    /** The nearest context offering `effect` at `at`. */
    find(effect: TS.Symbol, at: TS.Node): { readonly context: EffectContext; readonly entry: ContextEntry; } | undefined;
}

export function createEffectScope(ts: TSPPTypeScript, syntax: EffectSyntax, checker: TS.TypeChecker): EffectScope {
    const resolveAlias = (symbol: TS.Symbol) => symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;

    const isEffect = (symbol: TS.Symbol | undefined) => !!symbol?.declarations?.some(declaration => syntax.effects.has(declaration));

    const effectOf = (type: TS.Type) => {
        const symbol = type.symbol && resolveAlias(type.symbol);
        return isEffect(symbol) ? symbol : undefined;
    };

    /** A function an author writes to run later captures what surrounds it; a named declaration must say what it needs. */
    const isLexicalBoundary = (node: TS.Node) => ts.isFunctionLike(node) && !ts.isArrowFunction(node) && !ts.isFunctionExpression(node);

    const contextsAt = (at: TS.Node) => {
        const contexts: EffectContext[] = [];
        for (let current: TS.Node | undefined = at; current; current = current.parent) {
            const handle = syntax.handleBodies.get(current);
            if (handle) contexts.push({ kind: "handle", handle });
            else if (ts.isFunctionLike(current) && syntax.clauses.has(current)) contexts.push({ kind: "clause", fn: current });
            if (isLexicalBoundary(current)) break;
        }
        return contexts;
    };

    const entry = (node: TS.TypeNode): ContextEntry | undefined => {
        const type = checker.getTypeFromTypeNode(node);
        const symbol = effectOf(type);
        return symbol && { symbol, type, name: ts.symbolName(symbol) };
    };

    const entriesOf = (context: EffectContext): readonly ContextEntry[] => {
        const nodes = context.kind === "clause" ? syntax.clauses.get(context.fn)!.items : [context.handle.effect];
        return nodes.flatMap(node => entry(node) ?? []);
    };

    return {
        effectOf,
        isEffect,
        keyOf: context => context.kind === "clause" ? context.fn : context.handle.call,
        contextsAt,
        entriesOf,
        find(effect, at) {
            for (const context of contextsAt(at)) {
                const found = entriesOf(context).find(candidate => candidate.symbol === effect);
                if (found) return { context, entry: found };
            }
            return undefined;
        },
    };
}
