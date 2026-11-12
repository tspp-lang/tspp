import {
    formatting,
    getLineStartPositionForPosition,
    getTSPPFormattingEdits,
    SemicolonPreference,
    toEditorSettings,
} from "../_namespaces/ts.js";
import type {
    FormatCodeOptions,
    FormatCodeSettings,
    SourceFile,
    TextChange,
} from "../_namespaces/ts.js";
import { hasUnformattableTSPPChildren } from "./syntax.js";

/**
 * The formatter's edits of a TS++ file, made safe for its plugin syntax and joined by the edits plugins make to their
 * own syntax (`getTSPPFormattingEdits`). `range` is the selection; without it, a keystroke formats the lines around
 * its position and anything else the whole file.
 */
export function addTSPPFormatting(
    changes: TextChange[],
    sourceFile: SourceFile,
    options: FormatCodeOptions | FormatCodeSettings,
    range?: { readonly start: number; readonly end: number; },
    keystroke?: { readonly position: number; readonly key: string; },
): TextChange[] {
    const settings = toEditorSettings(options);
    const { start, end } = range ?? (keystroke ? keystrokeRange(sourceFile, keystroke.position, changes) : { start: 0, end: sourceFile.text.length });
    const edits = getTSPPFormattingEdits(sourceFile, changes.map(change => ({ start: change.span.start, length: change.span.length, newText: change.newText })), {
        start,
        end,
        options: {
            indentSize: settings.indentSize ?? 4,
            tabSize: settings.tabSize ?? 4,
            convertTabsToSpaces: settings.convertTabsToSpaces ?? true,
            newLineCharacter: settings.newLineCharacter ?? "\n",
        },
        semicolons: settings.semicolons === SemicolonPreference.Insert || settings.semicolons === SemicolonPreference.Remove,
        key: keystroke?.key,
        isUnformatted: hasUnformattableTSPPChildren,
        // From the structure alone: the lines around plugin syntax may not be laid out yet.
        nodeIndentation: node => formatting.SmartIndenter.getIndentationForNode(node, { pos: 0, end: sourceFile.text.length }, sourceFile, settings),
    });
    return edits.map(edit => ({ span: { start: edit.start, length: edit.length }, newText: edit.newText }));
}

/** From the start of the line before the keystroke to the end of its own line, and wherever the formatter edits. */
function keystrokeRange(sourceFile: SourceFile, position: number, changes: readonly TextChange[]): { start: number; end: number; } {
    const text = sourceFile.text;
    const lineStart = getLineStartPositionForPosition(position, sourceFile);
    let start = lineStart > 0 ? getLineStartPositionForPosition(lineStart - 1, sourceFile) : 0;
    let end = text.indexOf("\n", position);
    if (end < 0) end = text.length;
    for (const change of changes) {
        start = Math.min(start, change.span.start);
        end = Math.max(end, change.span.start + change.span.length);
    }
    return { start, end };
}
