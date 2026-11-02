import {
    createScanner,
    Debug,
    escapeLeadingUnderscores,
    forEach,
    forEachChild,
    getSourceFileOfNode,
    hasTabstop,
    isJSDocCommentContainingNode,
    isLiteralKind,
    isTemplateLiteralKind,
    isTSPPSyntaxNode,
} from "../_namespaces/ts.js";
import type {
    Identifier,
    JSDocContainer,
    LiteralLikeNode,
    Mutable,
    Node,
    NodeArray,
    SourceFile,
    SourceFileLike,
    SyntaxList,
    TextRange,
} from "../_namespaces/ts.js";
import {
    Extension,
    NodeFlags,
    ScriptTarget,
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
        if (child.pos < 0 || child.end < 0) {
            hasSyntheticChildren = true;
            return;
        }
        addSyntheticNodes(children, pos, child.pos, node, hasSyntheticChildren, createNode);
        children.push(child);
        pos = child.end;
    };
    const processNodes = (nodes: NodeArray<Node>) => {
        if (nodes.pos < 0 || nodes.end < 0) {
            hasSyntheticChildren = true;
            return;
        }
        addSyntheticNodes(children, pos, nodes.pos, node, hasSyntheticChildren, createNode);
        children.push(createSyntaxList(nodes, node, createNode));
        pos = nodes.end;
    };
    // As upstream: JSDoc comments come first, and stay the leading trivia of the first child.
    forEach((node as JSDocContainer).jsDoc, processNode);
    pos = node.pos;
    node.forEachChild(processNode, processNodes);
    addSyntheticNodes(children, pos, node.end, node, hasSyntheticChildren, createNode);
    scanner.setText(undefined);
    return children;
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
        const textPos = scanner.getTokenEnd();
        if (textPos <= pos) {
            if (token === SyntaxKind.EndOfFileToken) break;
            Debug.fail(`Scanner did not advance while synthesizing ${Debug.formatSyntaxKind(parent.kind)} children`);
        }
        if (textPos <= end) {
            const node = createNode(token, pos, textPos, parent);
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
        if (isPositionless(node)) {
            hasSyntheticChildren = true;
            continue;
        }
        addSyntheticNodes(children, pos, node.pos, parent, hasSyntheticChildren, createNode);
        children.push(node);
        pos = node.end;
    }
    addSyntheticNodes(children, pos, nodes.end, parent, hasSyntheticChildren, createNode);
    list._children = children;
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
