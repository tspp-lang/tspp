import { maskNonCode } from "@tspp/plugin-sdk";
import type { TSPPAnalysisDiagnostic, TSPPSyntaxExtension, TSPPTypeScript } from "@tspp/plugin-sdk/compiler";
import type * as TS from "typescript-upstream";

import { expressionToSmtTerm, termForSort, type ExpressionEnvironment, type Sort, type Term } from "./expression";
import { parseProperties } from "./contracts";
import { ts } from "./host-api";

function matchingBrace(code: string, open: number): number {
    let depth = 0;
    for (let index = open; index < code.length; index++) {
        if (code[index] === "{") depth++;
        else if (code[index] === "}" && --depth === 0) return index;
    }
    return -1;
}

export interface RefinementModel {
    readonly name: string;
    readonly sort: Sort;
    readonly predicate: string;
    readonly start: number;
}

export function refinementTerm(refinement: RefinementModel, value: Term, functions?: ExpressionEnvironment["functions"]): Term {
    return expressionToSmtTerm(refinement.predicate, {
        substitutions: { value: termForSort(value, refinement.sort, `Value of '${refinement.name}'`) },
        functions, defaultNumberSort: refinement.sort === "Real" ? "Real" : "NumberInt",
    });
}

interface RefinementClause {
    /** The refined type and its clause, as written. */
    readonly text: string;
    readonly base: TS.TypeNode;
    readonly open: number;
    readonly close: number;
}

const refinementClauses = new WeakMap<TS.Node, RefinementClause>();

/**
 * `bigint with { predicate: ...; }`: the parser reads the base type, and the clause is what only proofs read. The checker
 * sees the base type in parentheses, a node that can span the clause, which the token of a keyword type cannot.
 */
export function createRefinementClauses(host: TSPPTypeScript): TSPPSyntaxExtension {
    const kinds = host.SyntaxKind;
    const refinable: readonly TS.SyntaxKind[] = [kinds.BigIntKeyword, kinds.NumberKeyword, kinds.BooleanKeyword];
    return {
        position: "postfix-type",
        startTokens: [kinds.WithKeyword],
        keywords: ["with"],
        isStart: cursor => !!cursor.precedingType && refinable.includes(cursor.precedingType.kind) && cursor.lookAhead(() => cursor.nextToken() === kinds.OpenBraceToken),
        parse(cursor) {
            const base = cursor.precedingType!;
            cursor.nextToken();
            const open = cursor.getTokenStart();
            const sourceText = cursor.getSourceText();
            const close = matchingBrace(maskNonCode(sourceText), open);
            if (close < 0) throw new Error("A refinement clause needs its closing '}'.");
            while (cursor.getTokenStart() < close) cursor.nextToken();
            cursor.nextToken();
            const refined = cursor.finishNode(cursor.factory.createParenthesizedType(base), base.pos, close + 1);
            refinementClauses.set(refined, { text: sourceText.slice(base.pos, close + 1).trim(), base, open, close });
            return refined;
        },
        restoreDeclaration: node => refinementClauses.get(host.getOriginalNode(node))?.text,
        restoreCompatibilityDeclaration(node) {
            const clause = refinementClauses.get(host.getOriginalNode(node));
            return clause && clause.text.slice(0, clause.base.end - clause.base.pos).trim();
        },
    };
}

function forEachNode(node: TS.Node, visit: (node: TS.Node) => void): void {
    visit(node);
    ts.forEachChild(node, child => forEachNode(child, visit));
}

export function collectRefinements(sourceFile: TS.SourceFile, sourceText: string): Map<string, RefinementModel> {
    const refinements = new Map<string, RefinementModel>();
    forEachNode(sourceFile, node => {
        const clause = ts.isTypeAliasDeclaration(node) ? refinementClauses.get(node.type) : undefined;
        if (!clause || !ts.isTypeAliasDeclaration(node)) return;
        const properties = sourceText.slice(clause.open + 1, clause.close);
        const property = /\bpredicate\s*:\s*([^;]+);/.exec(properties);
        if (!property) return;
        const predicate = property[1].trim();
        const start = clause.open + 1 + property.index + property[0].indexOf(property[1]) + property[1].indexOf(predicate);
        const name = ts.idText(node.name);
        const numberModel = parseProperties(properties, clause.open + 1).find(item => item.name === "numberModel")?.value.replace(/["']/g, "");
        const sort = clause.base.kind === ts.SyntaxKind.BooleanKeyword ? "Bool"
            : clause.base.kind === ts.SyntaxKind.BigIntKeyword ? "Int"
            : numberModel === "mathematical-real" ? "Real" : "NumberInt";
        refinements.set(name, { name, sort, predicate, start });
    });
    return refinements;
}

/** The type a refinement clause extends is an alias's whole type; proofs read no clause anywhere else, so none may silently pass. */
export function reportMisplacedRefinements(sourceFile: TS.SourceFile, diagnostics: TSPPAnalysisDiagnostic[]): void {
    forEachNode(sourceFile, node => {
        const clause = refinementClauses.get(node);
        if (!clause || ts.isTypeAliasDeclaration(node.parent)) return;
        diagnostics.push({
            fileName: sourceFile.fileName, start: node.getStart(sourceFile), length: node.end - node.getStart(sourceFile),
            code: 19005, category: "error", source: "TS++ verification", message: "A refinement clause must be the whole type of a type alias.",
        });
    });
}

/** Where an alias's type ends as it reads before any refinement clause. */
export function refinedTypeEnd(type: TS.TypeNode): number {
    return refinementClauses.get(type)?.base.end ?? type.end;
}
