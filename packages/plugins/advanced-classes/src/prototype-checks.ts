import type { TSPPTypeScript } from "@tspp/plugin-sdk/compiler";
import type * as TS from "typescript-upstream";

import { findAdditionalBases } from "./multiple-inheritance-checks";
import type { MultipleInheritance } from "./multiple-inheritance";

/** Checks only identities the checker can still associate with a class in this program. */
export function createPrototypeCheck(ts: TSPPTypeScript, multiple: MultipleInheritance, program: TS.Program | undefined, checker: TS.TypeChecker) {
    const affected = new Set<TS.Symbol>();
    if (program) {
        const targets = findAdditionalBases(ts, multiple, program).targets;
        const visit = (node: TS.Node): void => {
            if (ts.isClassDeclaration(node) && (multiple.getMultipleBases(node) || targets.has(ts.getOriginalNode(node)))) {
                const symbol = node.name && checker.getSymbolAtLocation(node.name);
                if (symbol) affected.add(symbol);
            }
            ts.forEachChild(node, visit);
        };
        for (const file of program.getSourceFiles()) if (!file.isDeclarationFile) visit(file);
    }

    const hasIdentity = (type: TS.Type, seen = new Set<TS.Type>()): boolean => {
        if (seen.has(type) || type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return false;
        seen.add(type);
        if (type.flags & (ts.TypeFlags.Union | ts.TypeFlags.Intersection)) return (type as TS.UnionOrIntersectionType).types.some(part => hasIdentity(part, seen));
        if (type.flags & ts.TypeFlags.TypeParameter) {
            const constraint = checker.getBaseConstraintOfType(type);
            return !!constraint && hasIdentity(constraint, seen);
        }
        if (type.symbol && affected.has(type.symbol)) return true;
        if (type.flags & ts.TypeFlags.Object) {
            const object = type as TS.ObjectType;
            if (object.objectFlags & (ts.ObjectFlags.Class | ts.ObjectFlags.Interface | ts.ObjectFlags.Reference)) {
                const bases = checker.getBaseTypes(type as TS.InterfaceType) ?? [];
                if (bases.some(base => hasIdentity(base, seen))) return true;
            }
        }
        return checker.getSignaturesOfType(type, ts.SignatureKind.Construct).some(signature => hasIdentity(checker.getReturnTypeOfSignature(signature), seen));
    };
    const known = (node: TS.Expression | undefined) => !!node && hasIdentity(checker.getTypeAtLocation(node));
    const keyOf = (node: TS.Node | undefined): string | undefined => {
        if (!node) return undefined;
        if (ts.isIdentifier(node)) return ts.idText(node);
        if (ts.isStringLiteralLike(node)) return node.text;
        if (ts.isComputedPropertyName(node)) return literalKey(node.expression);
        return undefined;
    };
    const literalKey = (node: TS.Expression | undefined): string | undefined => {
        if (!node) return undefined;
        if (ts.isStringLiteralLike(node)) return node.text;
        const type = checker.getTypeAtLocation(node);
        return type.flags & ts.TypeFlags.StringLiteral ? (type as TS.StringLiteralType).value : undefined;
    };
    const accessName = (node: TS.Node): { receiver: TS.Expression; name: string; location: TS.Node } | undefined => {
        if (ts.isPropertyAccessExpression(node)) return { receiver: node.expression, name: ts.idText(node.name), location: node.name };
        if (ts.isElementAccessExpression(node) && node.argumentExpression && literalKey(node.argumentExpression) !== undefined) return { receiver: node.expression, name: literalKey(node.argumentExpression)!, location: node.argumentExpression };
        return undefined;
    };
    const isLibDeclaration = (declaration: TS.Declaration) => {
        let root: TS.Node = declaration;
        while (root.parent) root = root.parent;
        return !!program?.isSourceFileDefaultLibrary(root as TS.SourceFile);
    };
    const builtin = (expression: TS.Expression, seen = new Set<TS.Symbol>()): string | undefined => {
        while (ts.isParenthesizedExpression(expression) || ts.isNonNullExpression(expression) || ts.isSatisfiesExpression(expression)) expression = expression.expression;
        const type = checker.getTypeAtLocation(expression);
        if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown) || !checker.getSignaturesOfType(type, ts.SignatureKind.Call).length) return undefined;
        const part = accessName(expression);
        let symbol = part ? checker.getPropertyOfType(checker.getTypeAtLocation(part.receiver), part.name) : checker.getSymbolAtLocation(expression);
        if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
        if (!symbol || seen.has(symbol)) return undefined;
        seen.add(symbol);
        const declaration = symbol.valueDeclaration;
        if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer
            && declaration.parent.flags & ts.NodeFlags.Const) return builtin(declaration.initializer, seen);
        if (declaration && ts.isBindingElement(declaration) && ts.isObjectBindingPattern(declaration.parent)) {
            const variable = declaration.parent.parent;
            const key = keyOf(declaration.propertyName ?? declaration.name);
            if (ts.isVariableDeclaration(variable) && variable.initializer && variable.parent.flags & ts.NodeFlags.Const && key) {
                const property = checker.getPropertyOfType(checker.getTypeAtLocation(variable.initializer), key);
                if (property) return builtinSymbol(property, checker.getTypeOfSymbolAtLocation(property, variable.initializer));
            }
        }
        return builtinSymbol(symbol, type);
    };
    const builtinSymbol = (symbol: TS.Symbol, type: TS.Type): string | undefined => {
        if (!symbol.declarations?.some(isLibDeclaration)) return undefined;
        const signatures = checker.getSignaturesOfType(type, ts.SignatureKind.Call);
        for (const signature of signatures) {
            const declaration = signature.declaration;
            if (!declaration || !isLibDeclaration(declaration) || !ts.isMethodSignature(declaration) || !declaration.name || !ts.isIdentifier(declaration.name)) continue;
            const name = ts.idText(declaration.name);
            const parent = declaration.parent;
            if (ts.isInterfaceDeclaration(parent) && ts.idText(parent.name) === "ObjectConstructor" && ["getPrototypeOf", "setPrototypeOf", "create", "getOwnPropertyDescriptor", "defineProperty"].includes(name)) return name;
            if (ts.isInterfaceDeclaration(parent) && ts.idText(parent.name) === "Object" && name === "isPrototypeOf") return name;
        }
        // Reflect functions are function declarations in the standard library namespace.
        for (const signature of signatures) {
            const declaration = signature.declaration;
            if (!declaration || !isLibDeclaration(declaration) || !ts.isFunctionDeclaration(declaration) || !declaration.name) continue;
            const block = declaration.parent;
            if (ts.isModuleBlock(block) && ts.isModuleDeclaration(block.parent) && ts.isIdentifier(block.parent.name) && ts.idText(block.parent.name) === "Reflect") {
                const name = ts.idText(declaration.name);
                if (["getPrototypeOf", "setPrototypeOf", "get", "set", "has", "deleteProperty", "defineProperty", "getOwnPropertyDescriptor"].includes(name)) return name;
            }
        }
        return undefined;
    };
    return (node: TS.Node, report: (node: TS.Node, message: string) => void): void => {
        if (!affected.size) return;
        const accessProblem = (type: TS.Type, name: string): string | undefined => {
            if (!hasIdentity(type)) return undefined;
            if (type.flags & ts.TypeFlags.Union) {
                for (const part of (type as TS.UnionType).types) {
                    const problem = accessProblem(part, name);
                    if (problem) return problem;
                }
                return undefined;
            }
            const constructor = checker.getSignaturesOfType(type, ts.SignatureKind.Construct).length > 0;
            if (name === "__proto__" || name === "prototype" && constructor) {
                return `Prototype access '${name}' is unsupported for multiple-inheritance classes and their instances.`;
            }
            else if (name === "constructor" && !constructor) {
                const symbol = checker.getPropertyOfType(type, name);
                if (!symbol || symbol.declarations?.every(isLibDeclaration)) return "Reflective constructor access is unsupported for multiple-inheritance instances.";
            }
            return undefined;
        };
        const checkAccess = (type: TS.Type, name: string, location: TS.Node) => {
            const problem = accessProblem(type, name);
            if (problem) report(location, problem);
        };
        const access = accessName(node);
        if (access) checkAccess(checker.getTypeAtLocation(access.receiver), access.name, access.location);
        if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent) && !node.dotDotDotToken) {
            const nameNode = node.propertyName ?? node.name;
            const name = keyOf(nameNode);
            if (name !== undefined) checkAccess(checker.getTypeAtLocation(node.parent), name, nameNode);
        }
        if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isObjectLiteralExpression(node.left)) {
            const checkPattern = (pattern: TS.ObjectLiteralExpression, type: TS.Type): void => {
                for (const property of pattern.properties) {
                    if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) continue;
                    const name = keyOf(property.name);
                    if (name === undefined) continue;
                    checkAccess(type, name, property.name);
                    if (ts.isPropertyAssignment(property) && ts.isObjectLiteralExpression(property.initializer)) {
                        const symbol = checker.getPropertyOfType(type, name);
                        if (symbol) checkPattern(property.initializer, checker.getTypeOfSymbolAtLocation(symbol, node.right));
                    }
                }
            };
            checkPattern(node.left, checker.getTypeAtLocation(node.right));
        }
        if (!ts.isCallExpression(node)) return;
        const method = accessName(node.expression);
        const indirect = method && (method.name === "call" || method.name === "apply") ? method : undefined;
        const callee = indirect ? indirect.receiver : node.expression;
        const name = builtin(callee);
        if (!name) return;
        let args: readonly TS.Expression[] = node.arguments;
        let receiver: TS.Expression | undefined;
        if (indirect) {
            receiver = args[0];
            if (indirect.name === "apply") {
                const list = args[1];
                args = list && ts.isArrayLiteralExpression(list) ? list.elements.filter(ts.isExpression) : [];
            }
            else args = args.slice(1);
        }
        else if (name === "isPrototypeOf") receiver = accessName(callee)?.receiver;
        if (["get", "set", "has", "deleteProperty", "defineProperty", "getOwnPropertyDescriptor"].includes(name)) {
            const key = literalKey(args[1]);
            if (args[0] && key !== undefined) checkAccess(checker.getTypeAtLocation(args[0]), key, args[1]);
            return;
        }
        const dangerous = name === "isPrototypeOf" ? known(receiver) || known(args[0]) : known(args[0]) || name === "setPrototypeOf" && known(args[1]);
        if (dangerous) report(node.expression, `Object prototype operation '${name}' is unsupported for multiple-inheritance classes and their instances.`);
    };
}
