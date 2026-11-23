import { createGeneratedName } from "@tspp/plugin-sdk";
import type { TSPPSyntaxCursor, TSPPTypeScript } from "@tspp/plugin-sdk/compiler";
import type * as TS from "typescript-upstream";

export const DIAGNOSTIC_MAPPED_SUPER = 19126;
export const DIAGNOSTIC_QUALIFIED_SUPER = 19127;

export interface MappedEntry {
    readonly key: TS.Expression;
    readonly label: boolean;
    readonly index: number;
    readonly arguments: TS.ArrayLiteralExpression;
}
export interface MappedSuper {
    readonly call: TS.CallExpression;
    readonly entries: readonly MappedEntry[];
    readonly before: readonly TS.Statement[];
}
export interface SelectedSuper {
    readonly key: TS.Expression;
    readonly index: number;
    readonly isStatic: boolean;
}

/** Copies syntax without sharing parent pointers or source ownership with the authored tree. */
export function copySyntax<T extends TS.Node>(node: T): T {
    const copy = (value: unknown): unknown => {
        if (Array.isArray(value)) return Object.assign(value.map(copy), { pos: -1, end: -1 });
        if (!value || typeof value !== "object" || !("kind" in value)) return value;
        const result: Record<string, unknown> = Object.create(Object.getPrototypeOf(value));
        for (const [key, child] of Object.entries(value)) {
            if (["parent", "original", "symbol", "locals", "emitNode", "flowNode", "nextContainer", "jsDoc"].includes(key)) continue;
            result[key] = copy(child);
        }
        result.pos = result.end = -1;
        result.flags = (Number(result.flags) || 0) | 16; // NodeFlags.Synthesized.
        return result;
    };
    return copy(node) as T;
}

