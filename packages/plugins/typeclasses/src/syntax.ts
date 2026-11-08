import { markGenerated } from "@tspp/plugin-sdk";
import type { TSPPSyntaxCursor, TSPPSyntaxExtension, TSPPTypeScript } from "@tspp/plugin-sdk/compiler";
import type * as TS from "typescript-upstream";

export const syntaxErrorCode = 19100;

export interface WhereClause {
    readonly items: readonly TS.TypeNode[];
    /** Each item as written, since a generated copy has no source text to read. */
    readonly itemTexts: ReadonlyMap<TS.TypeNode, string>;
    /** The clause as written, for `.d.tspp` output. */
    readonly text: string;
}

/** The dictionary field a typeclass has for a superclass it requires, by the name its `where` clause writes. */
export function superclassField(ts: TSPPTypeScript, item: TS.TypeNode): string | undefined {
    if (!ts.isTypeReferenceNode(item)) return undefined;
    const name = ts.isQualifiedName(item.typeName) ? item.typeName.right : item.typeName;
    return `$${ts.idText(name)}`;
}

/** The inherent methods one `impl` block gives a type, lowered to an interface and module-level functions. */
export interface InherentBlock {
    /** The target as written, in terms of the interface's type parameters. */
    readonly head: TS.TypeNode;
    /** The function each method lowers to, which takes `self` first. */
    readonly helpers: ReadonlyMap<string, TS.FunctionDeclaration>;
    readonly start: number;
    readonly end: number;
}

/** Finds what was recorded for a parsed node, also from the copy a program rebuild made of it. */
export interface SyntaxTable<T> {
    get(node: TS.Node): T | undefined;
    has(node: TS.Node): boolean;
}

/** What parsing leaves for checking and emit: ordinary declarations, and these tables of what they stand for. */
export interface TypeclassSyntax {
    readonly extensions: readonly TSPPSyntaxExtension[];
    readonly wheres: SyntaxTable<WhereClause>;
    /** The interfaces typeclass declarations lower to. */
    readonly typeclasses: SyntaxTable<true>;
    /** What `impl` declarations lower to: a variable, or a function that builds the value from its `where` clause. */
    readonly impls: SyntaxTable<true>;
    /** The object literal holding the methods of an implementation. */
    readonly implBodies: SyntaxTable<TS.ObjectLiteralExpression>;
    /** The empty spread an `@` argument lowers to, with the expression after the `@`. */
    readonly contexts: SyntaxTable<TS.Expression>;
    /** By the interface an inherent block lowers to. */
    readonly inherent: SyntaxTable<InherentBlock>;
    /** The module-level functions of inherent methods, with the name of the type they extend. */
    readonly helpers: SyntaxTable<string>;
    /** The names typeclasses are declared under. */
    readonly typeclassNames: ReadonlySet<string>;
    /** Whether any syntax of this plugin has been parsed in this process. */
    readonly used: () => boolean;
}

/**
 * Lowers while parsing, so the checker and the language service see ordinary TypeScript:
 *
 * - `typeclass Eq<A, B = A> { equals(a: A, b: B): boolean; }` becomes `interface Eq<A, B = A> { ... }`, the dictionary
 *   type, and `const Eq: { equals<A, B = A>(a: A, b: B): boolean; } = {} as never;`, which types `Eq.equals(a, b)`.
 * - `impl NumberEq = Eq<number> { ... }` becomes `const NumberEq: Eq<number> = { ... };`.
 * - `impl<T> ArrayEq = Eq<T[]> where <Eq<T>> { ... }` becomes a function that returns the object, with the clause.
 * - `impl<T> Option<T> { isSome(self): boolean { ... } }` becomes an interface listing the methods without `self`, which
 *   a member lookup instantiates, and `function Option$isSome<T>(self: Option<T>): boolean { ... }`.
 * - `@context` becomes `...(context, [] as const)`, which checks the context and passes no argument.
 * - `where <...>` leaves the declaration as it is and only records its items, whose kinds need names to be bound.
 */
