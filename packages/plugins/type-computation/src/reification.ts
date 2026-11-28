import { createLoweredArrowToken, replaceChild } from "@tspp/plugin-sdk";
import type {
    TSPPProgramRebuilder,
    TSPPSyntaxCursor,
    TSPPSyntaxExtension,
    TSPPTypeScript,
} from "@tspp/plugin-sdk/compiler";
import type * as TS from "typescript-upstream";

import { fileDeclaredNames } from "./dependent";
import type { TypeSyntaxModel } from "./kinds";

import { reifiedTypeProperty, runtimeShapeOf, runtimeTypeParameterOf, type RuntimeShape } from "./descriptor";

export { reifiedTypeProperty };

/** A lowered `typecase`: the generated call that selects an arm statically, and what each arm was written as. */
export interface LoweredTypecase {
    readonly call: TS.CallExpression;
    readonly dispatch: TS.CallExpression;
    readonly scrutinee: TS.Expression;
    readonly arms: readonly TS.ArrowFunction[];
    /** Each arm's pattern, after its `infer` captures became references, and undefined for `_`. */
    readonly patterns: readonly (TS.TypeNode | undefined)[];
    /** Whether each arm's pattern has `infer` captures, which only a statically selected arm can bind. */
    readonly captures: readonly boolean[];
}

/** A lowered `reify T`: the descriptor object, completed in emit with its run-time shape, and the node of `T`. */
interface LoweredReify {
    readonly object: TS.ObjectLiteralExpression;
    readonly type: TS.TypeNode;
}

export interface Reification {
    readonly reify: TSPPSyntaxExtension;
    readonly reified: TSPPSyntaxExtension;
    readonly typecase: TSPPSyntaxExtension;
    /**
     * Completes each descriptor with its run-time shape, and emits each `typecase`: the arm the checker selected, or,
     * when the described type is a type parameter, a dispatch on the descriptor's shape.
     */
    readonly selection: TSPPProgramRebuilder;
    /** Lowered `typecase` expressions by their call, and by the result expression of each of their arms. */
    readonly typecases: WeakMap<TS.Node, LoweredTypecase>;
    readonly typecaseArms: WeakMap<TS.Node, { readonly typecase: LoweredTypecase; readonly index: number; }>;
    /** Lowered `reify` expressions, by the parenthesized expression they became, with the node of the type. */
    readonly reifies: WeakMap<TS.Node, TS.TypeNode>;
    readonly typecaseCount: () => number;
    readonly reifyCount: () => number;
}

/**
 * Lowers `reify T` and expression-level `typecase` while they are parsed.
 *
 * `reify T` becomes `({ kind: "type", text: "T" } as { kind: "type"; text: string; __tspp_reified_type: T })`: an
 * ordinary serializable object whose static type carries `T` in a phantom property.
 *
 * `typecase d { P1 => r1, Array<infer E> => r2, _ => r0 }` becomes a call whose overloads are the arms:
 *
 * ```ts
 * (<T>(s = d, a0 = (s: { __tspp_reified_type: P1 }) => r1, a1 = <E>(s: { __tspp_reified_type: Array<E> }) => r2,
 *     a2 = (s: unknown) => r0) => (a0 as typeof a0 & typeof a1 & typeof a2 & T)(s))()
 * ```
 *
 * TypeScript's overload resolution selects the first arm whose pattern accepts the descriptor's type, infers the
 * `infer` captures as the arm's type parameters, and types the expression as that arm's result. When the described type
 * is known, selection is static: emit keeps the scrutinee only for its side effects, and the arm the checker resolved.
 * When it is a type parameter, as for a descriptor passed in as `(A: Type)`, the evidence extension (`evidence.ts`)
 * checks each arm under its pattern, and emit tests the descriptor's run-time `shape` against each pattern in turn.
 */
