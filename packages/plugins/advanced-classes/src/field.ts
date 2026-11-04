import { markGenerated } from "@tspp/plugin-sdk";
import type { TSPPSyntaxCursor, TSPPSyntaxExtension, TSPPTypeScript } from "@tspp/plugin-sdk/compiler";
import type * as TS from "typescript-upstream";

function stripComments(text: string): string {
    return text.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
}

/** Looks backwards from pos to find if pos is enclosed in a getter or setter, traversing nested blocks. */
export function findEnclosingAccessorName(sourceText: string, pos: number): string | undefined {
    let currentPos = pos;
    while (currentPos > 0) {
        const textBefore = sourceText.slice(0, currentPos);
        let depth = 1;
        let bracePos = -1;
        for (let i = textBefore.length - 1; i >= 0; i--) {
            if (textBefore[i] === "}") depth++;
            else if (textBefore[i] === "{") {
                depth--;
                if (depth === 0) {
                    bracePos = i;
                    break;
                }
            }
        }
        if (bracePos < 0) return undefined;
        const header = stripComments(textBefore.slice(0, bracePos)).trimEnd();
        const fieldAccessorMatch = /\b(?:get\s*\(\s*\)|set\s*\([^)]*\))\s*$/.exec(header);
        if (fieldAccessorMatch) {
            const outerBefore = header.slice(0, fieldAccessorMatch.index);
            const outerMatches = [...outerBefore.matchAll(/\bfield\s+([A-Za-z_$][\w$]*)/g)];
            if (outerMatches.length) return outerMatches[outerMatches.length - 1][1];
        }
        const regularAccessorMatch = /\b(?:get|set)\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::\s*[^;{]+)?$/.exec(header);
        if (regularAccessorMatch) {
            return regularAccessorMatch[1];
        }
        if (/\b(?:class|function|interface|namespace)\b\s*[A-Za-z_$][\w$]*\s*$/.test(header)) {
            return undefined;
        }
        currentPos = bracePos;
    }
    return undefined;
}

export function createFieldSyntax(ts: TSPPTypeScript): {
    extension: TSPPSyntaxExtension;
    invalidFieldNodes: WeakSet<TS.Node>;
    getFieldPropertyName: (sourceText: string, pos: number) => string | undefined;
} {
    const kinds = ts.SyntaxKind;
    const invalidFieldNodes = new WeakSet<TS.Node>();

    const range = <T extends TS.Node | TS.NodeArray<TS.Node>>(node: T, pos: number, end: number): T =>
        ts.setTextRange(node, { pos, end });

    function isFieldStart(cursor: TSPPSyntaxCursor): boolean {
        return cursor.tokenText() === "field";
    }

    function parseField(cursor: TSPPSyntaxCursor): TS.Expression {
        const startPos = cursor.getTokenStart();
        const f = cursor.factory;
        const sourceText = cursor.getSourceText();
        const accessorName = findEnclosingAccessorName(sourceText, startPos);

        cursor.nextToken(); // consume 'field'
        const endPos = cursor.getNodePos();

        const backingPropName = accessorName ? `__field_${accessorName}` : "__field_unknown";

        // Lower directly to: this.__field_name (without 'as any', preserving strict types)
        const thisExpr = range(f.createThis(), startPos, endPos);
        const backingIdent = range(f.createIdentifier(backingPropName), startPos, endPos);
        const fieldAccess = range(
            f.createPropertyAccessExpression(
                thisExpr,
                backingIdent,
            ),
            startPos,
            endPos,
        );

        if (!accessorName) {
            invalidFieldNodes.add(fieldAccess);
        }

        return markGenerated(ts, fieldAccess, startPos);
    }

    const extension: TSPPSyntaxExtension = {
        position: "primary-expression",
        startTokens: [kinds.Identifier],
        keywords: ["field"],
        isStart: isFieldStart,
        parse: parseField,
    };

    return {
        extension,
        invalidFieldNodes,
        getFieldPropertyName: (sourceText, pos) => findEnclosingAccessorName(sourceText, pos),
    };
}
