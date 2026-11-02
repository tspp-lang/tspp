import type {
    TSPPProgramRebuilder,
    TSPPSyntaxCursor,
    TSPPSyntaxExtension,
    TSPPTypeScript,
} from "@tspp/plugin-sdk/compiler";
import type * as TS from "typescript-upstream";

/** The phantom property through which a descriptor's static type carries the type it describes. */
export const reifiedTypeProperty = "__tspp_reified_type";

/** What emit needs from a lowered `typecase`: the generated call that selects an arm, and the arms in order. */
interface LoweredTypecase {
    readonly dispatch: TS.CallExpression;
    readonly arms: readonly TS.ArrowFunction[];
}

export interface Reification {
    readonly reify: TSPPSyntaxExtension;
    readonly typecase: TSPPSyntaxExtension;
    /** Emits only the arm the checker selected for each `typecase`. */
    readonly selection: TSPPProgramRebuilder;
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
 * `infer` captures as the arm's type parameters, and types the expression as that arm's result. Selection is static:
 * JavaScript emit replaces the whole expression by the result of the arm the checker resolved, so neither the
 * scrutinee nor the other arms run.
 */
export function createReification(ts: TSPPTypeScript): Reification {
    const kinds = ts.SyntaxKind;
    const typecases = new WeakMap<TS.Node, LoweredTypecase>();
    let typecaseCount = 0;
    // Underscored, so the arms may leave it unused; not `__`-prefixed, which escapes differently from its text and so
    // defeats the editor rule that hides parameter name hints matching their argument.
    const scrutineeName = "_tspp_scrutinee";
    const range = <T extends TS.Node | TS.NodeArray<TS.Node>>(node: T, pos: number, end = pos): T => ts.setTextRange(node, { pos, end });
    /** A synthesized name, which keeps its text; it must sit under an empty, positioned parent (see `markGenerated` in nominal-types). */
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
            // The descriptor and the descriptor type's own members are empty at the keyword; their names and
            // literals are synthesized so they keep their text.
            const empty = <T extends TS.Node>(node: T) => range(node, keywordStart);
            const value = empty(f.createObjectLiteralExpression(range(f.createNodeArray([
                empty(f.createPropertyAssignment(name(f, "kind"), range(f.createStringLiteral("type"), -1))),
                empty(f.createPropertyAssignment(name(f, "text"), range(f.createStringLiteral(text), -1))),
            ]), keywordStart)));
            const descriptorType = range(f.createTypeLiteralNode(range(f.createNodeArray([
                empty(f.createPropertySignature(undefined, name(f, "kind"), undefined,
                    empty(f.createLiteralTypeNode(range(f.createStringLiteral("type"), -1))))),
                empty(f.createPropertySignature(undefined, name(f, "text"), undefined, empty(f.createKeywordTypeNode(kinds.StringKeyword)))),
                // The represented type keeps its source range, so editor services see the authored type.
                range(f.createPropertySignature(undefined, range(f.createIdentifier(reifiedTypeProperty), type.pos), undefined, type), type.pos, type.end),
            ]), keywordStart, end)), keywordStart, end);
            const assertion = range(f.createAsExpression(value, descriptorType), pos, end);
            return range(f.createParenthesizedExpression(assertion), pos, end);
        },
    };

    /** The authored type's text on one line, for the descriptor's `text`. */
    function printType(type: TS.TypeNode): string {
        try {
            // The type has no parents or source file yet, so the printer reads names and literals from the nodes.
            const printer = ts.createPrinter({ removeComments: true });
            return printer.printNode(ts.EmitHint.Unspecified, type, undefined as unknown as TS.SourceFile).replace(/\s+/g, " ").trim();
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
        const arms = parsed.map(arm => createArm(f, arm));
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
        typecases.set(call, { dispatch, arms });
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
            range(f.createToken(kinds.EqualsGreaterThanToken), arm.arrowStart, arm.arrowStart + 2), arm.result), arm.pos, arm.result.end);
    }

    /**
     * Replaces each `infer X` of a pattern by a reference to `X`, whose authored declaration becomes a type parameter
     * of the arm, so hovers, references, and renames find the name where it is written. The reference is empty at the
     * `infer` and synthesized.
     */
    function replaceCaptures(f: TS.NodeFactory, pattern: TS.TypeNode, captures: Map<string, TS.TypeParameterDeclaration>): TS.TypeNode {
        // Visiting type nodes only reads the context's factory; the parser's own keeps the copies parse-tree nodes.
        const context = { factory: f } as unknown as TS.TransformationContext;
        const visit = (node: TS.Node): TS.Node => {
            if (ts.isInferTypeNode(node)) {
                const captured = node.typeParameter.name;
                const text = ts.idText(captured);
                if (!captures.has(text)) captures.set(text, node.typeParameter);
                return range(f.createTypeReferenceNode(name(f, text), undefined), node.pos);
            }
            return ts.visitEachChild(node, visit, context);
        };
        return visit(pattern) as TS.TypeNode;
    }

    const selection: TSPPProgramRebuilder = {
        id: "typecase-selection",
        rebuild(program) {
            if (!typecaseCount) return undefined;
            let target = program;
            const select: TS.TransformerFactory<TS.SourceFile> = context => sourceFile => {
                const checker = target.getTypeChecker();
                const visit = (node: TS.Node): TS.Node => {
                    const lowered = typecases.get(node);
                    if (!lowered) return ts.visitEachChild(node, visit, context);
                    const declaration = checker.getResolvedSignature(lowered.dispatch)?.declaration;
                    const arm = lowered.arms.find(candidate => candidate === declaration) ?? lowered.arms[lowered.arms.length - 1];
                    return ts.visitNode(arm.body as TS.Expression, visit, ts.isExpression) as TS.Expression;
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

    return {
        reify,
        typecase: { position: "expression", startTokens: [kinds.Identifier], keywords: ["typecase"], isStart: isTypecaseStart, parse: parseTypecase },
        selection,
    };
}
