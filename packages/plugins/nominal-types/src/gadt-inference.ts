import type { TSPPTypeExtension, TSPPTypeHost, TSPPTypeScript } from "@tspp/plugin-sdk/compiler";
import type * as TS from "typescript-upstream";

import type { NominalDeclarations } from "./declarations";
import { findGadt } from "./gadt-types";

/** Checks a constructor against its expected result before checking its operands. Partial problems stay with TS. */
export function createGadtInference(ts: TSPPTypeScript, declarations: NominalDeclarations): TSPPTypeExtension {
    function specialize(node: TS.CallExpression, host: TSPPTypeHost): TS.Type | undefined {
        if (node.typeArguments?.length) return undefined;
        const callee = host.checker.getTypeAtLocation(node.expression);
        const signatures = host.checker.getSignaturesOfType(callee, ts.SignatureKind.Call);
        if (signatures.length !== 1) return undefined;
        const signature = signatures[0];
        const constructor = signature.declaration && declarations.gadtConstructors.get(signature.declaration);
        if (!constructor) return undefined;
        const parameters = signature.typeParameters;
        if (!parameters?.length) return undefined;
        const expected = host.getContextualType(node);
        if (!expected) return undefined;
        const result = host.checker.getReturnTypeOfSignature(signature);
        const from = findGadt(result, declarations, host.checker, ts);
        const to = findGadt(expected, declarations, host.checker, ts);
        if (!from || from.declaration !== to?.declaration) return undefined;
        // A caller's provisional inference parameters are not evidence. Only explicit lexical parameters or closed
        // indices may fix a constructor before normal call inference has finished.
        const contextTypes = new Set<TS.Type>();
        const contextSymbols = new Set<TS.Symbol>();
        function known(type: TS.Type): boolean {
            if (type.flags & ts.TypeFlags.TypeParameter) {
                return !!type.symbol?.declarations?.some(declaration => {
                    for (let parent: TS.Node | undefined = node.parent; parent; parent = parent.parent) {
                        if (declaration.parent === parent) return true;
                    }
                    return false;
                });
            }
            if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Conditional | ts.TypeFlags.IndexedAccess)) return false;
            if (contextTypes.has(type)) return true;
            contextTypes.add(type);
            if (type.aliasTypeArguments?.some(argument => !known(argument))) return false;
            if (type.aliasSymbol && contextSymbols.has(type.aliasSymbol)) return true;
            if (type.aliasSymbol) contextSymbols.add(type.aliasSymbol);
            if (type.flags & ts.TypeFlags.UnionOrIntersection) return (type as TS.UnionOrIntersectionType).types.every(known);
            if (!(type.flags & ts.TypeFlags.Object)) return true;
            if ((type as TS.ObjectType).objectFlags & ts.ObjectFlags.Reference) return host.checker.getTypeArguments(type as TS.TypeReference).every(known);
            return host.checker.getPropertiesOfType(type).every(property => known(host.checker.getTypeOfSymbol(property)));
        }
        if (!to.indices.every(known)) return undefined;
        const solutions = new Map<TS.TypeParameter, TS.Type>();
        const variables = new Set(parameters);
        const instantiate = (type: TS.Type) => host.instantiate(type, host.createMapper([...solutions.keys()], [...solutions.values()]));
        const visited = new Map<TS.Type, Set<TS.Type>>();

        function solve(pattern: TS.Type, actual: TS.Type): boolean {
            if (variables.has(pattern as TS.TypeParameter)) {
                const variable = pattern as TS.TypeParameter;
                const previous = solutions.get(variable);
                if (previous) return previous === actual;
                if (pattern === actual || actual.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)) return false;
                solutions.set(variable, actual);
                return true;
            }
            if (pattern === actual) return true;
            let seen = visited.get(pattern);
            if (seen?.has(actual)) return true;
            if (!seen) visited.set(pattern, seen = new Set());
            seen.add(actual);
            const a = findGadt(pattern, declarations, host.checker, ts);
            const b = findGadt(actual, declarations, host.checker, ts);
            if (a && a.declaration === b?.declaration) return a.indices.every((index, i) => solve(index, b.indices[i]));
            if (host.checker.isTupleType(pattern) && host.checker.isTupleType(actual)) {
                const p = pattern as TS.TupleTypeReference;
                const args = host.checker.getTypeArguments(p);
                const values = host.checker.getTypeArguments(actual as TS.TypeReference);
                const flags = p.target.elementFlags;
                const variadic = flags.indexOf(ts.ElementFlags.Variadic);
                if (variadic >= 0 && variadic === args.length - 1 && values.length >= variadic) {
                    const tail = host.sliceTupleType(actual, variadic);
                    return !!tail && args.slice(0, variadic).every((arg, i) => solve(arg, values[i])) && solve(args[variadic], tail);
                }
                return flags.length === values.length && args.every((arg, i) => solve(arg, values[i]));
            }
            // Structural aliases may discard parameters; inspect their visible fields, never aliasTypeArguments.
            if (pattern.flags & ts.TypeFlags.Object && actual.flags & ts.TypeFlags.Object) {
                const fields = host.checker.getPropertiesOfType(pattern);
                if (!fields.length) return true;
                return fields.every(field => {
                    const other = host.checker.getPropertyOfType(actual, ts.symbolName(field));
                    return !!other && solve(host.checker.getTypeOfSymbol(field), host.checker.getTypeOfSymbol(other));
                });
            }
            return false;
        }

        if (!from.indices.every((index, i) => solve(index, to.indices[i])) || parameters.some(parameter => !solutions.has(parameter))) return undefined;
        if (node.arguments.length !== signature.parameters.length || node.arguments.some(ts.isSpreadElement)) return undefined;
        const targets = parameters.map(parameter => solutions.get(parameter)!);
        const mapper = host.createMapper(parameters, targets);
        parameters.forEach((parameter, i) => {
            // Base constraints erase relations such as B extends A; check the authored bound after substitution.
            const annotation = constructor.typeParameters[i]?.constraint;
            const constraint = annotation ? host.checker.getTypeFromTypeNode(annotation) : host.checker.getBaseConstraintOfType(parameter);
            if (constraint) host.checkTypeArgumentConstraint(targets[i], host.instantiate(constraint, mapper), node);
        });
        // The callee remains a checked value reference, including imports needed by JavaScript emit.
        host.checkExpression(node.expression);
        node.arguments.forEach((argument, index) => {
            const parameter = host.checker.getTypeOfSymbol(signature.parameters[index]);
            host.checkExpression(argument, host.instantiate(parameter, mapper));
        });
        return instantiate(result);
    }

    return {
        resolveTypeNode: () => undefined,
        instantiateType: type => type,
        resolveExpressionType: (node, host) => ts.isCallExpression(node) ? specialize(node, host) : undefined,
    };
}