export function createMappedSuper(ts: TSPPTypeScript, entityText: (node: TS.Expression) => string) {
    const selections = new WeakMap<TS.Node, SelectedSuper>();
    const probes = new WeakSet<TS.Node>();
    const k = ts.SyntaxKind;
    const entity = (node: TS.Expression): TS.EntityName => ts.isIdentifier(node) ? copySyntax(node)
        : ts.factory.createQualifiedName(entity((node as TS.PropertyAccessExpression).expression), copySyntax((node as TS.PropertyAccessExpression).name as TS.Identifier));
    const isEntity = (node: TS.Expression): boolean => ts.isIdentifier(node) || ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.name) && isEntity(node.expression);

    function prepare(cursor: TSPPSyntaxCursor, types: readonly TS.ExpressionWithTypeArguments[], members: TS.ClassElement[], className: TS.Identifier): MappedSuper | undefined {
        const f = cursor.factory;
        const error = (node: TS.Node, message: string, code = DIAGNOSTIC_MAPPED_SUPER) => cursor.parseErrorAt(node.pos, node.end, message, code);
        const indexOf = (key: TS.Expression, label: boolean) => types.findIndex(type => label
            ? ts.isIdentifier(type.expression) && entityText(type.expression) === entityText(key)
            : entityText(type.expression) === entityText(key));
        const constructors = members.filter(ts.isConstructorDeclaration);
        const calls: TS.CallExpression[] = [];
        const collect = (node: TS.Node): void => {
            if (ts.isClassLike(node) || ts.isFunctionLike(node) && !ts.isArrowFunction(node) && !ts.isConstructorDeclaration(node)) return;
            if (ts.isCallExpression(node) && node.expression.kind === k.SuperKeyword) calls.push(node);
            ts.forEachChild(node, collect);
        };
        constructors.forEach(collect);
        const mappedCalls = calls.filter(call => call.arguments.length === 1 && ts.isObjectLiteralExpression(call.arguments[0]));
        let mapped: MappedSuper | undefined;
        if (mappedCalls.length) {
            const call = mappedCalls[0];
            if (calls.length !== 1) error(call, "A mapped constructor must contain exactly one direct 'super({ Base: [...] })' call.");
            const constructor = constructors.find(candidate => candidate.body?.statements.some(statement => ts.isExpressionStatement(statement) && statement.expression === call));
            if (!constructor) error(call, "The mapped super call must be a direct constructor statement.");
            const entries: MappedEntry[] = [];
            for (const property of (call.arguments[0] as TS.ObjectLiteralExpression).properties) {
                if (!ts.isPropertyAssignment(property) || !ts.isArrayLiteralExpression(property.initializer)) {
                    error(property, "Each mapped super entry must be 'Base: [arguments]' or '[module.Base]: [arguments]'; use [] for a base without arguments.");
                    continue;
                }
                if (property.initializer.elements.some(ts.isOmittedExpression)) error(property.initializer, "Mapped super argument tuples cannot contain holes; write undefined explicitly.");
                const label = ts.isIdentifier(property.name);
                const key = label ? property.name as TS.Identifier : ts.isComputedPropertyName(property.name) ? property.name.expression : undefined;
                if (!key || !isEntity(key)) {
                    error(property.name, "A mapped super key must name a direct base; use [module.Base] for a qualified base.");
                    continue;
                }
                const index = indexOf(key, label);
                if (label && index < 0) error(key, `Unknown mapped super base '${entityText(key)}'.`);
                entries.push({ key, label, index, arguments: property.initializer });
            }
            const aliasName = (index: number) => createGeneratedName(ts, className, "__tsppBaseConstructor", String(index));
            const before = types.map((type, index) => f.createTypeAliasDeclaration(undefined, aliasName(index), undefined, f.createTypeQueryNode(entity(type.expression))));
            mapped = { call, entries, before };
            // A marked construction checks real overloads, contextual types, and unconditional argument flow.
            // Emit replaces it with the argument tuple before any JavaScript executes.
            const tuples = entries.map(entry => {
                const base = types[entry.index];
                const target = base ? f.createParenthesizedExpression(f.createAsExpression(f.createAsExpression(f.createNull(), f.createKeywordTypeNode(k.UnknownKeyword)), f.createTypeReferenceNode(aliasName(entry.index)))) : entry.key;
                const probe = ts.setTextRange(f.createNewExpression(target, base?.typeArguments && f.createNodeArray(base.typeArguments.map(copySyntax)), entry.arguments.elements), entry.arguments);
                if (!entry.label && base) {
                    const parents = (node: TS.Node, parent: TS.Node): void => {
                        (node as { parent: TS.Node }).parent = parent;
                        ts.forEachChild(node, child => parents(child, node));
                    };
                    parents(entry.key, call);
                }
                probes.add(probe);
                return probe;
            });
            const packet = f.createArrayLiteralExpression(f.createNodeArray(tuples));
            (call as { arguments: TS.NodeArray<TS.Expression> }).arguments = f.createNodeArray([packet]);
        }

        for (const member of members) {
            const isStatic = ts.canHaveModifiers(member) && !!ts.getModifiers(member)?.some(modifier => modifier.kind === k.StaticKeyword);
            const visit = (node: TS.Node, parent?: TS.Node): void => {
                if (ts.isClassLike(node) || node !== member && ts.isFunctionLike(node) && !ts.isArrowFunction(node)) return;
                if (ts.isElementAccessExpression(node) && node.expression.kind === k.SuperKeyword) {
                    const key = node.argumentExpression;
                    if (!isEntity(key) || !(parent && (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === node)) {
                        error(node, "Use a qualified base member such as 'super[Base].method()'.", DIAGNOSTIC_QUALIFIED_SUPER);
                        return;
                    }
                    const index = indexOf(key, false);
                    const base = types[index];
                    const type = isStatic ? f.createTypeQueryNode(entity(base?.expression ?? key))
                        : base ? f.createTypeReferenceNode(entity(base.expression), base.typeArguments && f.createNodeArray(base.typeArguments.map(copySyntax)))
                        : f.createIndexedAccessTypeNode(f.createTypeQueryNode(entity(key)), f.createLiteralTypeNode(f.createStringLiteral("prototype")));
                    const replacement = ts.setTextRange(f.createParenthesizedExpression(f.createAsExpression(f.createThis(), type)), node);
                    selections.set(replacement, { key, index, isStatic });
                    const parents = (child: TS.Node, owner: TS.Node): void => {
                        (child as { parent: TS.Node }).parent = owner;
                        ts.forEachChild(child, nested => parents(nested, child));
                    };
                    parents(key, replacement);
                    // The parser supplies parent pointers after the extension returns, so replace by identity here.
                    (parent as { expression: TS.Expression }).expression = replacement;
                    return;
                }
                if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && node.expression.kind === k.SuperKeyword) {
                    error(node, "Classes with multiple bases must select the base explicitly: 'super[Base].member'.", DIAGNOSTIC_QUALIFIED_SUPER);
                    return;
                }
                ts.forEachChild(node, child => visit(child, node));
            };
            visit(member);
        }
        const refresh = (node: TS.Node): void => {
            (node as TS.Node & { transformFlags: number }).transformFlags |= 1; // ContainsTypeScript: the parsed member now holds generated assertions.
            ts.forEachChild(node, refresh);
        };
        members.forEach(refresh);
        return mapped;
    }
    return {
        prepareMembers: prepare,
        getSelectedSuper: (node: TS.Node) => selections.get(ts.getOriginalNode(node)),
        isConstructorProbe: (node: TS.Node) => probes.has(ts.getOriginalNode(node)),
    };
}
