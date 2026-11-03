import type { TSPPSyntaxCursor, TSPPTypeScript } from "@tspp/plugin-sdk/compiler";
import type * as TS from "typescript-upstream";

import { areMlttTermsDefinitionallyEqual, mlttBoolType, mlttNatType, mlttPi, mlttUniverse, printMlttTerm, type MlttTerm } from "./core";

/** The kind of a type: an ordinary type at a universe level, a type constructor, or a term such as `Nat`. */
export type TypeKind = OrdinaryTypeKind | FunctionTypeKind | TermTypeKind;

export interface OrdinaryTypeKind {
    readonly kind: "type";
    readonly level: number;
}

export interface FunctionTypeKind {
    readonly kind: "function";
    readonly parameters: readonly TypeKind[];
    readonly result: TypeKind;
}

/** Types that stand for values of a term of the type theory, such as `2`, of kind `Nat`. */
export interface TermTypeKind {
    readonly kind: "term";
    readonly term: MlttTerm;
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

    const name = cursor.token() === kinds.Identifier ? cursor.tokenText() : undefined;
    const level = name === undefined ? undefined : universeLevel(name);
    const head: TypeKind | undefined = level !== undefined ? { kind: "type", level }
        : name === "Nat" ? { kind: "term", term: mlttNatType() }
        : name === "Bool" ? { kind: "term", term: mlttBoolType() }
        : undefined;
    if (!head) throw new Error(`Expected a type kind, received '${cursor.tokenText()}'.`);
    cursor.nextToken();
    if (cursor.token() !== kinds.EqualsGreaterThanToken) return head;
    cursor.nextToken();
    return { kind: "function", parameters: [head], result: parseKind(ts, cursor) };
}

export function kindToString(kind: TypeKind): string {
    if (kind.kind === "type") return kind.level === 0 ? "Type" : `Type${kind.level}`;
    if (kind.kind === "term") return printMlttTerm(kind.term);
    const parameters = kind.parameters.length === 1
        ? kindToString(kind.parameters[0])
        : `(${kind.parameters.map(kindToString).join(", ")})`;
    return `${parameters} => ${kindToString(kind.result)}`;
}

/**
 * A kind as feature-rich declaration output writes it: every universe with its level (`Type0`, not `Type`), and a
 * single constructor parameter in parentheses, so that `(Type0 => Type0) => Type0` reads back as written.
 */
export function kindToDeclarationString(kind: TypeKind): string {
    if (kind.kind === "type") return `Type${kind.level}`;
    if (kind.kind === "term") return printMlttTerm(kind.term);
    const parameters = kind.parameters.length === 1 && kind.parameters[0].kind !== "function"
        ? kindToDeclarationString(kind.parameters[0])
        : `(${kind.parameters.map(kindToDeclarationString).join(", ")})`;
    return `${parameters} => ${kindToDeclarationString(kind.result)}`;
}

/** A kind as a term of the type theory, so that the kernel decides when two kinds are the same. */
export function kindToTerm(kind: TypeKind): MlttTerm {
    if (kind.kind === "type") return mlttUniverse(kind.level);
    if (kind.kind === "term") return kind.term;
    return kind.parameters.reduceRight<MlttTerm>((result, parameter) => mlttPi("_", kindToTerm(parameter), result), kindToTerm(kind.result));
}

/** A kind written as a term: `Type1`, and a Pi type whose result does not depend on its parameter, read as kinds. */
export function termToKind(term: MlttTerm): TypeKind {
    if (term.kind === "universe") return { kind: "type", level: term.level };
    if (term.kind === "pi" && !hasVariable(term.codomain)) {
        return { kind: "function", parameters: [termToKind(term.domain)], result: termToKind(term.codomain) };
    }
    return { kind: "term", term };
}

/** Whether a term has a variable in it; only a closed result reads as a kind. */
function hasVariable(term: unknown): boolean {
    if (!term || typeof term !== "object") return false;
    if ((term as { readonly kind?: string; }).kind === "variable") return true;
    return Object.values(term).some(child => Array.isArray(child) ? child.some(hasVariable) : hasVariable(child));
}

export function kindsEqual(left: TypeKind, right: TypeKind): boolean {
    // How many arguments a constructor takes at once is TypeScript's concern: the kernel's functions take one.
    if (left.kind === "function" && right.kind === "function" && left.parameters.length !== right.parameters.length) return false;
    return areMlttTermsDefinitionallyEqual(kindToTerm(left), kindToTerm(right));
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
    /** The keywords active plugins claim for declarations. */
    readonly getDeclarationKeywords: () => readonly string[];
    /** Kind annotations of type parameters and type aliases. */
    readonly declarationKinds: WeakMap<TS.Node, TypeKind>;
    /** Where an authored kind annotation, from its `:` to the end of the kind, is written for a declaration. */
    readonly kindAnnotations: WeakMap<TS.Node, { readonly start: number; readonly end: number; }>;
    /** Anonymous type constructors `<T> =>> body`, as function type nodes without parameters. */
    readonly constructors: WeakSet<TS.Node>;
    /** Applications of a type to type arguments, as function type nodes whose parameter types are the parts. */
    readonly applications: WeakMap<TS.Node, { readonly target: TS.TypeNode; readonly typeArguments: readonly TS.TypeNode[]; }>;
    /** Type nodes that stand for authored syntax, with the start of that syntax (its end is the node's end). */
    readonly authored: WeakMap<TS.Node, number>;
    /** Where authored syntax ends, for a type node with no range of its own. */
    readonly authoredEnds: WeakMap<TS.Node, number>;
    /** The `infer` nodes a type-level `let` lowers to, with the authored name they bind. */
    readonly letBindings: WeakMap<TS.Node, TS.Identifier>;
    /** Type nodes lowered from a term of the type theory, with that term; the kernel checks them, not the kinds. */
    readonly terms: WeakMap<TS.Node, MlttTerm>;
    /** The built-in names lowered terms read, which only the checker can tell apart from a type in another file. */
    readonly termBuiltins: WeakMap<TS.Node, ReadonlySet<string>>;
    /** Lowered terms with a part TypeScript cannot type, which only the kernel checks. */
    readonly unchecked: WeakSet<TS.Node>;
    /** An alias's annotation as a term, for the kernel to check its body against. */
    readonly termAnnotations: WeakMap<TS.Node, MlttTerm>;
    /** The file being parsed: its earlier aliases, and the names it declares itself. */
    file?: { readonly sourceText: string; readonly aliases: Map<string, MlttTerm>; declared?: ReadonlySet<string>; };
    /** Whether any kind annotation or type constructor was parsed, so that ordinary programs skip kind work. */
    used: boolean;
}

export function createTypeSyntaxModel(getDeclarationKeywords: () => readonly string[]): TypeSyntaxModel {
    return {
        getDeclarationKeywords,
        declarationKinds: new WeakMap(),
        kindAnnotations: new WeakMap(),
        constructors: new WeakSet(),
        applications: new WeakMap(),
        authored: new WeakMap(),
        authoredEnds: new WeakMap(),
        letBindings: new WeakMap(),
        terms: new WeakMap(),
        termBuiltins: new WeakMap(),
        unchecked: new WeakSet(),
        termAnnotations: new WeakMap(),
        used: false,
    };
}
