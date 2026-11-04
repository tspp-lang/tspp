import type { TSPPSemanticTokenImport } from "@tspp/plugin-sdk/language-service";
import { tsppSemanticTokenTypes } from "@tspp/plugin-sdk/language-service";
import {
    createScanner,
    Debug,
    escapeLeadingUnderscores,
    forEach,
    forEachChild,
    getOriginalTSPPSource,
    getSourceFileOfNode,
    getTSPPSemanticTokens,
    hasTabstop,
    hasTSPPSemanticTokensProviders,
    idText,
    isImportDeclaration,
    isJSDocCommentContainingNode,
    isLiteralKind,
    isNamedImports,
    isTemplateLiteralKind,
    isTSPPSyntaxNode,
} from "../_namespaces/ts.js";
import type {
    Classifications,
    Identifier,
    JSDocContainer,
    LiteralLikeNode,
    Mutable,
    Node,
    NodeArray,
    Program,
    SourceFile,
    SourceFileLike,
    SyntaxList,
    TextRange,
} from "../_namespaces/ts.js";
import {
    Extension,
    NodeFlags,
    ScriptTarget,
    SemanticClassificationFormat,
    SymbolFlags,
    SyntaxKind,
} from "../_namespaces/ts.js";

// Editor services over plugin syntax (`TSPP-SLOT(syntax-extension)` sites). Plugin syntax lowers to ordinary nodes,
// but those nodes may be factory-created without source positions, out of source order, or leave the plugin's own
// keywords and names between parsed nodes.

const scanner = createScanner(ScriptTarget.Latest, /*skipTrivia*/ true);

/**
 * The children of a node in a TS++ file or with factory-created children, for `Node.getChildren`; undefined for other
 * nodes, which the upstream implementation handles. Factory-created children participate in binding and checking but
 * have no lexical range to expose; names and literals that plugin syntax leaves between parsed nodes become tokens.
 * `createNode` creates a services node.
 * @internal
 */
export function createTSPPChildren(node: Node, sourceFile: SourceFileLike | undefined, createNode: (kind: SyntaxKind, pos: number, end: number, parent: Node) => Node): Node[] | undefined {
    if (isJSDocCommentContainingNode(node) || !isInTSPPFile(node) && !hasPositionlessChildren(node)) return undefined;
    const children: Node[] = [];
    scanner.setText((sourceFile || node.getSourceFile()).text);
    let pos = node.pos;
    let hasSyntheticChildren = false;
    const processNode = (child: Node) => {
        // A generated child has no tokens, and an empty one marks no place: the source around it is still scanned.
        if (child.pos < 0 || child.end < 0 || child.pos === child.end) {
            hasSyntheticChildren = true;
            return;
        }
        addSyntheticNodes(children, pos, child.pos, node, hasSyntheticChildren, createNode);
        children.push(child);
        // Lowering can put a child before the one it follows, whose tokens must not be scanned a second time.
        pos = Math.max(pos, child.end);
    };
    const processNodes = (nodes: NodeArray<Node>) => {
        if (nodes.pos < 0 || nodes.end < 0) {
            hasSyntheticChildren = true;
            return;
        }
        addSyntheticNodes(children, pos, nodes.pos, node, hasSyntheticChildren, createNode);
        children.push(createSyntaxList(nodes, node, createNode));
        pos = Math.max(pos, nodes.end);
    };
    // As upstream: JSDoc comments come first, and stay the leading trivia of the first child.
    forEach((node as JSDocContainer).jsDoc, processNode);
    pos = node.pos;
    node.forEachChild(processNode, processNodes);
    addSyntheticNodes(children, pos, node.end, node, hasSyntheticChildren, createNode);
    scanner.setText(undefined);
    return coveringNode(inTokenWalkOrder(children, sourceFile), node, node.end, createNode);
}

/** Walks that land in a node assume one of its children reaches its end, but plugin ranges can leave a gap there. */
function coveringNode(children: Node[], parent: Node, end: number, createNode: (kind: SyntaxKind, pos: number, end: number, parent: Node) => Node): Node[] {
    const last = children[children.length - 1];
    if (last && last.end < end) {
        const filler = createNode(SyntaxKind.Unknown, last.end, end, parent);
        (filler as Mutable<Node>).flags |= NodeFlags.Synthesized;
        children.push(filler);
    }
    return children;
}

/**
 * Lowering overlaps and reorders siblings, but walks over tokens binary search children and assume they are disjoint and
 * in order: forwards they find nothing otherwise, and backwards they can go round forever, as signature help did. So an
 * overlapping child is replaced by its own children here, and of two overlapping tokens the one the parser made is kept.
 */