export function createTypeclassSyntax(ts: TSPPTypeScript): TypeclassSyntax {
    const kinds = ts.SyntaxKind;
    const wheres = new WeakMap<TS.Node, WhereClause & { readonly holder: TS.Node; }>();
    const typeclasses = new WeakMap<TS.Node, true>();
    const impls = new WeakMap<TS.Node, true>();
    const implBodies = new WeakMap<TS.Node, TS.ObjectLiteralExpression>();
    const contexts = new WeakMap<TS.Node, TS.Expression>();
    const inherent = new WeakMap<TS.Node, InherentBlock>();
    const helpers = new WeakMap<TS.Node, string>();
    const restored = new WeakMap<TS.Node, string>();
    const typeclassNames = new Set<string>();
    let used = false;

    const table = <T>(entries: WeakMap<TS.Node, T>, found?: (node: TS.Node, entry: T) => void): SyntaxTable<T> => ({
        get(node) {
            const entry = entries.get(node) ?? entries.get(ts.getOriginalNode(node));
            if (entry !== undefined) found?.(node, entry);
            return entry;
        },
        has: node => entries.has(node) || entries.has(ts.getOriginalNode(node)),
    });

    const scanner = ts.createScanner(ts.ScriptTarget.Latest, /*skipTrivia*/ true);
    const tokenStart = (text: string, pos: number) => {
        scanner.setText(text, pos);
        scanner.scan();
        return scanner.getTokenStart();
    };

    /** Makes a copy of parsed syntax generated, for `markGenerated` to place. */
    const clearPositions = (root: TS.Node): void => {
        const clear = (node: TS.Node | TS.NodeArray<TS.Node>) => void ts.setTextRange(node, { pos: 0, end: 0 });
        clear(root);
        ts.forEachChild(root, clearPositions, nodes => {
            clear(nodes);
            nodes.forEach(clearPositions);
        });
    };

    /** `markGenerated`, for copies of type references, whose name and arguments must not look a token apart. */
    const placeGenerated = <T extends TS.Node>(root: T, anchor: number, bodyRange?: TS.TextRange): T => {
        const placed = markGenerated(ts, root, anchor, bodyRange);
        const joinArguments = (node: TS.Node): void => {
            if (ts.isTypeReferenceNode(node) && node.typeArguments && node.typeName.end < 0) ts.setTextRange(node.typeArguments, { pos: node.typeName.end, end: node.typeName.end });
            ts.forEachChild(node, joinArguments);
        };
        joinArguments(placed);
        return placed;
    };

    /** An empty type parameter list is a grammar error, where no list is not. */
    const listOrNone = <T>(items: readonly T[]) => items.length ? items : undefined;

    const setParents = (node: TS.Node, parent: TS.Node): void => {
        (node as { parent: TS.Node; }).parent = parent;
        ts.forEachChild(node, child => setParents(child, node));
    };

    const modifierPrefix = (cursor: TSPPSyntaxCursor) =>
        (cursor.modifiers ?? []).map(modifier => `${ts.tokenToString(modifier.kind)} `).join("");

    const copyModifiers = (cursor: TSPPSyntaxCursor) => (cursor.modifiers ?? []).map(modifier => cursor.factory.createModifier(modifier.kind as TS.ModifierSyntaxKind));

    /** A variable statement beside plugin syntax, with the modifiers of that syntax and ambient where it is. */
    const variableStatement = (cursor: TSPPSyntaxCursor, declaration: TS.VariableDeclaration) => {
        const f = cursor.factory;
        const modifiers = copyModifiers(cursor);
        if (cursor.inAmbientContext() && !modifiers.some(modifier => modifier.kind === kinds.DeclareKeyword)) modifiers.push(f.createModifier(kinds.DeclareKeyword));
        return f.createVariableStatement(modifiers, f.createVariableDeclarationList([declaration], ts.NodeFlags.Const));
    };

    const isWordFollowedByName = (cursor: TSPPSyntaxCursor, word: string) =>
        cursor.tokenText() === word && cursor.lookAhead(() => cursor.nextToken() === kinds.Identifier && !cursor.hasPrecedingLineBreak());

    /** `where <...>` at the current token, when it is there. */
    const parseWhere = (cursor: TSPPSyntaxCursor): WhereClause | undefined => {
        if (cursor.tokenText() !== "where") return undefined;
        const text = cursor.getSourceText();
        const start = cursor.getTokenStart();
        cursor.nextToken();
        const items = cursor.parseTypeArguments() ?? [];
        const end = cursor.getNodePos();
        if (!items.length) cursor.parseErrorAt(start, end, "A 'where' clause must list at least one constraint.", syntaxErrorCode);
        const itemTexts = new Map<TS.TypeNode, string>();
        for (const item of items) {
            itemTexts.set(item, text.slice(tokenStart(text, item.pos), item.end));
        }
        return { items, itemTexts, text: text.slice(start, end).trimEnd() };
    };

    /**
     * Hangs the items from what the binder and name resolution see in `declaration`. Name resolution only lets a function's
     * type parameters reach what hangs from a parameter or the return type, so there they hang from an unused parameter.
     */
    const attachWhere = (f: TS.NodeFactory, declaration: TS.Node, clause: WhereClause) => {
        // Refactors walk up from a name to what contains it, so all but the generated name have the range of the items.
        const items = { pos: clause.items[0]?.pos ?? -1, end: clause.items[clause.items.length - 1]?.end ?? -1 };
        const tuple = f.createTupleTypeNode(clause.items);
        ts.setTextRange(tuple, items);
        ts.setTextRange(tuple.elements, items);
        const holder = ts.isFunctionLike(declaration)
            ? ts.setTextRange(f.createParameterDeclaration(undefined, undefined, ts.setTextRange(f.createIdentifier("__tspp_where"), { pos: -1, end: -1 }), undefined, tuple), items)
            : tuple;
        setParents(holder, declaration);
        wheres.set(declaration, { ...clause, holder });
    };

    /** Declarations with no body to print restore as written; the others write their clause where it stands. */
    const whereExtension = (position: "function-clause" | "header-clause" | "type-alias-annotation"): TSPPSyntaxExtension => ({
        position,
        startTokens: [kinds.Identifier],
        keywords: ["where"],
        isStart: cursor => cursor.tokenText() === "where" && cursor.lookAhead(() => cursor.nextToken() === kinds.LessThanToken),
        parse(cursor) {
            used = true;
            const clause = parseWhere(cursor)!;
            const text = cursor.getSourceText();
            const f = cursor.factory;
            return (declaration: TS.Node) => {
                attachWhere(f, declaration, clause);
                if (ts.isInterfaceDeclaration(declaration) || ts.isTypeAliasDeclaration(declaration) || ts.isMethodSignature(declaration) || ts.isFunctionTypeNode(declaration) || ts.isConstructorTypeNode(declaration)) {
                    restored.set(declaration, text.slice(tokenStart(text, declaration.pos), declaration.end).trimEnd());
                }
            };
        },
        restoreFunctionClause: node => wheres.get(node)?.text ?? wheres.get(ts.getOriginalNode(node))?.text,
        getBoundChild: position === "function-clause" ? node => (wheres.get(node) ?? wheres.get(ts.getOriginalNode(node)))?.holder : undefined,
        restoreDeclaration: node => restored.get(ts.getOriginalNode(node)),
    });

    const typeclassDeclaration: TSPPSyntaxExtension = {
        position: "declaration",
        startTokens: [kinds.Identifier],
        keywords: ["typeclass"],
        isStart: cursor => isWordFollowedByName(cursor, "typeclass"),
        parse(cursor) {
            used = true;
            const f = cursor.factory;
            const pos = cursor.getNodePos();
            const start = cursor.getTokenStart();
            cursor.nextToken();
            const parseHeader = () => {
                const name = cursor.parseIdentifier();
                const typeParameters = cursor.parseTypeParameters();
                const clause = parseWhere(cursor);
                if (cursor.token() !== kinds.OpenBraceToken) cursor.parseExpected(kinds.OpenBraceToken);
                const body = cursor.parseType();
                return { name, typeParameters, clause, members: ts.isTypeLiteralNode(body) ? body.members : undefined };
            };
            // Each method of the value needs its own copy of the type parameters, so the header is read once for each.
            const count = cursor.lookAhead(parseHeader).members?.length ?? 0;
            const methods: TS.MethodSignature[] = [];
            for (let index = 0; index < count; index++) {
                const copy = cursor.lookAhead(parseHeader);
                const member = copy.members![index];
                if (!ts.isMethodSignature(member)) continue;
                methods.push(f.createMethodSignature(undefined, member.name, member.questionToken, listOrNone([...member.typeParameters ?? [], ...copy.typeParameters ?? []]), member.parameters, member.type));
            }
            // A superclass is a field of the dictionary, whose type is written like the item.
            const fieldItems = cursor.lookAhead(parseHeader).clause?.items ?? [];
            const { name, typeParameters, clause, members } = parseHeader();
            const end = cursor.getNodePos();
            const generatedMembers: TS.PropertySignature[] = [
                // Makes typeclasses of the same shape unrelated: no value has this property, and two of them disagree on it.
                f.createPropertySignature([f.createModifier(kinds.ReadonlyKeyword)], "$Typeclass", f.createToken(kinds.QuestionToken), f.createLiteralTypeNode(f.createStringLiteral(ts.idText(name)))),
                ...fieldItems.flatMap(item => {
                    const field = superclassField(ts, item);
                    return field ? [f.createPropertySignature([f.createModifier(kinds.ReadonlyKeyword)], field, undefined, item)] : [];
                }),
            ];
            generatedMembers.forEach(member => {
                clearPositions(member);
                placeGenerated(member, end);
            });
            for (const member of members ?? []) {
                if (!ts.isMethodSignature(member)) cursor.parseErrorAt(member.pos, member.end, "A typeclass may only declare methods.", syntaxErrorCode);
            }
            const dictionary = cursor.finishNode(f.createInterfaceDeclaration(cursor.modifiers as readonly TS.ModifierLike[] | undefined, name, typeParameters, undefined, f.createNodeArray([...members ?? [], ...generatedMembers])), cursor.modifiers?.pos ?? pos, end);
            typeclasses.set(dictionary, true);
            typeclassNames.add(ts.idText(name));
            if (clause) attachWhere(f, dictionary, clause);

            const valueType = f.createTypeLiteralNode(methods);
            const declaration = f.createVariableDeclaration(f.createIdentifier(ts.idText(name)), undefined, valueType, cursor.inAmbientContext() ? undefined : f.createAsExpression(f.createObjectLiteralExpression(), f.createKeywordTypeNode(kinds.NeverKeyword)));
            clearPositions(valueType);
            const value = placeGenerated(variableStatement(cursor, declaration), end);
            restored.set(dictionary, `${modifierPrefix(cursor)}${cursor.getSourceText().slice(start, end).trimEnd()}`);
            restored.set(value, "");
            return [dictionary, value];
        },
        restoreDeclaration: node => restored.get(ts.getOriginalNode(node)),
    };

    /** The members of `{ ... }` at the current token, with no commas between them. */
    const parseMembers = (cursor: TSPPSyntaxCursor) => {
        cursor.parseExpected(kinds.OpenBraceToken);
        const members = cursor.parseClassMembers();
        cursor.parseExpected(kinds.CloseBraceToken);
        return members;
    };

    const objectLiteralOf = (cursor: TSPPSyntaxCursor, members: readonly TS.ClassElement[]) => {
        const f = cursor.factory;
        const properties: TS.ObjectLiteralElementLike[] = [];
        for (const member of members) {
            const modifiers = ts.canHaveModifiers(member) ? ts.getModifiers(member) ?? [] : [];
            if (modifiers.some(modifier => modifier.kind !== kinds.AsyncKeyword) || !ts.isMethodDeclaration(member) && !ts.isPropertyDeclaration(member)) {
                cursor.parseErrorAt(member.pos, member.end, "An implementation may only hold methods and properties, with no modifiers but 'async'.", syntaxErrorCode);
            }
            else if (ts.isMethodDeclaration(member)) properties.push(member);
            else properties.push(cursor.finishNode(f.createPropertyAssignment(member.name, member.initializer ?? f.createIdentifier("undefined")), member.pos, member.end));
        }
        return f.createObjectLiteralExpression(properties, /*multiLine*/ true);
    };

    const parseNamedImpl = (cursor: TSPPSyntaxCursor, pos: number, start: number, typeParameters: TS.NodeArray<TS.TypeParameterDeclaration> | undefined, name: TS.Identifier) => {
        const f = cursor.factory;
        cursor.parseExpected(kinds.EqualsToken);
        const type = cursor.parseType();
        const clause = parseWhere(cursor);
        const headerEnd = cursor.getNodePos();
        const hasBody = cursor.token() === kinds.OpenBraceToken;
        const bodyStart = cursor.getNodePos();
        const members = hasBody ? parseMembers(cursor) : undefined;
        if (!hasBody) cursor.parseSemicolon();
        const bodyEnd = cursor.getNodePos();
        const ambient = cursor.inAmbientContext();
        const body = members && !ambient ? cursor.finishNode(objectLiteralOf(cursor, members), bodyStart, bodyEnd) : undefined;
        let statement: TS.Statement;
        if (!typeParameters && !clause) {
            const declaration = f.createVariableDeclaration(name, undefined, type, body);
            impls.set(declaration, true);
            if (body) implBodies.set(declaration, body);
            statement = markGenerated(ts, cursor.finishNode(variableStatement(cursor, declaration), pos), start);
        }
        else {
            const block = body && f.createBlock([f.createReturnStatement(body)], /*multiLine*/ true);
            const modifiers = copyModifiers(cursor);
            if (ambient && !modifiers.some(modifier => modifier.kind === kinds.DeclareKeyword)) modifiers.push(f.createModifier(kinds.DeclareKeyword));
            const factory = f.createFunctionDeclaration(modifiers, undefined, name, typeParameters, [], type, block);
            impls.set(factory, true);
            if (body) implBodies.set(factory, body);
            if (clause) attachWhere(f, factory, clause);
            statement = markGenerated(ts, cursor.finishNode(factory, pos), start, block && { pos: bodyStart, end: bodyEnd });
        }
        restored.set(statement, `${modifierPrefix(cursor)}${cursor.getSourceText().slice(start, headerEnd).trimEnd()};`);
        return statement;
    };

    /** Each method needs its own copies of the block's type parameters, target, and clause, so they are read once for each. */
    const parseInherentBlock = (cursor: TSPPSyntaxCursor, pos: number, start: number) => {
        const f = cursor.factory;
        const parseHeader = () => {
            const typeParameters = cursor.parseTypeParameters();
            const head = cursor.parseType();
            const clause = parseWhere(cursor);
            const membersStart = cursor.getNodePos();
            const members = parseMembers(cursor);
            return { typeParameters, head, clause, members, membersStart };
        };
        const count = cursor.lookAhead(parseHeader).members.length;
        const target = cursor.lookAhead(parseHeader).head;
        const targetName = ts.isTypeReferenceNode(target) && ts.isIdentifier(target.typeName) ? ts.idText(target.typeName) : undefined;
        const signatures: TS.MethodSignature[] = [];
        const clausesOf = new Map<TS.MethodSignature, WhereClause | undefined>();
        const functions: TS.FunctionDeclaration[] = [];
        const helperTable = new Map<string, TS.FunctionDeclaration>();
        const combine = (block: WhereClause | undefined, method: WhereClause | undefined): WhereClause | undefined =>
            block && method
                ? { items: [...block.items, ...method.items], itemTexts: new Map([...block.itemTexts, ...method.itemTexts]), text: "" }
                : block ?? method;
        const ambient = cursor.inAmbientContext();
        for (let index = 0; index < count; index++) {
            const forFunction = cursor.lookAhead(parseHeader);
            const forSignature = cursor.lookAhead(parseHeader);
            const method = forFunction.members[index];
            const signature = forSignature.members[index];
            if (!ts.isMethodDeclaration(method) || !ts.isMethodDeclaration(signature)) continue;
            const self = method.parameters[0];
            const valid = !!targetName && ts.isIdentifier(method.name) && !!self && ts.isIdentifier(self.name) && ts.idText(self.name) === "self"
                && !self.type && !self.questionToken && !self.dotDotDotToken && !self.initializer && !!method.type;
            // A method in error, as while it is being typed, still lowers to a function that covers its text, so editor
            // features find its nodes there, but it gives the type no member. Its errors are reported below.
            const helperName = `${targetName ?? "unnamed"}$${ts.isIdentifier(method.name) ? ts.idText(method.name) : index}`;
            clearPositions(forFunction.head);
            forFunction.typeParameters?.forEach(clearPositions);
            const modifiers: TS.Modifier[] = [...ts.getModifiers(method) ?? []].filter(modifier => modifier.kind === kinds.AsyncKeyword);
            if (ambient) modifiers.push(f.createModifier(kinds.DeclareKeyword));
            const parameters = self
                ? [f.createParameterDeclaration(undefined, undefined, self.name, undefined, forFunction.head), ...method.parameters.slice(1)]
                : [...method.parameters];
            const helper = f.createFunctionDeclaration(modifiers, method.asteriskToken, f.createIdentifier(helperName), listOrNone([...forFunction.typeParameters ?? [], ...method.typeParameters ?? []]), parameters, method.type, method.body);
            const clause = combine(forFunction.clause, wheres.get(method));
            if (clause) attachWhere(f, helper, clause);
            helpers.set(helper, targetName ?? "unnamed");
            functions.push(placeGenerated(cursor.finishNode(helper, method.pos, method.end), start, method.body));
            if (!valid) continue;
            helperTable.set(ts.idText(method.name as TS.Identifier), helper);

            const member = f.createMethodSignature(undefined, f.createIdentifier(ts.idText(signature.name as TS.Identifier)), undefined, signature.typeParameters, signature.parameters.slice(1), signature.type);
            clearPositions(member);
            signatures.push(member);
            clausesOf.set(member, combine(forSignature.clause, wheres.get(signature)));
        }
        const final = parseHeader();
        const end = cursor.getNodePos();
        if (!targetName) cursor.parseErrorAt(final.head.pos, final.head.end, "An inherent implementation must name a class or a nominal type.", syntaxErrorCode);
        for (const member of final.members) {
            if (!ts.isMethodDeclaration(member)) cursor.parseErrorAt(member.pos, member.end, "An inherent implementation may only hold methods.", syntaxErrorCode);
            else if (!ts.isIdentifier(member.name)) cursor.parseErrorAt(member.name.pos, member.name.end, "An inherent method needs a plain name.", syntaxErrorCode);
            else {
                const self = member.parameters[0];
                if (!self || !ts.isIdentifier(self.name) || ts.idText(self.name) !== "self") cursor.parseErrorAt(member.name.pos, member.name.end, "An inherent method must take 'self' as its first parameter.", syntaxErrorCode);
                else if (self.type || self.questionToken || self.dotDotDotToken || self.initializer) cursor.parseErrorAt(self.pos, self.end, "'self' takes its type from the implementation, and cannot be optional, rest, or defaulted.", syntaxErrorCode);
                else if (!member.type) cursor.parseErrorAt(member.name.pos, member.name.end, "An inherent method must declare its return type.", syntaxErrorCode);
            }
        }
        const text = cursor.getSourceText();
        const methodTexts = final.members.filter(ts.isMethodDeclaration).map(method => `    ${text.slice(tokenStart(text, method.pos), method.body?.pos ?? method.end).trim().replace(/;$/, "")};`);
        const headerText = text.slice(start, final.membersStart).trimEnd();
        final.typeParameters?.forEach(clearPositions);
        clearPositions(final.head);
        const companion = f.createInterfaceDeclaration(undefined, f.createIdentifier(`${targetName ?? "unnamed"}$impl$${start}`), final.typeParameters, undefined, signatures);
        for (const [member, clause] of clausesOf) {
            if (clause) attachWhere(f, member, clause);
        }
        // The target hangs from the interface, whose type parameters it is written in.
        placeGenerated(final.head, start);
        setParents(final.head, companion);
        inherent.set(companion, { head: final.head, helpers: helperTable, start, end });
        restored.set(companion, `${headerText} {\n${methodTexts.join("\n")}\n}`);
        const placed = placeGenerated(cursor.finishNode(companion, pos, pos), start);
        for (const statement of functions) restored.set(statement, "");
        return [placed, ...functions];
    };

    const implDeclaration: TSPPSyntaxExtension = {
        position: "declaration",
        startTokens: [kinds.Identifier],
        keywords: ["impl"],
        isStart: cursor => cursor.tokenText() === "impl" && cursor.lookAhead(() => {
            const next = cursor.nextToken();
            if (cursor.hasPrecedingLineBreak()) return false;
            if (next === kinds.Identifier) return true;
            return next === kinds.LessThanToken && !!cursor.parseTypeParameters() && cursor.token() === kinds.Identifier && !cursor.hasPrecedingLineBreak();
        }),
        parse(cursor) {
            used = true;
            const pos = cursor.getNodePos();
            const start = cursor.getTokenStart();
            cursor.nextToken();
            const named = cursor.lookAhead(() => {
                cursor.parseTypeParameters();
                cursor.parseIdentifier();
                return cursor.token() === kinds.EqualsToken;
            });
            if (!named) return parseInherentBlock(cursor, pos, start);
            const typeParameters = cursor.parseTypeParameters();
            return parseNamedImpl(cursor, pos, start, typeParameters, cursor.parseIdentifier());
        },
        restoreDeclaration: node => restored.get(ts.getOriginalNode(node)),
    };

    const contextArgument: TSPPSyntaxExtension = {
        position: "argument",
        startTokens: [kinds.AtToken],
        keywords: ["@"],
        // `@dec class {}` stays a decorated class.
        isStart: cursor => cursor.lookAhead(() => {
            cursor.nextToken();
            cursor.parseAssignmentExpression();
            return cursor.token() !== kinds.ClassKeyword && cursor.token() !== kinds.AbstractKeyword && cursor.token() !== kinds.AtToken;
        }),
        parse(cursor) {
            used = true;
            const f = cursor.factory;
            const pos = cursor.getNodePos();
            const start = cursor.getTokenStart();
            cursor.nextToken();
            const context = cursor.parseAssignmentExpression();
            const noArguments = f.createAsExpression(f.createArrayLiteralExpression(), f.createTypeReferenceNode("const"));
            const spread = cursor.finishNode(f.createSpreadElement(f.createParenthesizedExpression(f.createBinaryExpression(context, kinds.CommaToken, noArguments))), pos);
            contexts.set(spread, context);
            return markGenerated(ts, spread, start);
        },
    };

    return {
        extensions: [typeclassDeclaration, implDeclaration, whereExtension("function-clause"), whereExtension("header-clause"), whereExtension("type-alias-annotation"), contextArgument],
        // A rebuilt program binds its own copy of a declaration, which is where the items' names have to resolve.
        wheres: table(wheres as WeakMap<TS.Node, WhereClause>, (node, clause) => {
            if (!(node.flags & ts.NodeFlags.Synthesized)) ((clause as WhereClause & { readonly holder: { parent: TS.Node; }; }).holder).parent = node;
        }),
        typeclasses: table(typeclasses),
        impls: table(impls),
        implBodies: table(implBodies),
        contexts: table(contexts),
        inherent: table(inherent),
        helpers: table(helpers),
        typeclassNames,
        used: () => used,
    };
}
