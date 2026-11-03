import type { TSPPSyntaxCursor, TSPPSyntaxExtension, TSPPTypeScript } from "@tspp/plugin-sdk/compiler";
import type * as TS from "typescript-upstream";

const placeholder = "_";

type GenerateName = (node: TS.Node, flags: TS.GeneratedIdentifierFlags, prefix: string, suffix: string) => TS.Identifier;

interface Hole {
    readonly identifier: TS.Identifier;
    /**
     * The node whose property or list holds the placeholder, so that the reference to its parameter can take its
     * place; undefined when the placeholder is the whole expression.
     */
    readonly parent: TS.Node | undefined;
}

/**
 * Desugars `(_ + 1)` and `f(_ * 2)` while parsing: a parenthesized expression or a call argument with placeholders
 * becomes an arrow function with one parameter per placeholder, left to right. The parameters and the references
 * that replace the placeholders keep the placeholders' source positions, so that hover and diagnostics point at the
 * `_` the author wrote, and they are generated names, so that JavaScript output gives each one its own name.
 */
export function createOperatorSectionSyntax(ts: TSPPTypeScript): readonly TSPPSyntaxExtension[] {
    const kinds = ts.SyntaxKind;
    // Functions, classes, and bindings introduce their own scope or name, so a `_` inside them is not a hole here.
    const opaqueKinds = new Set<TS.SyntaxKind>([
        kinds.ArrowFunction,
        kinds.FunctionExpression,
        kinds.FunctionDeclaration,
        kinds.ClassExpression,
        kinds.ClassDeclaration,
        kinds.MethodDeclaration,
        kinds.GetAccessor,
        kinds.SetAccessor,
        kinds.PropertyAssignment,
        kinds.ShorthandPropertyAssignment,
        kinds.Parameter,
        kinds.BindingElement,
        // A nested parenthesized expression or call argument is a section of its own when it has holes.
        kinds.ParenthesizedExpression,
    ]);
    // While a section looks ahead for its holes, nested parentheses and arguments are parsed as written: their holes are
    // their own either way, and deciding them again for every enclosing section would take exponential time.
    let probing = false;

    /** A function some plugin's syntax lowered to: its `=>` has no source text, so the author wrote no scope here. */
    function isLoweredFunction(node: TS.Node): node is TS.ArrowFunction {
        return ts.isArrowFunction(node) && node.equalsGreaterThanToken.pos === node.equalsGreaterThanToken.end;
    }

    function collectHoles(node: TS.Node, parent: TS.Node | undefined, holes: Hole[]): void {
        // `idText`, not `.text`: identifiers from the bare compiler (`tsc`) have no `text` accessor.
        if (ts.isIdentifier(node) && ts.idText(node) === placeholder) {
            holes.push({ identifier: node, parent });
            return;
        }
        if (ts.isParenthesizedExpression(node) && isLoweredFunction(node.expression)) return collectHoles(node.expression, node, holes);
        if (isLoweredFunction(node)) {
            for (const parameter of node.parameters) {
                if (parameter.initializer) collectHoles(parameter.initializer, parameter, holes);
            }
            return collectHoles(node.body, node, holes);
        }
        // Reached only through a lowered function: `let x = _ in x` declares `x`, and `_` is the value it starts with.
        if (ts.isVariableDeclaration(node)) {
            if (node.initializer) collectHoles(node.initializer, node, holes);
            return;
        }
        if (opaqueKinds.has(node.kind)) return;
        // Only the object of `_.name` can be a hole; the property name is not a reference.
        if (ts.isPropertyAccessExpression(node)) return collectHoles(node.expression, node, holes);
        if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
            collectHoles(node.expression, node, holes);
            node.typeArguments?.forEach(argument => collectHoles(argument, node, holes));
            return;
        }
        ts.forEachChild(node, child => collectHoles(child, node, holes));
    }

    function holesOf(expression: TS.Expression): Hole[] {
        const holes: Hole[] = [];
        collectHoles(expression, /*parent*/ undefined, holes);
        return holes;
    }

    /**
     * Whether a placeholder may appear before the parenthesized expression or argument at the cursor ends, by its
     * tokens; a regular expression or template literal may hide the end, so it counts as a maybe.
     */
    function mayContainPlaceholder(cursor: TSPPSyntaxCursor, parenthesized: boolean): boolean {
        return cursor.lookAhead(() => {
            let depth = 0;
            for (let token = cursor.token(); token !== kinds.EndOfFileToken; token = cursor.nextToken()) {
                switch (token) {
                    case kinds.Identifier:
                        if (cursor.tokenText() === placeholder) return true;
                        break;
                    case kinds.SlashToken:
                    case kinds.SlashEqualsToken:
                    case kinds.TemplateHead:
                        return true;
                    case kinds.OpenParenToken:
                    case kinds.OpenBracketToken:
                    case kinds.OpenBraceToken:
                        depth++;
                        break;
                    case kinds.CloseParenToken:
                    case kinds.CloseBracketToken:
                    case kinds.CloseBraceToken:
                        if (--depth <= 0 && (parenthesized || depth < 0)) return false;
                        break;
                    case kinds.CommaToken:
                        if (!parenthesized && depth === 0) return false;
                        break;
                }
            }
            return false;
        });
    }

    function probe(cursor: TSPPSyntaxCursor, parse: () => TS.Expression | undefined): boolean {
        probing = true;
        try {
            return cursor.lookAhead(() => {
                const expression = parse();
                return !!expression && holesOf(expression).length > 0;
            });
        }
        finally {
            probing = false;
        }
    }

    function parseParenthesizedContents(cursor: TSPPSyntaxCursor): TS.Expression {
        cursor.parseExpected(kinds.OpenParenToken);
        const expression = cursor.parseExpression();
        cursor.parseExpected(kinds.CloseParenToken);
        return expression;
    }

    function replace(parent: TS.Node, from: TS.Node, to: TS.Node): void {
        const slots = parent as unknown as Record<string, unknown>;
        for (const key of Object.keys(slots)) {
            const value = slots[key];
            if (value === from) slots[key] = to;
            else if (Array.isArray(value) && value.includes(from)) (value as TS.Node[])[value.indexOf(from)] = to;
        }
    }

    function createSection(cursor: TSPPSyntaxCursor, expression: TS.Expression, holes: readonly Hole[], pos: number, end: number): TS.Expression {
        const factory = cursor.factory;
        let body = expression;
        const parameters = holes.map(({ identifier, parent }, index) => {
            const name = () => {
                // The internal overload takes a prefix and suffix. A generated name cannot be created as a parse tree
                // node before its file exists, so it is created synthesized and then made part of the parse tree.
                const generated = (ts.factory.getGeneratedNameForNode as unknown as GenerateName)(identifier, ts.GeneratedIdentifierFlags.Optimistic, "__p", String(index));
                (generated as { flags: TS.NodeFlags; }).flags &= ~ts.NodeFlags.Synthesized;
                return ts.setTextRange(generated, identifier);
            };
            if (parent) replace(parent, identifier, name());
            else body = name();
            return ts.setTextRange(
                factory.createParameterDeclaration(/*modifiers*/ undefined, /*dotDotDotToken*/ undefined, name()),
                identifier,
            );
        });
        const arrow = ts.setTextRange(
            factory.createArrowFunction(
                /*modifiers*/ undefined,
                /*typeParameters*/ undefined,
                ts.setTextRange(factory.createNodeArray(parameters), { pos, end: pos }),
                /*type*/ undefined,
                ts.setTextRange(factory.createToken(kinds.EqualsGreaterThanToken), { pos, end: pos }),
                body,
            ),
            { pos, end },
        );
        return ts.setTextRange(factory.createParenthesizedExpression(arrow), { pos, end });
    }

    const parenthesized: TSPPSyntaxExtension = {
        position: "primary-expression",
        startTokens: [kinds.OpenParenToken],
        keywords: ["_"],
        isStart: cursor => !probing && mayContainPlaceholder(cursor, /*parenthesized*/ true) && probe(cursor, () => parseParenthesizedContents(cursor)),
        parse: cursor => {
            const pos = cursor.getNodePos();
            const expression = parseParenthesizedContents(cursor);
            const end = cursor.getNodePos();
            const holes = holesOf(expression);
            return holes.length ? createSection(cursor, expression, holes, pos, end) : cursor.finishNode(cursor.factory.createParenthesizedExpression(expression), pos);
        },
    };

    const argument: TSPPSyntaxExtension = {
        position: "argument",
        keywords: ["_"],
        startTokens: Object.values(kinds).filter((kind): kind is TS.SyntaxKind => typeof kind === "number" && kind !== kinds.DotDotDotToken && kind !== kinds.CommaToken),
        isStart: cursor => !probing && mayContainPlaceholder(cursor, /*parenthesized*/ false) && probe(cursor, () => cursor.parseAssignmentExpression()),
        parse: cursor => {
            const pos = cursor.getNodePos();
            const expression = cursor.parseAssignmentExpression();
            const holes = holesOf(expression);
            return holes.length ? createSection(cursor, expression, holes, pos, cursor.getNodePos()) : expression;
        },
    };

    return [parenthesized, argument];
}
