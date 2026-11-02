import type { TSPPTypeScript } from "@tspp/plugin-sdk/compiler";
import type * as TS from "typescript-upstream";

/**
 * The parser's factory starts nodes at position 0 with width 0. Gives each such node in `root`, which the plugin
 * created without a source range, a usable one. Names, literals, and bodies get the synthesized position -1: empty,
 * they would read as missing (a name would not resolve, a literal would print nothing, a body would mark an overload),
 * while a synthesized node keeps its text. Every other node gets an empty range at `anchor`, so that editor services, which
 * read tokens of statements and members, and declaration emit, which reads lines, see a real position. Without
 * `anchor`, every generated node gets -1, and a diagnostic on one is reported on its nearest positioned ancestor.
 * Editor services scan the tokens of blocks, so generated bodies take `bodyRange`, a short range of authored source,
 * when given; a body prints from its statements, not from that source.
 */
export function markGenerated<T extends TS.Node>(ts: TSPPTypeScript, root: T, anchor: number | undefined, bodyRange?: TS.TextRange): T {
    const place = (node: TS.Node | TS.NodeArray<TS.Node>, name: boolean) => {
        if (node.pos !== 0 || node.end !== 0) return;
        ts.setTextRange(node, name || anchor === undefined ? { pos: -1, end: -1 } : { pos: anchor, end: anchor });
    };
    const visit = (node: TS.Node): void => {
        if (bodyRange && (ts.isBlock(node) || ts.isModuleBlock(node)) && node.pos === 0 && node.end === 0) ts.setTextRange(node, bodyRange);
        place(node, isTextual(node));
        ts.forEachChild(node, visit, nodes => {
            place(nodes, /*name*/ false);
            nodes.forEach(visit);
        });
    };
    visit(root);
    return root;

    /**
     * Nodes that read their text from the source, or that the compiler treats as absent when empty: names, literals
     * (printed from source text when positioned), and function and module bodies (an empty body marks an overload).
     */
    function isTextual(node: TS.Node): boolean {
        return ts.isIdentifier(node) || ts.isPrivateIdentifier(node) || ts.isQualifiedName(node) || ts.isLiteralExpression(node)
            || ts.isBlock(node) || ts.isModuleBlock(node);
    }
}
