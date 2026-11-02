import type { TSPPTypeScript } from "@tspp/plugin-sdk/compiler";
import type * as TS from "typescript-upstream";

/** A dotted name as written in source, such as `derive` or `codecs.json`. */
export interface MacroEntityName {
    readonly text: string;
    readonly start: number;
    readonly end: number;
    readonly parts: readonly { readonly text: string; readonly start: number; readonly end: number; }[];
}

/** `macro function name` or `macro(options) function name`. */
export interface MacroDeclarationSyntax {
    readonly start: number;
    /** End of `macro` or of its options list, where the `function` declaration continues. */
    readonly prefixEnd: number;
    readonly name: string | undefined;
    readonly nameStart: number | undefined;
    /** The options object as written between the parentheses of `macro(...)`. */
    readonly options: { readonly text: string; readonly start: number; } | undefined;
}

/** `macro name(target, ...);` */
export interface MacroInvocationSyntax {
    readonly start: number;
    readonly end: number;
    readonly macro: MacroEntityName;
    readonly targets: readonly MacroEntityName[];
}

export interface MacroSourceSyntax {
    readonly original: string;
    readonly projected: string;
    readonly declarations: readonly MacroDeclarationSyntax[];
    readonly invocations: readonly MacroInvocationSyntax[];
}

interface Token {
    readonly kind: TS.SyntaxKind;
    readonly start: number;
    readonly end: number;
    readonly text: string;
    readonly lineBreakBefore: boolean;
}

export function isMacroSourceFile(fileName: string): boolean {
    return fileName.endsWith(".tspp");
}

/**
 * Finds macro syntax in a `.tspp` file and projects it onto TypeScript of the same length: `macro` and its options are
 * blanked before `function`, and an invocation `macro m(A, B);` becomes `void [m,A, B];`, which keeps every name at
 * its source position for the first program. The program rebuilder later replaces those statements.
 */
export function scanMacroSource(ts: TSPPTypeScript, original: string): MacroSourceSyntax {
    const tokens = tokenize(ts, original);
    const declarations: MacroDeclarationSyntax[] = [];
    const invocations: MacroInvocationSyntax[] = [];
    const characters = original.split("");
    const blank = (start: number, end: number) => {
        for (let index = start; index < end; index++) {
            if (characters[index] !== "\n" && characters[index] !== "\r") characters[index] = " ";
        }
    };
    const kinds = ts.SyntaxKind;
    for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index];
        if (token.kind !== kinds.Identifier || token.text !== "macro" || !startsMacroSyntax(ts, tokens, index)) continue;
        const declaration = matchDeclaration(ts, original, tokens, index);
        if (declaration) {
            declarations.push(declaration.syntax);
            blank(declaration.syntax.start, declaration.syntax.prefixEnd);
            index = declaration.next - 1;
            continue;
        }
        const invocation = matchInvocation(ts, tokens, index);
        if (!invocation) continue;
        invocations.push(invocation.syntax);
        const { macro } = invocation.syntax;
        blank(token.start, macro.start);
        characters.splice(token.start, 4, ..."void");
        characters[macro.start - 1] = "[";
        characters[invocation.openParen] = ",";
        characters[invocation.closeParen] = "]";
        index = invocation.next - 1;
    }
    return { original, projected: characters.join(""), declarations, invocations };
}

/** `macro` starts a statement or follows declaration modifiers, never continues an expression. */
function startsMacroSyntax(ts: TSPPTypeScript, tokens: readonly Token[], index: number): boolean {
    const kinds = ts.SyntaxKind;
    const previous = tokens[index - 1];
    if (!previous) return true;
    switch (previous.kind) {
        case kinds.SemicolonToken:
        case kinds.OpenBraceToken:
        case kinds.CloseBraceToken:
        case kinds.ColonToken:
        case kinds.ExportKeyword:
        case kinds.DefaultKeyword:
        case kinds.DeclareKeyword:
        case kinds.AsyncKeyword:
            return true;
        case kinds.DotToken:
        case kinds.QuestionDotToken:
        case kinds.CommaToken:
        case kinds.OpenParenToken:
        case kinds.OpenBracketToken:
        case kinds.EqualsToken:
            return false;
        default:
            return tokens[index].lineBreakBefore;
    }
}

function matchDeclaration(ts: TSPPTypeScript, text: string, tokens: readonly Token[], index: number): { syntax: MacroDeclarationSyntax; next: number; } | undefined {
    const kinds = ts.SyntaxKind;
    const keyword = tokens[index];
    let cursor = index + 1;
    let options: MacroDeclarationSyntax["options"];
    let prefixEnd = keyword.end;
    if (tokens[cursor]?.kind === kinds.OpenParenToken) {
        const close = findClosing(ts, tokens, cursor);
        if (close === undefined) return undefined;
        const start = tokens[cursor].end;
        options = { text: text.slice(start, tokens[close].start), start };
        prefixEnd = tokens[close].end;
        cursor = close + 1;
    }
    if (tokens[cursor]?.kind !== kinds.FunctionKeyword) return undefined;
    let nameIndex = cursor + 1;
    if (tokens[nameIndex]?.kind === kinds.AsteriskToken) nameIndex++;
    const name = tokens[nameIndex]?.kind === kinds.Identifier ? tokens[nameIndex] : undefined;
    return {
        syntax: { start: keyword.start, prefixEnd, name: name?.text, nameStart: name?.start, options },
        next: cursor,
    };
}

