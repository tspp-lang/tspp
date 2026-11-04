import {
    displayPartsToString,
    getContainerNode,
    getRegisteredTSPPSyntaxClaims,
    getTouchingPropertyName,
    getTSPPQuickInfo,
    hasTSPPQuickInfoProviders,
    ScriptElementKind,
    ScriptElementKindModifier,
    stringToToken,
    SyntaxKind,
} from "../_namespaces/ts.js";
import type {
    CancellationToken,
    LanguageServiceHost,
    Node,
    Program,
    QuickInfo,
} from "../_namespaces/ts.js";

function tokenizeDisplayParts(display: string): { text: string; kind: string; }[] {
    const claimKeywords = new Set(getRegisteredTSPPSyntaxClaims?.()?.map(c => c.keyword) ?? []);
    const isKeyword = (text: string) => {
        if (claimKeywords.has(text) || text === "constructor") return true;
        const tok = stringToToken(text);
        return tok !== undefined && tok >= SyntaxKind.FirstKeyword && tok <= SyntaxKind.LastKeyword;
    };
    const parts: { text: string; kind: string; }[] = [];
    const regex = /\s+|[(){}[\]:;,.<>=?]|[a-z_$][\w$]*|"[^"]*"|'[^']*'|[^\s(){}[\]:;,.<>=?a-z_$"']+/gi;
    let match: RegExpExecArray | undefined;
    let prev = "";
    while ((match = regex.exec(display) ?? undefined) !== undefined) {
        const text = match[0];
        if (/^\s+$/.test(text)) {
            parts.push({ text, kind: "space" });
        }
        else if (/^[(){}[\]:;,.<>=?]$/.test(text)) {
            parts.push({ text, kind: "punctuation" });
            prev = text;
        }
        else if (isKeyword(text)) {
            parts.push({ text, kind: "keyword" });
            prev = text;
        }
        else if (prev === "class" || prev === "object") {
            parts.push({ text, kind: "className" });
            prev = text;
        }
        else if (prev === ".") {
            parts.push({ text, kind: "methodName" });
            prev = text;
        }
        else {
            parts.push({ text, kind: "text" });
            prev = text;
        }
    }
    return parts.length ? parts : [{ text: display, kind: "text" }];
}

/**
 * Lets a plugin's Quick Info provider replace the upstream Quick Info at a position (TSPP-SLOT(quick-info)).
 * Providers see the authored TS++ text, the token, its type, and the upstream result; the first one that answers wins, starting with the plugins whose syntax contains the position.
 * getNodeForQuickInfo is the language service's choice of node for a touched token.
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
    const contribution = getTSPPQuickInfo(sourceFile, authoredSourceText, position, {
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
        displayParts: tokenizeDisplayParts(contribution.display),
        documentation: contribution.documentation
            ? [{ text: contribution.documentation, kind: "text" }]
            : undefined,
    };
}