function inTokenWalkOrder(children: Node[], sourceFile: SourceFileLike | undefined): Node[] {
    if (children.every((child, index) => index === 0 || children[index - 1].end <= child.pos)) return children;
    const walkOrder = (left: Node, right: Node) => left.pos - right.pos || right.end - left.end;
    const pending = [...children].sort(walkOrder);
    const result: Node[] = [];
    while (pending.length) {
        const next = pending.shift()!;
        const last = result[result.length - 1];
        if (!last || last.end <= next.pos) {
            result.push(next);
            continue;
        }
        const lastChildren = last.getChildren(sourceFile as SourceFile);
        const nextChildren = next.getChildren(sourceFile as SourceFile);
        if (lastChildren.length) {
            result.pop();
            pending.push(next, ...lastChildren);
            pending.sort(walkOrder);
        }
        else if (nextChildren.length) {
            pending.push(...nextChildren);
            pending.sort(walkOrder);
        }
        else if (last.flags & NodeFlags.Synthesized && !(next.flags & NodeFlags.Synthesized)) {
            result[result.length - 1] = next;
        }
    }
    return result;
}

function isInTSPPFile(node: Node) {
    return !!(getSourceFileOfNode(node) as SourceFile | undefined)?.fileName.endsWith(Extension.Tspp);
}

function isPositionless(range: TextRange) {
    return range.pos < 0 || range.end < 0;
}

function hasPositionlessChildren(node: Node): boolean {
    return !!forEachChild(node, child => isPositionless(child) || undefined, children => isPositionless(children) || children.some(isPositionless) || undefined);
}

function addSyntheticNodes(nodes: Node[], pos: number, end: number, parent: Node, allowIdentifiers: boolean, createNode: (kind: SyntaxKind, pos: number, end: number, parent: Node) => Node): void {
    scanner.resetTokenState(pos);
    while (pos < end) {
        const token = scanner.scan();
        if (scanner.getTokenStart() >= end) break;
        // Scanning without the parser reads the rest of a template as a new one that runs past the node. It is cut off
        // there, since walks over tokens assume that a node's children cover its whole range.
        const textPos = Math.min(scanner.getTokenEnd(), end);
        if (textPos <= pos) {
            if (token === SyntaxKind.EndOfFileToken) break;
            Debug.fail(`Scanner did not advance while synthesizing ${Debug.formatSyntaxKind(parent.kind)} children`);
        }
        {
            // A token scanned inside a type parameter's range, as in its annotation, is no part of that parameter, and
            // reference search asserts that of what lies directly under one.
            const annotated = parent.kind === SyntaxKind.TypeParameter;
            const node = createNode(token, pos, textPos, annotated ? parent.parent : parent);
            if (token === SyntaxKind.Identifier) {
                if (!hasTabstop(parent) && !allowIdentifiers && !getSourceFileOfNode(parent).fileName.endsWith(Extension.Tspp)) {
                    Debug.fail(`Did not expect ${Debug.formatSyntaxKind(parent.kind)} to have an Identifier in its trivia`);
                }
            }
            if (token === SyntaxKind.Identifier || isLiteralKind(token) || isTemplateLiteralKind(token)) {
                // Plugin syntax leaves names and literals such as keywords, pattern bindings, and match arm results
                // outside the parse tree. They keep their text for services that read it, and the Synthesized flag
                // keeps the checker from resolving or typing them as parse tree nodes.
                if (token === SyntaxKind.Identifier) (node as Mutable<Identifier>).escapedText = escapeLeadingUnderscores(scanner.getTokenValue());
                else (node as Mutable<LiteralLikeNode>).text = scanner.getTokenValue();
                (node as Mutable<Node>).flags |= NodeFlags.Synthesized;
            }
            else if (isTSPPSyntaxNode(parent) || allowIdentifiers) {
                // So are the punctuation and keywords that plugin syntax writes between its nodes, such as `=>` in a
                // kind annotation, which the checker would otherwise take for the arrow of a function.
                (node as Mutable<Node>).flags |= NodeFlags.Synthesized;
            }
            nodes.push(node);
        }
        pos = textPos;
        if (token === SyntaxKind.EndOfFileToken) {
            break;
        }
    }
}

function createSyntaxList(nodes: NodeArray<Node>, parent: Node, createNode: (kind: SyntaxKind, pos: number, end: number, parent: Node) => Node): Node {
    const list = createNode(SyntaxKind.SyntaxList, nodes.pos, nodes.end, parent) as SyntaxList;
    const children: Node[] = [];
    let pos = nodes.pos;
    let hasSyntheticChildren = false;
    for (const node of nodes) {
        if (isPositionless(node) || node.pos === node.end) {
            hasSyntheticChildren = true;
            continue;
        }
        addSyntheticNodes(children, pos, node.pos, parent, hasSyntheticChildren, createNode);
        children.push(node);
        pos = Math.max(pos, node.end);
    }
    addSyntheticNodes(children, pos, nodes.end, parent, hasSyntheticChildren, createNode);
    list._children = coveringNode(inTokenWalkOrder(children, /*sourceFile*/ undefined), list, nodes.end, createNode);
    return list;
}

