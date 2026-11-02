import {
    displayPartsToString,
    getContainerNode,
    getTouchingPropertyName,
    getTSPPQuickInfo,
    hasTSPPQuickInfoProviders,
    ScriptElementKind,
    ScriptElementKindModifier,
} from "../_namespaces/ts.js";
import type {
    CancellationToken,
    LanguageServiceHost,
    Node,
    Program,
    QuickInfo,
} from "../_namespaces/ts.js";

/**
 * Lets a plugin's Quick Info provider replace the upstream Quick Info at a position (`TSPP-SLOT(quick-info)`).
 * Providers see the authored TS++ text, the token, its type, and the upstream result; the first one that answers wins.
 * `getNodeForQuickInfo` is the language service's choice of node for a touched token.
 * @internal
 */
export function addTSPPQuickInfo(
    upstream: QuickInfo | undefined,
    fileName: string,
    position: number,
    host: LanguageServiceHost,
    program: Program,
    getNodeForQuickInfo: (node: Node) => Node,
    cancellationToken: CancellationToken,
): QuickInfo | undefined {
    if (!hasTSPPQuickInfoProviders()) return upstream;
    const sourceFile = program.getSourceFile(fileName)!;
    const node = getTouchingPropertyName(sourceFile, position);
    if (node === sourceFile) return upstream;
    const nodeForQuickInfo = getNodeForQuickInfo(node);
    const tokenStart = nodeForQuickInfo.getStart(sourceFile);
    const semanticType = program.getTypeChecker().runWithCancellationToken(
        cancellationToken,
        checker =>
            checker.typeToString(
                checker.getTypeAtLocation(nodeForQuickInfo),
                getContainerNode(nodeForQuickInfo),
            ),
    );
    const snapshot = host.getScriptSnapshot(fileName);
    // Plugin providers describe authored TS++ syntax, not the length-preserving TypeScript
    // projection stored in the SourceFile (which may deliberately contain `any` fallbacks).
    const authoredSourceText = snapshot?.getText(0, snapshot.getLength()) ?? sourceFile.text;
    const contribution = getTSPPQuickInfo(fileName, authoredSourceText, position, {
        token: {
            start: tokenStart,
            length: nodeForQuickInfo.getEnd() - tokenStart,
            text: nodeForQuickInfo.getText(sourceFile),
        },
        semanticType,
        upstream: upstream && {
            display: displayPartsToString(upstream.displayParts),
            kind: upstream.kind,
        },
    });
    if (!contribution) return upstream;
    return {
        kind: upstream?.kind ?? ScriptElementKind.unknown,
        kindModifiers: upstream?.kindModifiers ?? ScriptElementKindModifier.none,
        textSpan: { start: contribution.start, length: contribution.length },
        displayParts: [{ text: contribution.display, kind: "text" }],
        documentation: contribution.documentation
            ? [{ text: contribution.documentation, kind: "text" }]
            : undefined,
    };
}
