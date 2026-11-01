/** Static editor metadata. Hosts merge these declarations at package time. */
export interface TSPPEditorContribution {
    /** Word-like lexical tokens shared by lightweight editor hosts such as Monaco. */
    readonly keywords?: readonly string[];
    readonly commands?: readonly { readonly id: string; readonly title: string; }[];
    readonly grammars?: readonly string[];
    readonly snippets?: readonly string[];
    readonly configuration?: Readonly<Record<string, unknown>>;
}

export interface TSPPTextSpan {
    readonly start: number;
    readonly length: number;
}

/**
 * Splits an editor decoration into code-only ranges. Whitespace and comments are
 * excluded, while comment-like text inside strings and templates remains code.
 */
export function getCodeDecorationSpans(text: string, span: TSPPTextSpan): TSPPTextSpan[] {
    const start = Math.max(0, Math.min(text.length, span.start));
    const end = Math.max(start, Math.min(text.length, span.start + span.length));
    const result: TSPPTextSpan[] = [];

    const append = (from: number, to: number) => {
        if (to <= from) return;
        const previous = result[result.length - 1];
        if (previous && previous.start + previous.length === from) {
            result[result.length - 1] = { start: previous.start, length: to - previous.start };
        }
        else {
            result.push({ start: from, length: to - from });
        }
    };

    const quoted = (position: number, quote: string) => {
        let cursor = position + 1;
        while (cursor < end) {
            if (text[cursor] === "\\") cursor += 2;
            else if (text[cursor++] === quote) break;
        }
        append(position, Math.min(cursor, end));
        return Math.min(cursor, end);
    };

    const template = (position: number): number => {
        let segmentStart = position;
        let cursor = position + 1;
        while (cursor < end) {
            if (text[cursor] === "\\") {
                cursor += 2;
                continue;
            }
            if (text[cursor] === "`") {
                append(segmentStart, ++cursor);
                return cursor;
            }
            if (text[cursor] === "$" && text[cursor + 1] === "{") {
                cursor += 2;
                append(segmentStart, cursor);
                cursor = normal(cursor, true);
                segmentStart = cursor;
                continue;
            }
            cursor++;
        }
        append(segmentStart, end);
        return end;
    };

    const normal = (position: number, templateExpression = false): number => {
        let cursor = position;
        let braceDepth = 0;
        while (cursor < end) {
            const character = text[cursor];
            if (/\s/u.test(character)) {
                cursor++;
                continue;
            }
            if (character === "/" && text[cursor + 1] === "/") {
                cursor += 2;
                while (cursor < end && text[cursor] !== "\n" && text[cursor] !== "\r") cursor++;
                continue;
            }
            if (character === "/" && text[cursor + 1] === "*") {
                cursor += 2;
                while (cursor < end && !(text[cursor] === "*" && text[cursor + 1] === "/")) cursor++;
                cursor = Math.min(cursor + 2, end);
                continue;
            }
            if (character === "'" || character === '"') {
                cursor = quoted(cursor, character);
                continue;
            }
            if (character === "`") {
                cursor = template(cursor);
                continue;
            }
            if (templateExpression && character === "}") {
                append(cursor, cursor + 1);
                cursor++;
                if (braceDepth === 0) return cursor;
                braceDepth--;
                continue;
            }
            if (templateExpression && character === "{") braceDepth++;

            const tokenStart = cursor++;
            while (cursor < end) {
                const next = text[cursor];
                if (/\s/u.test(next) || next === "'" || next === '"' || next === "`") break;
                if (next === "/" && (text[cursor + 1] === "/" || text[cursor + 1] === "*")) break;
                if (templateExpression && (next === "{" || next === "}")) break;
                cursor++;
            }
            append(tokenStart, cursor);
        }
        return cursor;
    };

    normal(start);
    return result;
}
