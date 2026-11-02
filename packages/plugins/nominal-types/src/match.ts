import type { TSPPSyntaxCursor, TSPPSyntaxExtension, TSPPTypeScript } from "@tspp/plugin-sdk/compiler";
import type * as TS from "typescript-upstream";

import { markGenerated } from "./synthesize";

export interface MatchBinding {
    readonly kind: "binding";
    readonly name: TS.Identifier;
}

export interface MatchPattern {
    readonly kind: "constructor";
    readonly variant: string;
    readonly start: number;
    readonly end: number;
    readonly elements: readonly (MatchBinding | MatchPattern)[];
}

export interface MatchArm {
    readonly patterns: readonly MatchPattern[];
    readonly guarded: boolean;
}

/** What the diagnostics need from a lowered `match`: its scrutinee, its arms, and where its patterns are written. */
export interface LoweredMatch {
    readonly scrutinee: TS.Expression;
    readonly arms: readonly MatchArm[];
    readonly start: number;
    readonly end: number;
    /** Where each arm's patterns are written; diagnostics there come from the generated tag tests and field reads. */
    readonly patternRanges: readonly { readonly start: number; readonly end: number; }[];
}

export interface ValueMatches {
    readonly extension: TSPPSyntaxExtension;
    /** Lowered matches by the call expression they became. */
    readonly matches: WeakMap<TS.Node, LoweredMatch>;
    readonly count: () => number;
}

/**
 * `match value { A => a, B(x) if x > 0 => b, B(x) => c, _ => d }` lowers while it is parsed to a single-evaluation
 * tag dispatch, `(($m = value) => $m._tag === "A" ? a : ... : void 0 as never)()`. Fields are read by position from
 * `_values`, and each binding is the parameter of an immediately invoked arrow, so it gets the narrowed field type.
 * The checker sees ordinary TypeScript; exhaustiveness and pattern errors are reported separately.
 */
