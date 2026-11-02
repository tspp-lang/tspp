import type { TSPPDiagnosticMessage, TSPPDiagnosticProvider, TSPPTypeOperations, TSPPTypeScript } from "@tspp/plugin-sdk/compiler";
import type * as TS from "typescript-upstream";

const staticSideMessage: TSPPDiagnosticMessage = {
    code: 18074,
    message: "Class static side '{0}' incorrectly implements static side of interface '{1}'.",
};

// TypeScript's own message, which the checker uses for the same member-specific elaboration of `implements`.
const propertyMessage: TSPPDiagnosticMessage = {
    code: 2416,
    message: "Property '{0}' in type '{1}' is not assignable to the same property in base type '{2}'.",
};

/** Whether `node` is a static member of an interface, which this plugin makes legal. */
export function isStaticInterfaceMember(ts: TSPPTypeScript, node: TS.Node): boolean {
    return (ts.isPropertySignature(node) || ts.isMethodSignature(node))
        && !!node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.StaticKeyword);
}

/**
 * Checks that a class implementing an interface also has the interface's static members on its static side, where
 * `this` in a static member stands for the class's instance type. Reported once the instance side is assignable,
 * with the same message, elaboration, and position the checker gives the instance side.
 */
export function createStaticSideCheck(ts: TSPPTypeScript): TSPPDiagnosticProvider {
    function getStaticInterfaceType(checker: TS.TypeChecker, types: TSPPTypeOperations, interfaceType: TS.Type, implementingInstanceType: TS.Type): TS.Type | undefined {
        if (
            !(interfaceType.flags & ts.TypeFlags.Object)
            || !((interfaceType as TS.ObjectType).objectFlags & (ts.ObjectFlags.ClassOrInterface | ts.ObjectFlags.Reference))
            || !(interfaceType.symbol.flags & ts.SymbolFlags.Interface)
        ) {
            return undefined;
        }

        const staticTypes: TS.Type[] = [];
        const staticMembers: TS.Symbol[] = [];
        interfaceType.symbol.exports?.forEach(member => {
            if (member.declarations?.some(declaration => ts.isInterfaceDeclaration(declaration.parent) && isStaticInterfaceMember(ts, declaration))) {
                staticMembers.push(member);
            }
        });
        if (staticMembers.length) {
            const interfaceThisType = (checker.getDeclaredTypeOfSymbol(interfaceType.symbol) as TS.InterfaceType).thisType;
            staticTypes.push(types.createObjectType(staticMembers, interfaceThisType && types.createMapper([interfaceThisType], [implementingInstanceType])));
        }

        for (const baseType of checker.getBaseTypes(interfaceType as TS.InterfaceType)) {
            const staticBaseType = getStaticInterfaceType(checker, types, baseType, implementingInstanceType);
            if (staticBaseType) staticTypes.push(staticBaseType);
        }

        return staticTypes.length === 0 ? undefined
            : staticTypes.length === 1 ? staticTypes[0]
            : types.getIntersectionType(staticTypes);
    }

    function implementedTypeNodes(node: TS.ClassLikeDeclaration): readonly TS.ExpressionWithTypeArguments[] {
        if (node.flags & ts.NodeFlags.JavaScriptFile) return ts.getJSDocImplementsTags(node).map(tag => tag.class);
        return node.heritageClauses?.find(clause => clause.token === ts.SyntaxKind.ImplementsKeyword)?.types ?? [];
    }

    function checkClass(node: TS.ClassLikeDeclaration, checker: TS.TypeChecker, types: TSPPTypeOperations, diagnostics: TS.Diagnostic[]): void {
        const typeNodes = implementedTypeNodes(node);
        if (!typeNodes.length) return;
        const classType = checker.getTypeAtLocation(node);
        const symbol = classType.symbol;
        if (!symbol) return;
        const type = checker.getDeclaredTypeOfSymbol(symbol) as TS.InterfaceType;
        const typeWithThis = types.getTypeWithThisArgument(type);
        const staticType = checker.getTypeOfSymbol(symbol);
        for (const typeRefNode of typeNodes) {
            const implemented = checker.getTypeFromTypeNode(typeRefNode);
            if (implemented.flags & ts.TypeFlags.Any || !(implemented.flags & ts.TypeFlags.Object)) continue;
            // The checker reports the instance side first; the static side only matters once that holds.
            if (!checker.isTypeAssignableTo(typeWithThis, types.getTypeWithThisArgument(implemented, type.thisType))) continue;
            const staticInterfaceType = getStaticInterfaceType(checker, types, implemented, type);
            if (staticInterfaceType && !checker.isTypeAssignableTo(staticType, staticInterfaceType)) {
                reportMemberSpecificErrors(node, staticType, staticInterfaceType, checker, types, diagnostics);
            }
        }
    }

    /** As the checker's `implements` check: an error on each incompatible member if possible, else on the class. */
    function reportMemberSpecificErrors(
        node: TS.ClassLikeDeclaration,
        typeWithThis: TS.Type,
        baseWithThis: TS.Type,
        checker: TS.TypeChecker,
        types: TSPPTypeOperations,
        diagnostics: TS.Diagnostic[],
    ): void {
        let issuedMemberError = false;
        for (const member of node.members) {
            if (ts.getCombinedModifierFlags(member) & ts.ModifierFlags.Static || ts.isClassStaticBlockDeclaration(member)) continue;
            const declaredProp = member.name && checker.getSymbolAtLocation(member.name) || checker.getSymbolAtLocation(member);
            if (!declaredProp) continue;
            const name = ts.unescapeLeadingUnderscores(declaredProp.escapedName);
            const prop = checker.getPropertyOfType(typeWithThis, name);
            const baseProp = checker.getPropertyOfType(baseWithThis, name);
            if (!prop || !baseProp) continue;
            const error = types.getAssignabilityError(
                checker.getTypeOfSymbol(prop),
                checker.getTypeOfSymbol(baseProp),
                member.name ?? member,
                /*headMessage*/ undefined,
                propertyMessage,
                [checker.symbolToString(declaredProp), checker.typeToString(typeWithThis), checker.typeToString(baseWithThis)],
            );
            if (error) {
                diagnostics.push(error);
                issuedMemberError = true;
            }
        }
        if (!issuedMemberError) {
            const error = types.getAssignabilityError(typeWithThis, baseWithThis, node.name ?? node, staticSideMessage);
            if (error) diagnostics.push(error);
        }
    }

    return {
        id: "static-side",
        getSemanticDiagnostics(sourceFile, checker, types) {
            const diagnostics: TS.Diagnostic[] = [];
            const visit = (node: TS.Node): void => {
                if (ts.isClassLike(node)) checkClass(node, checker, types, diagnostics);
                ts.forEachChild(node, visit);
            };
            visit(sourceFile);
            return diagnostics;
        },
    };
}