export function createReification(ts: TSPPTypeScript, model: TypeSyntaxModel): Reification {
    const kinds = ts.SyntaxKind;
    const typecases = new WeakMap<TS.Node, LoweredTypecase>();
    const typecaseArms = new WeakMap<TS.Node, { readonly typecase: LoweredTypecase; readonly index: number; }>();
    const reifies = new WeakMap<TS.Node, LoweredReify>();
    const reifiedTypes = new WeakMap<TS.Node, TS.TypeNode>();
    let typecaseCount = 0;
    let reifyCount = 0;
    // Underscored, so the arms may leave it unused; not `__`-prefixed, which escapes differently from its text and so
    // defeats the editor rule that hides parameter name hints matching their argument.
    const scrutineeName = "_tspp_scrutinee";
    // Made now because the parser is one shared instance: parsing a file from inside a plugin's syntax would end the parse.
    const emptyFile = ts.createSourceFile("type.ts", "", ts.ScriptTarget.Latest);
    const range = <T extends TS.Node | TS.NodeArray<TS.Node>>(node: T, pos: number, end = pos): T => ts.setTextRange(node, { pos, end });
    /** A synthesized name, which keeps its text; it must sit under an empty, positioned parent (see `markGenerated` in the SDK). */
    const name = (f: TS.NodeFactory, text: string) => range(f.createIdentifier(text), -1);

    /** `reify` and `typecase` stay ordinary identifiers unless their syntax follows on the same line. */
    const startsTypeOnSameLine = (cursor: TSPPSyntaxCursor) => cursor.lookAhead(() => {
        const token = cursor.nextToken();
        if (cursor.hasPrecedingLineBreak()) return false;
        switch (token) {
            case kinds.InKeyword:
            case kinds.InstanceOfKeyword:
            case kinds.AsKeyword:
            case kinds.SatisfiesKeyword:
                return false;
            case kinds.Identifier:
            case kinds.OpenBraceToken:
            case kinds.OpenBracketToken:
            case kinds.OpenParenToken:
            case kinds.StringLiteral:
            case kinds.NumericLiteral:
            case kinds.BigIntLiteral:
            case kinds.NoSubstitutionTemplateLiteral:
            case kinds.TemplateHead:
            case kinds.MinusToken:
            case kinds.LessThanToken:
                return true;
            default:
                return token >= kinds.FirstKeyword && token <= kinds.LastKeyword;
        }
    });

    function createDescriptorTypeNode(f: TS.NodeFactory, type: TS.TypeNode, start: number, end: number): TS.TypeLiteralNode {
        const empty = <T extends TS.Node>(node: T) => range(node, start);
        return range(f.createTypeLiteralNode(range(f.createNodeArray([
            empty(f.createPropertySignature(undefined, name(f, "kind"), undefined,
                empty(f.createLiteralTypeNode(range(f.createStringLiteral("type"), -1))))),
            empty(f.createPropertySignature(undefined, name(f, "text"), undefined, empty(f.createKeywordTypeNode(kinds.StringKeyword)))),
            // The represented type keeps its source range, so editor services see the authored type.
            range(f.createPropertySignature(undefined, range(f.createIdentifier(reifiedTypeProperty), type.pos), undefined, type), type.pos, type.end),
        ]), start, end)), start, end);
    }

    const reify: TSPPSyntaxExtension = {
        position: "expression",
        startTokens: [kinds.Identifier],
        keywords: ["reify"],
        isStart: cursor => cursor.tokenText() === "reify" && startsTypeOnSameLine(cursor),
        parse(cursor) {
            const f = cursor.factory;
            const pos = cursor.getNodePos();
            const keywordStart = cursor.getTokenStart();
            cursor.nextToken();
            const type = cursor.parseType();
            const end = cursor.getNodePos();
            const text = printType(type);
            // The descriptor and its members are empty; their names and literals are synthesized so they keep their text. The descriptor sits at the end, after its type: out of source order, the
            // assertion tells the formatter that it has no `{` and `}` of its own to lay out, wherever it is written.
            const value = range(f.createObjectLiteralExpression(range(f.createNodeArray([
                range(f.createPropertyAssignment(name(f, "kind"), range(f.createStringLiteral("type"), -1)), end),
                range(f.createPropertyAssignment(name(f, "text"), range(f.createStringLiteral(text), -1)), end),
            ]), end)), end);
            const descriptorType = createDescriptorTypeNode(f, type, keywordStart, end);
            model.descriptorTypes.set(descriptorType, type);
            const assertion = range(f.createAsExpression(value, descriptorType), pos, end);
            const expression = range(f.createParenthesizedExpression(assertion), pos, end);
            reifies.set(expression, { object: value, type });
            reifiedTypes.set(expression, type);
            reifyCount++;
            return expression;
        },
    };

    /**
     * `Reified<T>` is read where TypeScript has just parsed it as a type reference, so it is a type like any other:
     * an operand of `&` or `|`, or the element of an array type. A file that declares its own `Reified` keeps it.
     */
    const reifiedReference = (type: TS.TypeNode | undefined): TS.TypeReferenceNode | undefined => {
        if (!type) return undefined;
        if (ts.isArrayTypeNode(type)) return reifiedReference(type.elementType);
        if (ts.isIndexedAccessTypeNode(type)) return reifiedReference(type.objectType);
        return ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName) && ts.idText(type.typeName) === "Reified" && type.typeArguments
            ? type
            : undefined;
    };
    const reified: TSPPSyntaxExtension = {
        position: "postfix-type",
        // Whatever follows the type; `<` would apply it, which `Reified<T>` never is.
        startTokens: Array.from({ length: kinds.LastToken + 1 }, (_, kind) => kind).filter(kind => kind !== kinds.LessThanToken),
        keywords: ["Reified"],
        isStart: cursor => !!reifiedReference(cursor.precedingType) && !fileDeclaredNames(model, cursor.getSourceText()).has("Reified"),
        parse(cursor) {
            const f = cursor.factory;
            const preceding = cursor.precedingType!;
            const reference = reifiedReference(preceding)!;
            if (reference.typeArguments!.length !== 1) throw new Error("Generic type 'Reified' requires 1 type argument(s).");
            const keywordStart = reference.typeName.end - "Reified".length;
            const descriptorType = createDescriptorTypeNode(f, reference.typeArguments![0], keywordStart, reference.end);
            model.authored.set(descriptorType, keywordStart);
            model.descriptorTypes.set(descriptorType, reference.typeArguments![0]);
            const replaced = range(descriptorType, reference.pos, reference.end);
            const rebuild = (type: TS.TypeNode): TS.TypeNode => {
                if (type === reference) return replaced;
                const rebuilt = ts.isArrayTypeNode(type) ? f.createArrayTypeNode(rebuild(type.elementType))
                    : f.createIndexedAccessTypeNode(rebuild((type as TS.IndexedAccessTypeNode).objectType), (type as TS.IndexedAccessTypeNode).indexType);
                return range(rebuilt, type.pos, type.end);
            };
            return rebuild(preceding);
        },
    };

    /** The authored type's text on one line, for the descriptor's `text`. */
    function printType(type: TS.TypeNode): string {
        try {
            // The type has no parents or source file yet, so the printer reads names and literals from the nodes.
            const printer = ts.createPrinter({ removeComments: true });
            return printer.printNode(ts.EmitHint.Unspecified, type, emptyFile).replace(/\s+/g, " ").trim();
        }
        catch {
            return "unknown";
        }
    }

    // `typecase` needs a scrutinee and its arms' `{` on the same line.
    const isTypecaseStart = (cursor: TSPPSyntaxCursor) => cursor.tokenText() === "typecase" && cursor.lookAhead(() => {
        cursor.nextToken();
        if (cursor.hasPrecedingLineBreak()) return false;
        cursor.parseAssignmentExpression();
        return cursor.token() === kinds.OpenBraceToken && !cursor.hasPrecedingLineBreak();
    });

    interface ParsedArm {
        readonly pos: number;
        readonly start: number;
        readonly pattern: TS.TypeNode | undefined;
        readonly arrowStart: number;
        readonly result: TS.Expression;
    }

    function parseTypecase(cursor: TSPPSyntaxCursor): TS.Expression {
        const f = cursor.factory;
        const pos = cursor.getNodePos();
        const keywordStart = cursor.getTokenStart();
        cursor.nextToken();
        const scrutinee = cursor.parseAssignmentExpression();
        cursor.parseExpected(kinds.OpenBraceToken);
        const parsed: ParsedArm[] = [];
        while (cursor.token() !== kinds.CloseBraceToken && cursor.token() !== kinds.EndOfFileToken) {
            const armPos = cursor.getNodePos();
            const start = cursor.getTokenStart();
            let pattern: TS.TypeNode | undefined;
            if (cursor.tokenText() === "_") cursor.nextToken();
            else pattern = cursor.parseType();
            const arrowStart = cursor.getTokenStart();
            cursor.parseExpected(kinds.EqualsGreaterThanToken);
            const result = cursor.parseAssignmentExpression();
            parsed.push({ pos: armPos, start, pattern, arrowStart, result });
            if (cursor.token() === kinds.CommaToken || cursor.token() === kinds.SemicolonToken) cursor.nextToken();
            else break;
        }
        const closeStart = cursor.getTokenStart();
        cursor.parseExpected(kinds.CloseBraceToken);
        const end = cursor.getNodePos();
        if (!parsed.length || parsed[parsed.length - 1].pattern) throw new Error("A typecase expression must end with an '_' arm.");
        if (parsed.slice(0, -1).some(arm => !arm.pattern)) throw new Error("The '_' arm must be the last arm of a typecase expression.");

        // Declarations take empty names at their own start, which bind without resolving; references to them are
        // synthesized under the dispatch at the closing brace.
        const armName = (index: number) => `__tspp_arm${index}`;
        const scrutineeParameter = range(f.createParameterDeclaration(undefined, undefined, range(f.createIdentifier(scrutineeName), scrutinee.pos),
            undefined, undefined, scrutinee), scrutinee.pos, scrutinee.end);
        const patterns: (TS.TypeNode | undefined)[] = [];
        const captures: boolean[] = [];
        const arms = parsed.map(arm => {
            const arrow = createArm(f, arm);
            const pattern = arrow.parameters[0].type;
            patterns.push(pattern && ts.isTypeLiteralNode(pattern) ? (pattern.members[0] as TS.PropertySignature).type : undefined);
            captures.push(!!arrow.typeParameters?.length);
            return arrow;
        });
        // A type parameter keeps editors from hinting the generated parameters' types: they hint only functions whose
        // parameters are context sensitive, which a generic function's are not. It joins the overloads as `unknown`.
        const overloadsName = "__tspp_overloads";
        const typeParameters = range(f.createNodeArray([range(f.createTypeParameterDeclaration(undefined, name(f, overloadsName)), keywordStart)]), keywordStart);
        const armParameters = arms.map((arrow, index) =>
            range(f.createParameterDeclaration(undefined, undefined, range(f.createIdentifier(armName(index)), arrow.pos), undefined, undefined, arrow), arrow.pos, arrow.end));
        const parameters = range(f.createNodeArray([scrutineeParameter, ...armParameters]), scrutinee.pos, arms[arms.length - 1].end);

        const at = <T extends TS.Node>(node: T) => range(node, closeStart);
        const armQuery = (index: number) => at(f.createTypeQueryNode(name(f, armName(index))));
        const overloads = at(f.createIntersectionTypeNode(range(f.createNodeArray([
            ...arms.map((_, index) => armQuery(index)),
            at(f.createTypeReferenceNode(name(f, overloadsName))),
        ]), closeStart)));
        const callee = at(f.createParenthesizedExpression(at(f.createAsExpression(name(f, armName(0)), overloads))));
        // An empty body would read as missing, as for an overload, so the dispatch covers the closing brace.
        const dispatch = range(f.createCallExpression(callee, undefined, range(f.createNodeArray([name(f, scrutineeName)]), closeStart)), closeStart, closeStart + 1);
        // The checker reads the line of `=>`, so it needs a real, if empty, position.
        const arrow = range(f.createArrowFunction(undefined, typeParameters, parameters, undefined, at(f.createToken(kinds.EqualsGreaterThanToken)), dispatch), pos, end);
        const call = range(f.createCallExpression(range(f.createParenthesizedExpression(arrow), pos, end), undefined, range(f.createNodeArray<TS.Expression>([]), end)), pos, end);
        const lowered: LoweredTypecase = { call, dispatch, scrutinee, arms, patterns, captures };
        typecases.set(call, lowered);
        parsed.forEach((arm, index) => typecaseArms.set(arm.result, { typecase: lowered, index }));
        typecaseCount++;
        return call;
    }

    /**
     * `(s: { __tspp_reified_type: Pattern }) => result`, generic in the pattern's `infer` captures, or `(s: unknown) =>
     * result`. The parameter shares the scrutinee's name, so editors do not hint it at the generated call.
     */
    function createArm(f: TS.NodeFactory, arm: ParsedArm): TS.ArrowFunction {
        const captures = new Map<string, TS.TypeParameterDeclaration>();
        let parameter: TS.ParameterDeclaration;
        if (arm.pattern) {
            const pattern = replaceCaptures(f, arm.pattern, captures);
            const member = range(f.createPropertySignature(undefined, range(f.createIdentifier(reifiedTypeProperty), pattern.pos), undefined, pattern), pattern.pos, pattern.end);
            const type = range(f.createTypeLiteralNode(range(f.createNodeArray([member]), pattern.pos, pattern.end)), pattern.pos, pattern.end);
            parameter = range(f.createParameterDeclaration(undefined, undefined, range(f.createIdentifier(scrutineeName), pattern.pos), undefined, type), pattern.pos, pattern.end);
        }
        else {
            const wildcardEnd = arm.start + 1;
            parameter = range(f.createParameterDeclaration(undefined, undefined, range(f.createIdentifier(scrutineeName), arm.start), undefined,
                range(f.createKeywordTypeNode(kinds.UnknownKeyword), wildcardEnd)), arm.pos, wildcardEnd);
        }
        const declarations = [...captures.values()];
        const typeParameters = declarations.length ? range(f.createNodeArray(declarations), declarations[0].pos, declarations[declarations.length - 1].end) : undefined;
        return range(f.createArrowFunction(undefined, typeParameters, range(f.createNodeArray([parameter]), parameter.pos, parameter.end), undefined,
            createLoweredArrowToken(ts, f, arm.arrowStart), arm.result), arm.pos, arm.result.end);
    }

    /**
     * Replaces each `infer X` of a pattern by a reference to `X`, whose authored declaration becomes a type parameter
     * of the arm, so hovers, references, and renames find the name where it is written. The reference is empty at the
     * `infer` and synthesized.
     */
    function replaceCaptures(f: TS.NodeFactory, pattern: TS.TypeNode, captures: Map<string, TS.TypeParameterDeclaration>): TS.TypeNode {
        const capture = (node: TS.InferTypeNode): TS.TypeNode => {
            const text = ts.idText(node.typeParameter.name);
            if (!captures.has(text)) captures.set(text, node.typeParameter);
            return range(f.createTypeReferenceNode(name(f, text), undefined), node.pos);
        };
        if (ts.isInferTypeNode(pattern)) return capture(pattern);
        const visit = (node: TS.Node): void => {
            ts.forEachChild(node, child => {
                if (ts.isInferTypeNode(child)) replaceChild(node, child, capture(child));
                else visit(child);
            });
        };
        visit(pattern);
        return pattern;
    }

    const selection: TSPPProgramRebuilder = {
        id: "typecase-selection",
        rebuild(program) {
            if (!typecaseCount && !reifyCount) return undefined;
            let target = program;
            const findTransformed = (root: TS.Node, parsed: TS.Node): TS.Expression | undefined =>
                ts.forEachChild(root, child => ts.getOriginalNode(child) === parsed ? child as TS.Expression : findTransformed(child, parsed));
            const select: TS.TransformerFactory<TS.SourceFile> = context => sourceFile => {
                const checker = target.getTypeChecker();
                const f = context.factory;
                const visit = (node: TS.Node): TS.Node => {
                    const original = ts.getOriginalNode(node);
                    const reified = reifies.get(original);
                    if (reified) return completeDescriptor(f, reified, checker);
                    const lowered = typecases.get(original);
                    if (!lowered) return ts.visitEachChild(node, visit, context);
                    // Another plugin's transformer may have run first, so the parts are found in `node`, as that one left them.
                    const part = (parsed: TS.Expression) => ts.visitNode(findTransformed(node, parsed) ?? parsed, visit, ts.isExpression) as TS.Expression;
                    const scrutinee = part(lowered.scrutinee);
                    const parameter = runtimeTypeParameterOf(ts, checker.getTypeAtLocation(lowered.scrutinee));
                    if (parameter) return dispatchOnShape(f, context, lowered, scrutinee, part, checker);
                    const declaration = checker.getResolvedSignature(lowered.dispatch)?.declaration;
                    const selected = lowered.arms.find(candidate => candidate === declaration) ?? lowered.arms[lowered.arms.length - 1];
                    const body = part(selected.body as TS.Expression);
                    // The scrutinee is evaluated once, before the arm, even when the arm does not depend on it at run time.
                    return isFreeOfEffects(lowered.scrutinee) ? body : f.createParenthesizedExpression(f.createCommaListExpression([scrutinee, body]));
                };
                return ts.visitEachChild(sourceFile, visit, context);
            };
            // No statement is replaced, so the host keeps the program and only adds the transformer.
            return {
                replacements: new Map(),
                transformers: { before: [select] },
                onRebuilt: rebuilt => {
                    target = rebuilt;
                },
            };
        },
    };

    /** `{ kind: "type", text: "T", shape: [...] }`: the descriptor with its run-time shape, which emit can compute. */
    function completeDescriptor(f: TS.NodeFactory, reified: LoweredReify, checker: TS.TypeChecker): TS.Expression {
        const text = reified.object.properties
            .map(property => ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && ts.idText(property.name) === "text" && ts.isStringLiteral(property.initializer) ? property.initializer.text : undefined)
            .find(value => value !== undefined) ?? "unknown";
        return f.createObjectLiteralExpression([
            f.createPropertyAssignment("kind", f.createStringLiteral("type")),
            f.createPropertyAssignment("text", f.createStringLiteral(text)),
            f.createPropertyAssignment("shape", shapeExpression(f, runtimeShapeOf(ts, checker.getTypeFromTypeNode(reified.type)))),
        ]);
    }

    function shapeExpression(f: TS.NodeFactory, shape: RuntimeShape): TS.Expression {
        if (shape === undefined) return f.createNull();
        if (shape === "any") return f.createStringLiteral("any");
        return f.createArrayLiteralExpression(shape.map(atom => f.createStringLiteral(atom)));
    }

    /**
     * `(d = scrutinee, m = matcher, m(d.shape, P0) ? r0 : m(d.shape, P1) ? r1 : r_)`, with `d` and `m` hoisted: the
     * descriptor is read once, the arms are tried in source order, and only the first that matches runs. A shape is
     * the list of atoms a type is the union of (`"number"`, `"string:a"`), `"any"`, or null for a type no pattern
     * matches; a pattern matches when it covers every atom of the shape.
     */
    function dispatchOnShape(
        f: TS.NodeFactory,
        context: TS.TransformationContext,
        lowered: LoweredTypecase,
        scrutinee: TS.Expression,
        part: (parsed: TS.Expression) => TS.Expression,
        checker: TS.TypeChecker,
    ): TS.Expression {
        const descriptor = f.createUniqueName("_tspp_descriptor");
        const matches = f.createUniqueName("_tspp_matches");
        context.hoistVariableDeclaration(descriptor);
        context.hoistVariableDeclaration(matches);
        const last = lowered.arms.length - 1;
        let chain = part(lowered.arms[last].body as TS.Expression);
        for (let index = last - 1; index >= 0; index--) {
            const pattern = lowered.patterns[index];
            const shape = pattern ? runtimeShapeOf(ts, checker.getTypeFromTypeNode(pattern)) : undefined;
            const test = Array.isArray(shape)
                ? f.createCallExpression(matches, undefined, [f.createPropertyAccessExpression(descriptor, "shape"), shapeExpression(f, shape)])
                : f.createFalse();
            chain = f.createConditionalExpression(test, f.createToken(kinds.QuestionToken), part(lowered.arms[index].body as TS.Expression), f.createToken(kinds.ColonToken), chain);
        }
        const assign = (name: TS.Identifier, value: TS.Expression) => f.createAssignment(name, value);
        return f.createParenthesizedExpression(f.createCommaListExpression([assign(descriptor, scrutinee), assign(matches, createMatcher(f)), chain]));
    }

    /** `(d, p) => d === "any" || Array.isArray(d) && d.every(a => p.some(q => q === a || q.indexOf(":") < 0 && a.indexOf(q + ":") === 0))` */
    function createMatcher(f: TS.NodeFactory): TS.Expression {
        const id = (text: string) => f.createIdentifier(text);
        const parameter = (text: string) => f.createParameterDeclaration(undefined, undefined, text);
        const arrow = (names: readonly string[], body: TS.Expression) => f.createArrowFunction(undefined, undefined, names.map(parameter), undefined, f.createToken(kinds.EqualsGreaterThanToken), body);
        const call = (target: TS.Expression, method: string, args: readonly TS.Expression[]) => f.createCallExpression(f.createPropertyAccessExpression(target, method), undefined, args);
        const binary = (left: TS.Expression, operator: TS.BinaryOperator, right: TS.Expression) => f.createBinaryExpression(left, operator, right);
        // A primitive atom `number` covers its literals `number:1`; a literal atom covers only itself.
        const covers = binary(
            binary(id("q"), kinds.EqualsEqualsEqualsToken, id("a")),
            kinds.BarBarToken,
            binary(
                binary(call(id("q"), "indexOf", [f.createStringLiteral(":")]), kinds.LessThanToken, f.createNumericLiteral(0)),
                kinds.AmpersandAmpersandToken,
                binary(call(id("a"), "indexOf", [binary(id("q"), kinds.PlusToken, f.createStringLiteral(":"))]), kinds.EqualsEqualsEqualsToken, f.createNumericLiteral(0)),
            ),
        );
        const every = call(id("d"), "every", [arrow(["a"], call(id("p"), "some", [arrow(["q"], covers)]))]);
        const body = binary(
            binary(id("d"), kinds.EqualsEqualsEqualsToken, f.createStringLiteral("any")),
            kinds.BarBarToken,
            binary(call(id("Array"), "isArray", [id("d")]), kinds.AmpersandAmpersandToken, every),
        );
        return f.createParenthesizedExpression(arrow(["d", "p"], body));
    }

    /** Whether evaluating an expression can have no effect, so that a statically selected `typecase` may drop it. */
    function isFreeOfEffects(expression: TS.Expression): boolean {
        if (reifies.has(expression)) return true;
        if (ts.isParenthesizedExpression(expression)) return isFreeOfEffects(expression.expression);
        if (ts.isIdentifier(expression) || expression.kind === kinds.ThisKeyword || ts.isLiteralExpression(expression)) return true;
        if (ts.isElementAccessExpression(expression)) return ts.isLiteralExpression(expression.argumentExpression) && isFreeOfEffects(expression.expression);
        return ts.isPropertyAccessExpression(expression) && isFreeOfEffects(expression.expression);
    }

    return {
        reify,
        reified,
        typecase: { position: "expression", startTokens: [kinds.Identifier], keywords: ["typecase"], isStart: isTypecaseStart, parse: parseTypecase },
        selection,
        typecases,
        typecaseArms,
        reifies: reifiedTypes,
        typecaseCount: () => typecaseCount,
        reifyCount: () => reifyCount,
    };
}
