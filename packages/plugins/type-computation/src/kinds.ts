import type { TSPPSyntaxCursor, TSPPTypeScript } from "@tspp/plugin-sdk/compiler";
import type * as TS from "typescript-upstream";

/** The kind of a type: an ordinary type at a universe level, or a type constructor. */
export type TypeKind = OrdinaryTypeKind | FunctionTypeKind;

export interface OrdinaryTypeKind {
    readonly kind: "type";
    readonly level: number;
}

export interface FunctionTypeKind {
    readonly kind: "function";
    readonly parameters: readonly TypeKind[];
    readonly result: TypeKind;
}

export const ordinaryKind: OrdinaryTypeKind = { kind: "type", level: 0 };

const universeName = /^Type(0|[1-9]\d*)?$/u;

/** The level of a universe name such as `Type` or `Type1`. */
export function universeLevel(name: string): number | undefined {
    const match = universeName.exec(name);
    return match ? match[1] === undefined ? 0 : Number(match[1]) : undefined;
}

/** Parses a kind such as `Type`, `Type1 => Type`, or `(Type, Type => Type) => Type` at the cursor. */
export function parseKind(ts: TSPPTypeScript, cursor: TSPPSyntaxCursor): TypeKind {
    const kinds = ts.SyntaxKind;
    if (cursor.token() === kinds.OpenParenToken) {
        cursor.nextToken();
        const parameters: TypeKind[] = [];
        while (cursor.token() !== kinds.CloseParenToken && cursor.token() !== kinds.EndOfFileToken) {
            parameters.push(parseKind(ts, cursor));
            if (cursor.token() !== kinds.CommaToken) break;
            cursor.nextToken();
        }
        cursor.parseExpected(kinds.CloseParenToken);
        if (cursor.token() !== kinds.EqualsGreaterThanToken) {
            if (parameters.length === 1) return parameters[0];
            throw new Error("A parenthesized kind list must be followed by '=>'.");
        }
        cursor.nextToken();
        return { kind: "function", parameters, result: parseKind(ts, cursor) };
    }

    const level = cursor.token() === kinds.Identifier ? universeLevel(cursor.tokenText()) : undefined;
    if (level === undefined) throw new Error(`Expected a type kind, received '${cursor.tokenText()}'.`);
    cursor.nextToken();
    const head: TypeKind = { kind: "type", level };
    if (cursor.token() !== kinds.EqualsGreaterThanToken) return head;
    cursor.nextToken();
    return { kind: "function", parameters: [head], result: parseKind(ts, cursor) };
}

export function kindToString(kind: TypeKind): string {
    if (kind.kind === "type") return kind.level === 0 ? "Type" : `Type${kind.level}`;
    const parameters = kind.parameters.length === 1
        ? kindToString(kind.parameters[0])
        : `(${kind.parameters.map(kindToString).join(", ")})`;
    return `${parameters} => ${kindToString(kind.result)}`;
}

export function kindsEqual(left: TypeKind, right: TypeKind): boolean {
    if (left.kind === "type" || right.kind === "type") {
        return left.kind === "type" && right.kind === "type" && left.level === right.level;
    }
    return left.parameters.length === right.parameters.length
        && left.parameters.every((parameter, index) => kindsEqual(parameter, right.parameters[index]))
        && kindsEqual(left.result, right.result);
}

/** Hover text for a universe such as `Type1`. */
export function universeQuickInfo(token: { readonly text: string; readonly start: number; readonly length: number; }) {
    const universe = /^Type(\d*)$/.exec(token.text);
    if (!universe) return undefined;
    const level = universe[1] ? Number(universe[1]) : 0;
    return {
        start: token.start,
        length: token.length,
        display: `type Type${level}: Type${level + 1}`,
        documentation: `The universe whose inhabitants have level ${level}.`,
    };
}

export function kindParameterOwner(sourceText: string, position: number, name: string): string | undefined {
    const expression = /\btype\s+([A-Za-z_$][\w$]*)\s*<([^;>{}]*)>\s*(?::\s*([^=]+))?=/g;
    let match: RegExpExecArray | null;
    while ((match = expression.exec(sourceText))) {
        if (position < match.index || position > expression.lastIndex) continue;
        const parameter = match[2].split(",").map(value => value.trim())
            .find(value => value.split(/\s*:/)[0] === name);
        if (!parameter) continue;
        const resultKind = match[3]?.trim();
        return `type ${match[1]}<${match[2].trim()}>${resultKind ? `: ${resultKind}` : ""}`;
    }
    return undefined;
}

/** Nodes this plugin produced or annotated while parsing, shared by its checker and declaration output. */
export interface TypeSyntaxModel {
    /** Kind annotations of type parameters and type aliases. */
    readonly declarationKinds: WeakMap<TS.Node, TypeKind>;
    /** Anonymous type constructors `<T> =>> body`, as function type nodes without parameters. */
    readonly constructors: WeakSet<TS.Node>;
    /** Applications of a type to type arguments, as function type nodes whose parameter types are the parts. */
    readonly applications: WeakMap<TS.Node, { readonly target: TS.TypeNode; readonly typeArguments: readonly TS.TypeNode[]; }>;
    /** Type nodes that stand for authored syntax, with the start of that syntax (its end is the node's end). */
    readonly authored: WeakMap<TS.Node, number>;
    /** The `infer` nodes a type-level `let` lowers to, with the authored name they bind. */
    readonly letBindings: WeakMap<TS.Node, TS.Identifier>;
    /** Whether any kind annotation or type constructor was parsed, so that ordinary programs skip kind work. */
    used: boolean;
}

export function createTypeSyntaxModel(): TypeSyntaxModel {
    return {
        declarationKinds: new WeakMap(),
        constructors: new WeakSet(),
        applications: new WeakMap(),
        authored: new WeakMap(),
        letBindings: new WeakMap(),
        used: false,
    };
}
