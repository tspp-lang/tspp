import type { TSPPSignatureConstraint, TSPPTypeOperations, TSPPTypeScript } from "@tspp/plugin-sdk/compiler";
import type * as TS from "typescript-upstream";

import type { createInherentLookup } from "./inherent";
import { createSearch } from "./search";
import type { TypeclassSyntax } from "./syntax";

/** Choosing an overload only compares types it is handed, so this search never builds a dictionary or a mapper. */
const unreachableTypes = {} as TSPPTypeOperations;

const relationCode = 19107;

/** What the checker asks: which overloads apply, which signatures stand for each other, and inherent members. */
export function createSignatureConstraint(
    ts: TSPPTypeScript,
    syntax: TypeclassSyntax,
    inherentLookup: ReturnType<typeof createInherentLookup>,
    typeclassItems: (declaration: TS.Node, checker: TS.TypeChecker) => readonly TS.TypeNode[],
    isTypeclassItemOf: (syntax: TypeclassSyntax, checker: TS.TypeChecker, item: TS.TypeNode) => boolean,
    noRetain: () => void,
): TSPPSignatureConstraint {
    return {
        isOverloadApplicable({ node, declaration, checker, instantiate }) {
            const clause = syntax.wheres.get(declaration);
            if (!clause) return true;
            const search = createSearch(ts, syntax, checker, unreachableTypes, noRetain);
            return clause.items.every(item => isTypeclassItemOf(syntax, checker, item) || search.predicateHolds(instantiate(checker.getTypeFromTypeNode(item)), node));
        },
        whyNotRelated({ source, target, checker, instantiateSource, instantiateTarget }) {
            const sourceClause = source && syntax.wheres.get(source);
            const targetClause = target && syntax.wheres.get(target);
            if (!sourceClause && !targetClause) return undefined;
            // The overloads and implementation of one function are checked against each other by the provider.
            const symbolOf = (declaration: TS.Node | undefined) => (declaration as { symbol?: TS.Symbol; } | undefined)?.symbol;
            if (symbolOf(source) && symbolOf(source) === symbolOf(target)) return undefined;
            // Dictionaries come first, so a function that does not expect them would read one as its first argument.
            const dictionaries = (declaration: TS.Node | undefined, instantiate: (type: TS.Type) => TS.Type) => declaration ? typeclassItems(declaration, checker).map(item => instantiate(checker.getTypeFromTypeNode(item))) : [];
            const sourceTypes = dictionaries(source, instantiateSource);
            const targetTypes = dictionaries(target, instantiateTarget);
            const search = createSearch(ts, syntax, checker, unreachableTypes, noRetain);
            const sameDictionary = (a: TS.Type, b: TS.Type) => {
                if (a.symbol !== b.symbol) return false;
                const others = search.typeArgumentsOf(b);
                // A signature compared with its type parameters erased says nothing about them.
                return search.typeArgumentsOf(a).every((argument, index) => !!(argument.flags & ts.TypeFlags.Any) || !!(others[index].flags & ts.TypeFlags.Any) || argument === others[index] || checker.isTypeAssignableTo(argument, others[index]) && checker.isTypeAssignableTo(others[index], argument));
            };
            if (sourceTypes.length !== targetTypes.length || sourceTypes.some((type, index) => !sameDictionary(type, targetTypes[index]))) {
                return { code: relationCode, message: "These functions take different dictionaries, so one cannot stand for the other: their 'where' clauses must list the same typeclasses in the same order." };
            }
            for (const item of sourceClause?.items ?? []) {
                if (isTypeclassItemOf(syntax, checker, item)) continue;
                const type = instantiateSource(checker.getTypeFromTypeNode(item));
                const known = (type.flags & ts.TypeFlags.BooleanLiteral && checker.typeToString(type) === "true")
                    || targetClause?.items.some(other => instantiateTarget(checker.getTypeFromTypeNode(other)) === type);
                if (!known) return { code: relationCode, message: `The constraint '${sourceClause!.itemTexts.get(item)}' is not known to hold where this function is expected.` };
            }
            return undefined;
        },
        getMember: inherentLookup.getMember((checker, types) => createSearch(ts, syntax, checker, types, noRetain).unify),
        getMembers: inherentLookup.getMembers((checker, types) => createSearch(ts, syntax, checker, types, noRetain).unify),
    };
}
