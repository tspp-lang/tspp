import type { TSPPTypeScript } from "@tspp/plugin-sdk/compiler";
import type * as TS from "typescript-upstream";

/** The host compiler's API, set when the plugin activates: its parser lowers every active plugin's syntax. */
export let ts: TSPPTypeScript;

export function useTypeScript(api: TSPPTypeScript): void {
    ts = api;
}

// Compiler nodes only have methods such as `getStart` when the language service is loaded, which `tspp` does not do.
let triviaScanner: TS.Scanner | undefined;

/** Where a node's first token starts, after its leading trivia. */
export function nodeStart(node: TS.Node, sourceFile: TS.SourceFile): number {
    if (node.pos < 0 || node.pos === node.end) return node.pos;
    triviaScanner ??= ts.createScanner(ts.ScriptTarget.Latest, /*skipTrivia*/ true);
    triviaScanner.setText(sourceFile.text, node.pos, node.end - node.pos);
    triviaScanner.scan();
    return triviaScanner.getTokenStart();
}

/** An identifier's or literal's text; a compiler identifier only has a \`text\` property when the language service is loaded. */
export function nameText(node: TS.Node): string {
    return ts.isIdentifier(node) ? ts.idText(node) : (node as TS.LiteralLikeNode).text;
}

export function nodeWidth(node: TS.Node, sourceFile: TS.SourceFile): number {
    return node.end - nodeStart(node, sourceFile);
}
