import type { TSPPTypeScript } from "@tspp/plugin-sdk/compiler";
import type * as TS from "typescript-upstream";

import { kindToDeclarationString, type TypeKind, type TypeSyntaxModel } from "./kinds";

/** Well-known generic globals that a constructor argument may name without type arguments. */
const genericGlobals = new Set(["Array", "ReadonlyArray", "Promise", "Map", "ReadonlyMap", "Set", "ReadonlySet", "WeakMap", "WeakSet"]);

/**
 * Declaration output: `.d.tspp` keeps the authored type-level syntax and kind annotations; the TypeScript-compatible
 * `.d.ts` writes `unknown` for what TypeScript cannot express and gives constructor aliases placeholder parameters.
 */
export function createDeclarationRestorers(ts: TSPPTypeScript, model: TypeSyntaxModel) {
    const sourceFileOf = (node: TS.Node): TS.SourceFile => {
        let current = node;
        while (!ts.isSourceFile(current)) current = current.parent;
        return current;
    };
    const sourceText = (node: TS.Node) => sourceFileOf(node).text;
    /**
     * The source text of `node` from `start` to `end`, with each kind annotation written inside it in its declaration
     * form, so that `F: Type => Type` restores as `F: Type0 => Type0` like the rest of the declaration output.
     */
    const restoredText = (node: TS.Node, start: number, end = node.end) => {
        const annotations: { readonly start: number; readonly end: number; readonly kind: TypeKind; }[] = [];
        const visit = (current: TS.Node): void => {
            const range = model.kindAnnotations.get(current);
            const kind = model.declarationKinds.get(current);
            if (range && kind && range.start >= start && range.end <= end) annotations.push({ ...range, kind });
            ts.forEachChild(current, visit);
        };
        visit(node);
        const text = sourceText(node);
        let result = "";
        let position = start;
        for (const annotation of annotations.sort((left, right) => left.start - right.start)) {
            if (annotation.start < position) continue;
            result += text.slice(position, annotation.start) + `: ${kindToDeclarationString(annotation.kind)}`;
            position = annotation.end;
        }
        return result + text.slice(position, end);
    };
    const authoredText = (node: TS.Node, start: number) => restoredText(node, start).trimStart();
    const modifiersOf = (node: TS.Node) =>
        (ts.canHaveModifiers(node) ? ts.getModifiers(node) ?? [] : []).map(modifier => `${ts.tokenToString(modifier.kind)} `).join("");
    const constructorAliasArity = (alias: TS.TypeAliasDeclaration): number => {
        if (alias.typeParameters?.length) return 0;
        const kind = model.declarationKinds.get(alias);
        if (kind?.kind === "function") return kind.parameters.length;
        return model.constructors.has(alias.type) ? (alias.type as TS.FunctionTypeNode).typeParameters?.length ?? 0 : 0;
    };

    return {
        restoreDeclaration(node: TS.Node): string | undefined {
            const original = ts.getOriginalNode(node);
            if (original.pos < 0) return undefined;
            const start = model.authored.get(original);
            if (start !== undefined) return authoredText(original, start);
            if (!model.declarationKinds.has(original)) return undefined;
            if (ts.isTypeParameterDeclaration(original)) return authoredText(original, original.pos);
            if (ts.isTypeAliasDeclaration(original)) {
                const text = sourceText(original);
                return modifiersOf(node) + restoredText(original, text.lastIndexOf("type", original.name.pos)).trimEnd();
            }
            return undefined;
        },
        restoreCompatibilityDeclaration(node: TS.Node): string | undefined {
            const original = ts.getOriginalNode(node);
            if (model.constructors.has(original) || model.applications.has(original)) return "unknown";
            if (ts.isTypeAliasDeclaration(original)) {
                const arity = constructorAliasArity(original);
                if (!arity) return undefined;
                const parameters = Array.from({ length: arity }, (_, index) => `T${index} = unknown`).join(", ");
                return `${modifiersOf(node)}type ${ts.idText(original.name)}<${parameters}> = unknown;`;
            }
            if (ts.isTypeReferenceNode(original) && ts.isIdentifier(original.typeName) && isUnsupportedReference(original, ts.idText(original.typeName))) {
                return "unknown";
            }
            return undefined;
        },
    };

    /** References TypeScript cannot read: universes, applied constructor parameters, and bare constructor names. */
    function isUnsupportedReference(reference: TS.TypeReferenceNode, name: string): boolean {
        if (/^Type\d*$/u.test(name)) return true;
        for (let current: TS.Node | undefined = reference.parent; current; current = current.parent) {
            const parameter = (current as { readonly typeParameters?: TS.NodeArray<TS.TypeParameterDeclaration>; }).typeParameters
                ?.find(candidate => ts.idText(candidate.name) === name);
            if (parameter) return isConstructorKind(model.declarationKinds.get(parameter));
        }
        if (reference.typeArguments?.length) return false;
        if (genericGlobals.has(name)) return true;
        return sourceFileOf(reference).statements.some(statement =>
            (ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement) || ts.isClassDeclaration(statement))
            && statement.name !== undefined && ts.idText(statement.name) === name
            && (!!statement.typeParameters?.length || ts.isTypeAliasDeclaration(statement) && constructorAliasArity(statement) > 0)
        );
    }
}

function isConstructorKind(kind: TypeKind | undefined): boolean {
    return kind?.kind === "function";
}