export function createValueMatches(ts: TSPPTypeScript): ValueMatches {
    const kinds = ts.SyntaxKind;
    const matches = new WeakMap<TS.Node, LoweredMatch>();
    let count = 0;
    const range = <T extends TS.Node | TS.NodeArray<TS.Node>>(node: T, pos: number, end: number): T => ts.setTextRange(node, { pos, end });

    // `match` stays an ordinary identifier unless a scrutinee and its arms' `{` follow on the same line, so
    // `match = 6`, `match.x`, and `match(1)` followed by a block on the next line keep their TypeScript meaning.
    const isStart = (cursor: TSPPSyntaxCursor) => cursor.tokenText() === "match" && cursor.lookAhead(() => {
        cursor.nextToken();
        if (cursor.hasPrecedingLineBreak()) return false;
        cursor.parseAssignmentExpression();
        return cursor.token() === kinds.OpenBraceToken && !cursor.hasPrecedingLineBreak();
    });

    function parsePattern(cursor: TSPPSyntaxCursor): MatchPattern {
        const start = cursor.getTokenStart();
        const variant = cursor.parseIdentifier();
        const elements: (MatchBinding | MatchPattern)[] = [];
        if (cursor.parseOptional(kinds.OpenParenToken)) {
            while (cursor.token() !== kinds.CloseParenToken && cursor.token() !== kinds.EndOfFileToken) {
                const nested = cursor.lookAhead(() => {
                    cursor.parseIdentifier();
                    return cursor.token() === kinds.OpenParenToken;
                });
                elements.push(nested ? parsePattern(cursor) : { kind: "binding", name: cursor.parseIdentifier() });
                if (!cursor.parseOptional(kinds.CommaToken)) break;
            }
            cursor.parseExpected(kinds.CloseParenToken);
        }
        return { kind: "constructor", variant: ts.idText(variant), start, end: cursor.getNodePos(), elements };
    }

    function parse(cursor: TSPPSyntaxCursor): TS.Expression {
        const f = cursor.factory;
        const pos = cursor.getNodePos();
        const keywordStart = cursor.getTokenStart();
        cursor.nextToken();
        const scrutinee = cursor.parseAssignmentExpression();
        cursor.parseExpected(kinds.OpenBraceToken);
        const parsedArms: { patterns: MatchPattern[]; guard?: TS.Expression; guardStart: number; result: TS.Expression; resultStart: number; start: number; }[] = [];
        while (cursor.token() !== kinds.CloseBraceToken && cursor.token() !== kinds.EndOfFileToken) {
            const start = cursor.getNodePos();
            const patterns = [parsePattern(cursor)];
            while (cursor.parseOptional(kinds.BarToken)) patterns.push(parsePattern(cursor));
            let guard: TS.Expression | undefined;
            let guardStart = 0;
            if (cursor.token() === kinds.IfKeyword) {
                cursor.nextToken();
                guardStart = cursor.getTokenStart();
                guard = cursor.parseAssignmentExpression();
            }
            cursor.parseExpected(kinds.EqualsGreaterThanToken);
            const resultStart = cursor.getTokenStart();
            const result = cursor.parseAssignmentExpression();
            parsedArms.push({ patterns, guard, guardStart, result, resultStart, start });
            if (!cursor.parseOptional(kinds.CommaToken)) break;
        }
        // Generated nodes sit, zero-width, at token starts, where a diagnostic on one has a valid span.
        const closeStart = cursor.getTokenStart();
        cursor.parseExpected(kinds.CloseBraceToken);
        const end = cursor.getNodePos();

        // A computed scrutinee is held by a parameter named after the `match` keyword, whose source range it takes, so
        // the parameter covers `match <scrutinee>` and its name prints from source.
        const temporaryName = "match";
        /** A fresh reference to the scrutinee itself when reading it again is free, as for `value` or `this.state.value`. */
        const copyOf = (expression: TS.Expression): TS.Expression | undefined => {
            if (ts.isIdentifier(expression)) return f.createIdentifier(ts.idText(expression));
            if (expression.kind === kinds.ThisKeyword) return f.createThis();
            if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.name)) {
                const object = copyOf(expression.expression);
                return object && f.createPropertyAccessExpression(object, f.createIdentifier(ts.idText(expression.name)));
            }
            if (ts.isParenthesizedExpression(expression)) return copyOf(expression.expression);
            return undefined;
        };
        const direct = !!copyOf(scrutinee);
        // Generated nodes get empty ranges at token starts (`markGenerated`): the tag tests at their pattern, the field
        // reads after their arm. Diagnostics on them are empty and dropped as restatements of pattern errors.
        /** A reference to the scrutinee the checker binds, for the diagnostics; the scrutinee itself only when it is in the tree. */
        let checkedScrutinee: TS.Expression = scrutinee;
        let firstCopy: TS.Expression | undefined;
        const temporary = (_at: number) => {
            const copy = copyOf(scrutinee);
            if (copy) firstCopy ??= copy;
            return copy ?? f.createIdentifier(temporaryName);
        };
        /** `$m._values[0]._values[1]` */
        const fieldOf = (reference: TS.Expression, index: number, _at: number): TS.Expression =>
            f.createElementAccessExpression(f.createPropertyAccessExpression(reference, f.createIdentifier("_values")), f.createNumericLiteral(index));
        const tagTest = (reference: TS.Expression, pattern: MatchPattern, _at: number): TS.Expression =>
            f.createBinaryExpression(f.createPropertyAccessExpression(reference, f.createIdentifier("_tag")), f.createToken(kinds.EqualsEqualsEqualsToken), f.createStringLiteral(pattern.variant));
        const and = (left: TS.Expression, right: TS.Expression, _at: number): TS.Expression => {
            const both = f.createBinaryExpression(left, f.createToken(kinds.AmpersandAmpersandToken), right);
            return right.pos >= 0 ? range(both, right.pos, right.end) : both;
        };
        /** The tag tests of a pattern and its nested constructor patterns, reading the scrutinee anew each time. */
        const condition = (pattern: MatchPattern, read: (at: number) => TS.Expression, at: number): TS.Expression => {
            let test = tagTest(read(at), pattern, at);
            pattern.elements.forEach((element, index) => {
                if (element.kind === "constructor") test = and(test, condition(element, nestedAt => fieldOf(read(nestedAt), index, nestedAt), at), at);
            });
            return test;
        };
        /** Each binding of a pattern with the expression that reads its field. */
        const bindings = (pattern: MatchPattern, read: (at: number) => TS.Expression): { name: TS.Identifier; read: (at: number) => TS.Expression; }[] =>
            pattern.elements.flatMap((element, index) => {
                const field = (at: number) => fieldOf(read(at), index, at);
                return element.kind === "binding" ? [{ name: element.name, read: field }] : bindings(element, field);
            });
        /** `((a, b) => body)(field0, field1)`, or `body` when nothing is bound; `bodyStart` is the body's token start. */
        const bind = (bound: readonly { name: TS.Identifier; read: (at: number) => TS.Expression; }[], names: readonly TS.Identifier[], body: TS.Expression, bodyStart: number): TS.Expression => {
            if (!bound.length) return body;
            const parameters = names.map(name => name.pos >= 0 ? range(f.createParameterDeclaration(undefined, undefined, name), name.pos, name.end) : f.createParameterDeclaration(undefined, undefined, name));
            const positioned = names[0].pos >= 0;
            const parameterList = f.createNodeArray(parameters);
            if (positioned) range(parameterList, names[0].pos, names[names.length - 1].end);
            // The checker reads the line of `=>`, so it needs a real, if empty, position.
            const arrow = range(f.createArrowFunction(undefined, undefined, parameterList, undefined, range(f.createToken(kinds.EqualsGreaterThanToken), body.pos, body.pos), body),
                positioned ? names[0].pos : body.pos, body.end);
            const callee = range(f.createParenthesizedExpression(arrow), arrow.pos, arrow.end);
            // The field reads follow the body, empty, so the call's children stay in source order.
            const reads = range(f.createNodeArray(bound.map(binding => markGenerated(ts, binding.read(body.end), body.end))), body.end, body.end);
            return range(f.createCallExpression(callee, undefined, reads), arrow.pos, body.end);
        };

        let chain: TS.Expression = markGenerated(ts, f.createAsExpression(f.createVoidZero(), f.createKeywordTypeNode(kinds.NeverKeyword)), closeStart);
        const arms: MatchArm[] = [];
        for (let index = parsedArms.length - 1; index >= 0; index--) {
            const arm = parsedArms[index];
            arms.unshift({ patterns: arm.patterns, guarded: !!arm.guard });
            const wildcard = arm.patterns.length === 1 && arm.patterns[0].variant === "_" && !arm.patterns[0].elements.length;
            if (wildcard && !arm.guard) {
                chain = arm.result;
                continue;
            }
            const at = arm.patterns[0].start;
            const tests = arm.patterns
                .filter(pattern => pattern.variant !== "_")
                .map(pattern => condition(pattern, temporary, at));
            let test = markGenerated(ts, tests.length
                ? tests.reduce((left, right) => f.createBinaryExpression(left, f.createToken(kinds.BarBarToken), right))
                : f.createTrue(), at);
            const bound = arm.patterns.length === 1 ? bindings(arm.patterns[0], temporary) : [];
            let resultNames = bound.map(binding => binding.name);
            if (arm.guard) {
                test = markGenerated(ts, and(test, bind(bound, bound.map(binding => binding.name), arm.guard, arm.guardStart), at), at);
                // The pattern's names belong to the guard; the result binds the same fields under fresh names.
                resultNames = bound.map(binding => range(f.createIdentifier(ts.idText(binding.name)), -1, -1));
            }
            const whenTrue = bind(bound, resultNames, arm.result, arm.resultStart);
            chain = range(f.createConditionalExpression(test, range(f.createToken(kinds.QuestionToken), whenTrue.pos, whenTrue.pos), whenTrue,
                range(f.createToken(kinds.ColonToken), whenTrue.end, whenTrue.end), chain),
                arm.start, chain.end > whenTrue.end ? chain.end : whenTrue.end);
        }

        // Otherwise the scrutinee is the default of the dispatch's only parameter, evaluated once before any arm.
        const scrutineeParameter = range(f.createParameterDeclaration(undefined, undefined,
            range(f.createIdentifier(temporaryName), keywordStart, keywordStart + temporaryName.length), undefined, undefined, scrutinee), keywordStart, scrutinee.end);
        const parameters = direct ? range(f.createNodeArray<TS.ParameterDeclaration>([]), scrutinee.pos, scrutinee.pos) : range(f.createNodeArray([scrutineeParameter]), keywordStart, scrutinee.end);
        const arrow = range(f.createArrowFunction(undefined, undefined, parameters, undefined,
            range(f.createToken(kinds.EqualsGreaterThanToken), scrutinee.end, scrutinee.end), chain), pos, end);
        const callee = range(f.createParenthesizedExpression(arrow), pos, end);
        const call = range(f.createCallExpression(callee, undefined, f.createNodeArray<TS.Expression>([])), pos, end);
        if (direct && firstCopy) checkedScrutinee = firstCopy;
        matches.set(call, { scrutinee: checkedScrutinee, arms, start: pos, end, patternRanges: parsedArms.map(arm => ({ start: arm.patterns[0].start, end: arm.patterns[arm.patterns.length - 1].end })) });
        count++;
        return markGenerated(ts, call, closeStart);
    }

    return {
        extension: { position: "expression", startTokens: [kinds.Identifier], keywords: ["match"], isStart, parse },
        matches,
        count: () => count,
    };
}
