import { markGenerated } from "@tspp/plugin-sdk";
import type { TSPPSyntaxCursor, TSPPTypeScript } from "@tspp/plugin-sdk/compiler";
import type * as TS from "typescript-upstream";

/** The property of a suspending effect's interface whose type is what a handler of it must be. */
export const handlerProperty = "__tspp_handler";

export interface OperationList {
    readonly members: TS.NodeArray<TS.TypeElement>;
    /** The names of the operations marked `suspend`. */
    readonly suspending: ReadonlySet<string>;
}

interface Helpers {
    readonly parseAnyName: (cursor: TSPPSyntaxCursor) => TS.Identifier;
    readonly isWordFollowedByName: (cursor: TSPPSyntaxCursor, word: string) => boolean;
    readonly report: (cursor: TSPPSyntaxCursor, start: number, end: number, message: string) => void;
}

/** Parses the operations of an effect, which may be marked `suspend`, and the parameter lists they and handlers share. */
export function createOperationParser(ts: TSPPTypeScript, helpers: Helpers) {
    const kinds = ts.SyntaxKind;
    const range = <T extends TS.Node | TS.NodeArray<TS.Node>>(node: T, pos: number, end: number): T => ts.setTextRange(node, { pos, end });

    /** `(a: A, b?: B, ...rest: C[])`, from the `(`. */
    const parseParameters = (cursor: TSPPSyntaxCursor): TS.NodeArray<TS.ParameterDeclaration> => {
        const f = cursor.factory;
        const parametersPos = cursor.getNodePos();
        cursor.parseExpected(kinds.OpenParenToken);
        const parameters: TS.ParameterDeclaration[] = [];
        while (cursor.token() !== kinds.CloseParenToken && cursor.token() !== kinds.EndOfFileToken) {
            const parameterPos = cursor.getNodePos();
            const rest = cursor.token() === kinds.DotDotDotToken ? f.createToken(kinds.DotDotDotToken) : undefined;
            if (rest) {
                cursor.finishNode(rest, parameterPos);
                cursor.nextToken();
            }
            const binding = cursor.parseBindingName();
            const question = cursor.token() === kinds.QuestionToken ? f.createToken(kinds.QuestionToken) : undefined;
            if (question) {
                cursor.finishNode(question, cursor.getNodePos());
                cursor.nextToken();
            }
            const type = cursor.parseTypeAnnotation();
            const initializer = cursor.parseOptional(kinds.EqualsToken) ? cursor.parseAssignmentExpression() : undefined;
            parameters.push(cursor.finishNode(f.createParameterDeclaration(undefined, rest, binding, question, type, initializer), parameterPos));
            if (!cursor.parseOptional(kinds.CommaToken)) break;
        }
        const list = range(f.createNodeArray(parameters), parametersPos, cursor.getNodePos());
        cursor.parseExpected(kinds.CloseParenToken);
        return list;
    };

    /** `{ name(...): T; suspend other<U>(...): U; }`, from the `{`, through the `}`. */
    const parseOperations = (cursor: TSPPSyntaxCursor): OperationList => {
        const f = cursor.factory;
        cursor.parseExpected(kinds.OpenBraceToken);
        const membersPos = cursor.getNodePos();
        const members: TS.TypeElement[] = [];
        const suspending = new Set<string>();
        while (cursor.token() !== kinds.CloseBraceToken && cursor.token() !== kinds.EndOfFileToken) {
            const pos = cursor.getNodePos();
            const start = cursor.getTokenStart();
            const suspend = helpers.isWordFollowedByName(cursor, "suspend");
            if (suspend) cursor.nextToken();
            const name = helpers.parseAnyName(cursor);
            const question = cursor.token() === kinds.QuestionToken ? f.createToken(kinds.QuestionToken) : undefined;
            if (question) {
                cursor.finishNode(question, cursor.getNodePos());
                cursor.nextToken();
            }
            if (cursor.token() !== kinds.OpenParenToken && cursor.token() !== kinds.LessThanToken) {
                helpers.report(cursor, start, cursor.getTokenStart(), "An effect may only declare operations, written as methods.");
                cursor.parseTypeAnnotation();
            }
            else {
                const typeParameters = cursor.parseTypeParameters();
                const parameters = parseParameters(cursor);
                if (cursor.token() === kinds.SlashToken) {
                    const clauseStart = cursor.getTokenStart();
                    cursor.parseClause("function-clause");
                    helpers.report(cursor, clauseStart, cursor.getTokenStart(), "An operation cannot require effects: its handler runs with those around the 'handle'.");
                }
                const type = cursor.parseTypeAnnotation();
                members.push(cursor.finishNode(f.createMethodSignature(undefined, name, question, typeParameters, parameters, type), pos));
                if (suspend) suspending.add(ts.idText(name));
            }
            if (!cursor.parseOptional(kinds.SemicolonToken)) cursor.parseOptional(kinds.CommaToken);
            if (cursor.getNodePos() === pos) cursor.nextToken();
        }
        const list = range(f.createNodeArray(members), membersPos, cursor.getNodePos());
        cursor.parseExpected(kinds.CloseBraceToken);
        return { members: list, suspending };
    };

    /**
     * What a handler of an effect with suspending operations must be: each operation as declared, except that a suspending
     * one also takes `k`, its continuation, and returns nothing. `operations` is a copy of its own the result may hold.
     */
    const handlerMember = (f: TS.NodeFactory, operations: OperationList, anchor: number): TS.PropertySignature => {
        const methods = operations.members.filter(ts.isMethodSignature).map(member => {
            if (!operations.suspending.has(ts.idText(member.name as TS.Identifier))) return member;
            const resumed = member.type ?? f.createKeywordTypeNode(kinds.UnknownKeyword);
            const continuation = f.createTypeLiteralNode([
                f.createMethodSignature(undefined, "resume", undefined, undefined, [f.createParameterDeclaration(undefined, undefined, "value", undefined, resumed)], f.createKeywordTypeNode(kinds.VoidKeyword)),
                f.createMethodSignature(undefined, "abort", undefined, undefined, [f.createParameterDeclaration(undefined, undefined, "error", undefined, f.createKeywordTypeNode(kinds.UnknownKeyword))], f.createKeywordTypeNode(kinds.VoidKeyword)),
            ]);
            const k = f.createParameterDeclaration(undefined, undefined, "k", undefined, continuation);
            return f.createMethodSignature(undefined, member.name, member.questionToken, member.typeParameters, f.createNodeArray([...member.parameters, k]), f.createKeywordTypeNode(kinds.VoidKeyword));
        });
        const property = f.createPropertySignature([f.createModifier(kinds.ReadonlyKeyword)], handlerProperty, undefined, f.createTypeLiteralNode(methods));
        return markGenerated(ts, property, anchor);
    };

    return { parseParameters, parseOperations, handlerMember };
}