/** Whether a node's children are factory-created or out of source order, which the formatting rules cannot walk. @internal */
export function hasUnformattableTSPPChildren(node: Node): boolean {
    let end = node.pos;
    const isUnordered = (range: TextRange) => {
        if (range.pos < 0 || range.pos < end) return true;
        end = range.end;
        return false;
    };
    return !!forEachChild(
        node,
        child => isUnordered(child) || undefined,
        children => isUnordered(children) || children.some(child => child.pos < 0) || undefined,
    );
}

/** Whether the type parameters of a declaration belong to plugin syntax, so they have no text to delete. @internal */
export function hasTSPPSyntaxTypeParameters(declaration: Node): boolean {
    return isTSPPSyntaxNode(declaration);
}

/** Whether a name was declared by plugin syntax, such as a type-level `let` binding, without declaration text of its own. @internal */
export function isTSPPSyntaxDeclarationName(token: Node): boolean {
    return !!(token.flags & NodeFlags.Synthesized) || token.parent.kind === SyntaxKind.TypeParameter && (token.parent.end === token.parent.pos || isTSPPSyntaxNode(token.parent.parent));
}

/** Names the file imports, with the authored text of the files declaring them, which the file's own tree can't tell. */
function importsOf(sourceFile: SourceFile, program: Program): TSPPSemanticTokenImport[] {
    const checker = program.getTypeChecker();
    const imports: TSPPSemanticTokenImport[] = [];
    for (const statement of sourceFile.statements) {
        if (!isImportDeclaration(statement)) continue;
        const bindings = statement.importClause?.namedBindings;
        if (!bindings || !isNamedImports(bindings)) continue;
        for (const element of bindings.elements) {
            const symbol = checker.getSymbolAtLocation(element.name);
            const declaration = symbol && symbol.flags & SymbolFlags.Alias ? checker.getAliasedSymbol(symbol).declarations?.[0] : undefined;
            if (!declaration) continue;
            const declaring = getSourceFileOfNode(declaration);
            imports.push({ name: idText(element.name), importedName: element.propertyName?.text ?? idText(element.name), sourceText: getOriginalTSPPSource(declaring.fileName, declaring.text) });
        }
    }
    return imports;
}

/**
 * Semantic tokens of a TS++ file, with what plugins decide about syntax they lowered. They go out sorted and without
 * overlaps, as editors require: the classifier walks a lowered tree in its own order, and sees some names more than once.
 */
export function addTSPPSemanticTokens(fileName: string, program: Program | undefined, classifications: Classifications, format: SemanticClassificationFormat | undefined): Classifications {
    if (format !== SemanticClassificationFormat.TwentyTwenty || !fileName.endsWith(Extension.Tspp)) return classifications;
    const sourceFile = program?.getSourceFile(fileName);
    const tokens: { start: number; length: number; encoded: number; fromPlugin?: boolean; }[] = [];
    for (let index = 0; index + 2 < classifications.spans.length; index += 3) {
        tokens.push({ start: classifications.spans[index], length: classifications.spans[index + 1], encoded: classifications.spans[index + 2] });
    }
    if (sourceFile && program && hasTSPPSemanticTokensProviders()) {
        const known = tokens.filter(token => tsppSemanticTokenTypes[(token.encoded >> 8) - 1]).map(token => ({ start: token.start, length: token.length, type: tsppSemanticTokenTypes[(token.encoded >> 8) - 1] }));
        for (const token of getTSPPSemanticTokens(sourceFile, known, importsOf(sourceFile, program))) {
            tokens.push({ start: token.start, length: token.length, encoded: token.type === "none" ? 0 : (tsppSemanticTokenTypes.indexOf(token.type) + 1) << 8, fromPlugin: true });
        }
    }
    const spans: number[] = [];
    let end = 0;
    const inOrder = tokens.map((token, index) => ({ token, index })).sort((left, right) => left.token.start - right.token.start || Number(!!right.token.fromPlugin) - Number(!!left.token.fromPlugin) || left.index - right.index);
    for (const { token } of inOrder) {
        if (token.start < end || token.length <= 0) continue;
        end = token.start + token.length;
        if (token.encoded) spans.push(token.start, token.length, token.encoded);
    }
    return { spans, endOfLineState: classifications.endOfLineState };
}