function matchInvocation(ts: TSPPTypeScript, tokens: readonly Token[], index: number): { syntax: MacroInvocationSyntax; openParen: number; closeParen: number; next: number; } | undefined {
    const kinds = ts.SyntaxKind;
    const keyword = tokens[index];
    const macro = matchEntityName(ts, tokens, index + 1);
    if (!macro || tokens[index + 1].lineBreakBefore) return undefined;
    let cursor = macro.next;
    if (tokens[cursor]?.kind !== kinds.OpenParenToken) return undefined;
    const openParen = tokens[cursor].start;
    cursor++;
    const targets: MacroEntityName[] = [];
    while (tokens[cursor] && tokens[cursor].kind !== kinds.CloseParenToken) {
        const target = matchEntityName(ts, tokens, cursor);
        if (!target) return undefined;
        targets.push(target.name);
        cursor = target.next;
        if (tokens[cursor]?.kind === kinds.CommaToken) cursor++;
        else if (tokens[cursor]?.kind !== kinds.CloseParenToken) return undefined;
    }
    if (!tokens[cursor]) return undefined;
    const closeParen = tokens[cursor].start;
    let end = tokens[cursor].end;
    cursor++;
    if (tokens[cursor]?.kind === kinds.SemicolonToken) {
        end = tokens[cursor].end;
        cursor++;
    }
    return { syntax: { start: keyword.start, end, macro: macro.name, targets }, openParen, closeParen, next: cursor };
}

function matchEntityName(ts: TSPPTypeScript, tokens: readonly Token[], index: number): { name: MacroEntityName; next: number; } | undefined {
    const kinds = ts.SyntaxKind;
    const parts: { text: string; start: number; end: number; }[] = [];
    let cursor = index;
    while (tokens[cursor]?.kind === kinds.Identifier) {
        parts.push({ text: tokens[cursor].text, start: tokens[cursor].start, end: tokens[cursor].end });
        cursor++;
        if (tokens[cursor]?.kind !== kinds.DotToken) break;
        cursor++;
    }
    if (!parts.length || tokens[cursor - 1].kind === kinds.DotToken) return undefined;
    return {
        name: { text: parts.map(part => part.text).join("."), start: parts[0].start, end: parts[parts.length - 1].end, parts },
        next: cursor,
    };
}

function findClosing(ts: TSPPTypeScript, tokens: readonly Token[], open: number): number | undefined {
    const kinds = ts.SyntaxKind;
    let depth = 0;
    for (let index = open; index < tokens.length; index++) {
        const kind = tokens[index].kind;
        if (kind === kinds.OpenParenToken || kind === kinds.OpenBraceToken || kind === kinds.OpenBracketToken) depth++;
        else if (kind === kinds.CloseParenToken || kind === kinds.CloseBraceToken || kind === kinds.CloseBracketToken) {
            depth--;
            if (depth === 0) return kind === kinds.CloseParenToken ? index : undefined;
        }
    }
    return undefined;
}

/** Scans the whole file, following template literals and regular expressions so their contents are not tokens. */
function tokenize(ts: TSPPTypeScript, text: string): Token[] {
    const kinds = ts.SyntaxKind;
    const scanner = ts.createScanner(ts.ScriptTarget.Latest, /*skipTrivia*/ true, ts.LanguageVariant.Standard, text);
    const tokens: Token[] = [];
    const braces: ("brace" | "template")[] = [];
    for (let kind = scanner.scan(); kind !== kinds.EndOfFileToken; kind = scanner.scan()) {
        if (kind === kinds.CloseBraceToken && braces.pop() === "template") kind = scanner.reScanTemplateToken(/*isTaggedTemplate*/ false);
        else if ((kind === kinds.SlashToken || kind === kinds.SlashEqualsToken) && !endsExpression(ts, tokens[tokens.length - 1])) {
            kind = scanner.reScanSlashToken();
        }
        if (kind === kinds.OpenBraceToken) braces.push("brace");
        else if (kind === kinds.TemplateHead || kind === kinds.TemplateMiddle) braces.push("template");
        tokens.push({
            kind,
            start: scanner.getTokenStart(),
            end: scanner.getTokenEnd(),
            text: scanner.getTokenText(),
            lineBreakBefore: scanner.hasPrecedingLineBreak(),
        });
    }
    return tokens;
}

function endsExpression(ts: TSPPTypeScript, token: Token | undefined): boolean {
    if (!token) return false;
    const kinds = ts.SyntaxKind;
    switch (token.kind) {
        case kinds.Identifier:
        case kinds.NumericLiteral:
        case kinds.BigIntLiteral:
        case kinds.StringLiteral:
        case kinds.NoSubstitutionTemplateLiteral:
        case kinds.TemplateTail:
        case kinds.RegularExpressionLiteral:
        case kinds.CloseParenToken:
        case kinds.CloseBracketToken:
        case kinds.CloseBraceToken:
        case kinds.ThisKeyword:
        case kinds.SuperKeyword:
        case kinds.TrueKeyword:
        case kinds.FalseKeyword:
        case kinds.NullKeyword:
            return true;
        default:
            return false;
    }
}

/** The text a `.d.tspp` declaration restores before `function`, such as `macro` or `macro({ timeout: ... })`. */
export function getDeclarationPrefix(syntax: MacroSourceSyntax, declaration: MacroDeclarationSyntax): string {
    return syntax.original.slice(declaration.start, declaration.prefixEnd).replace(/\s+/g, " ");
}
