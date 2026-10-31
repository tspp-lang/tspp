import {
    inferMlttType,
    mlttApplication,
    mlttBoolType,
    mlttExternal,
    mlttFalse,
    mlttIdentityType,
    mlttNatAdd,
    mlttNatType,
    mlttPi,
    mlttRefl,
    mlttSuccessor,
    mlttTrue,
    mlttUniverse,
    mlttVariable,
    mlttZero,
    type MlttTerm,
} from "./core";

export interface DependentTypeAlias {
    readonly name: string;
    readonly annotationLevel: number;
    readonly annotationStart: number;
    readonly expression: string;
    readonly expressionStart: number;
    readonly expressionEnd: number;
}

interface Token {
    readonly text: string;
    readonly start: number;
}

const aliasPattern = /\btype\s+([A-Za-z_$][\w$]*)\s*:\s*Type(\d*)\s*=\s*/g;

export function collectDependentTypeAliases(source: string): DependentTypeAlias[] {
    const aliases: DependentTypeAlias[] = [];
    for (let match; (match = aliasPattern.exec(source));) {
        const rawExpressionStart = aliasPattern.lastIndex;
        const expressionEnd = findStatementEnd(source, rawExpressionStart);
        if (expressionEnd < 0) continue;
        const rawExpression = source.slice(rawExpressionStart, expressionEnd);
        const leadingWhitespace = /^\s*/.exec(rawExpression)![0].length;
        const expressionStart = rawExpressionStart + leadingWhitespace;
        aliases.push({
            name: match[1],
            annotationLevel: match[2] === "" ? 0 : Number(match[2]),
            annotationStart: match.index + match[0].indexOf(":"),
            expression: source.slice(expressionStart, expressionEnd).trimEnd(),
            expressionStart,
            expressionEnd,
        });
        aliasPattern.lastIndex = expressionEnd + 1;
    }
    return aliases;
}

export function projectDependentTypes(fileName: string, source: string): string {
    if (!fileName.endsWith(".tspp") && !fileName.endsWith(".d.tspp")) return source;
    const characters = [...source];
    for (const alias of collectDependentTypeAliases(source)) {
        const equals = source.lastIndexOf("=", alias.expressionStart);
        for (let index = alias.annotationStart; index < equals; index++) mask(characters, index);
        const replacement = "any";
        for (let index = alias.expressionStart; index < alias.expressionEnd; index++) mask(characters, index);
        for (let index = 0; index < replacement.length; index++) {
            characters[alias.expressionStart + index] = replacement[index];
        }
    }
    return characters.join("");
}

export function parseDependentType(
    text: string,
    aliases: ReadonlyMap<string, MlttTerm> = new Map(),
): MlttTerm {
    return new Parser(tokenize(text), aliases).parse();
}

export function inferDependentTypeUniverse(term: MlttTerm): number {
    const inferred = inferMlttType(term);
    if (inferred.kind !== "universe") {
        throw new Error("The right-hand side is a term, not a type.");
    }
    return inferred.level;
}

function findStatementEnd(source: string, start: number): number {
    let angle = 0;
    let paren = 0;
    let brace = 0;
    for (let index = start; index < source.length; index++) {
        const char = source[index];
        if (char === "/" && source[index + 1] === "/") {
            const next = source.indexOf("\n", index + 2);
            if (next < 0) return -1;
            index = next;
            continue;
        }
        if (char === "/" && source[index + 1] === "*") {
            const next = source.indexOf("*/", index + 2);
            if (next < 0) return -1;
            index = next + 1;
            continue;
        }
        if (char === "<") angle++;
        else if (char === ">" && source[index - 1] !== "-") angle--;
        else if (char === "(") paren++;
        else if (char === ")") paren--;
        else if (char === "{") brace++;
        else if (char === "}") brace--;
        else if (char === ";" && angle === 0 && paren === 0 && brace === 0) return index;
    }
    return -1;
}

function mask(characters: string[], index: number): void {
    if (characters[index] !== "\n" && characters[index] !== "\r") characters[index] = " ";
}

function tokenize(text: string): Token[] {
    const tokens: Token[] = [];
    for (let index = 0; index < text.length;) {
        if (/\s/.test(text[index])) { index++; continue; }
        if (text.startsWith("->", index)) {
            tokens.push({ text: "->", start: index });
            index += 2;
            continue;
        }
        const identifier = /^[A-Za-z_$][\w$]*/.exec(text.slice(index));
        if (identifier) {
            tokens.push({ text: identifier[0], start: index });
            index += identifier[0].length;
            continue;
        }
        if ("(){}<>,:".includes(text[index])) {
            tokens.push({ text: text[index], start: index++ });
            continue;
        }
        throw new SyntaxError(`Unexpected character '${text[index]}' at offset ${index}.`);
    }
    return tokens;
}

class Parser {
    private position = 0;
    private scope: string[] = [];

    public constructor(
        private readonly tokens: readonly Token[],
        private readonly aliases: ReadonlyMap<string, MlttTerm>,
    ) {}

    public parse(): MlttTerm {
        const term = this.parseTerm();
        if (this.peek()) this.fail(`Unexpected token '${this.peek()!.text}'.`);
        return term;
    }

    private parseTerm(stop?: string): MlttTerm {
        if ((this.at("(") || this.at("{")) && this.isBinder()) {
            const open = this.take().text;
            const close = open === "(" ? ")" : "}";
            const name = this.identifier();
            this.expect(":");
            const domain = this.parseTerm(close);
            this.expect(close);
            this.expect("->");
            this.scope.unshift(name);
            const codomain = this.parseTerm(stop);
            this.scope.shift();
            return mlttPi(name, domain, codomain);
        }
        return this.parseApplication(stop);
    }

    private parseApplication(stop?: string): MlttTerm {
        let term = this.parseAtom(stop);
        while (this.at("<")) {
            this.take();
            if (this.at(">")) this.fail("A type application needs at least one argument.");
            do {
                term = mlttApplication(term, this.parseTerm(this.at(",") ? "," : ">"));
                if (!this.at(",")) break;
                this.take();
            } while (!this.at(">"));
            this.expect(">");
        }
        return term;
    }

    private parseAtom(stop?: string): MlttTerm {
        if (stop && this.at(stop)) this.fail(`Expected a type before '${stop}'.`);
        if (this.at("(")) {
            this.take();
            const term = this.parseTerm(")");
            this.expect(")");
            return term;
        }
        const name = this.identifier();
        const universe = name === "Type" ? 0 : /^Type(0|[1-9]\d*)$/.exec(name);
        if (universe !== null) {
            const level = typeof universe === "number" ? universe : Number(universe[1]);
            if (!Number.isSafeInteger(level)) this.fail(`Universe level '${name}' is too large.`);
            return mlttUniverse(level);
        }
        if (name === "Bool") return mlttBoolType();
        if (name === "True") return mlttTrue();
        if (name === "False") return mlttFalse();
        if (name === "Nat") return mlttNatType();
        if (name === "Zero") return mlttZero();

        const index = this.scope.indexOf(name);
        if (index >= 0) return mlttVariable(index);
        const alias = this.aliases.get(name);
        if (alias) return alias;

        if (this.at("<") && ["Succ", "NatAdd", "Eq", "Refl"].includes(name)) {
            const typeArguments = this.parseArguments();
            if (name === "Succ" && typeArguments.length === 1) return mlttSuccessor(typeArguments[0]);
            if (name === "NatAdd" && typeArguments.length === 2) return mlttNatAdd(typeArguments[0], typeArguments[1]);
            if (name === "Eq" && typeArguments.length === 3) return mlttIdentityType(typeArguments[0], typeArguments[1], typeArguments[2]);
            if (name === "Refl" && typeArguments.length === 2) return mlttRefl(typeArguments[0], typeArguments[1]);
            this.fail(`${name} received the wrong number of arguments.`);
        }

        if (this.at("<")) {
            const typeArguments = this.parseArguments();
            return mlttExternal(
                name,
                `${name}<${typeArguments.map(argument => argument.kind === "external" ? argument.displayName : argument.kind).join(", ")}>`,
                typeArguments,
                mlttUniverse(0),
            );
        }
        return mlttExternal(name, name, [], mlttUniverse(0));
    }

    private parseArguments(): MlttTerm[] {
        this.expect("<");
        const result: MlttTerm[] = [];
        while (!this.at(">")) {
            result.push(this.parseTerm(this.at(",") ? "," : ">"));
            if (!this.at(",")) break;
            this.take();
        }
        this.expect(">");
        return result;
    }

    private isBinder(): boolean {
        let cursor = this.position + 1;
        if (!this.tokens[cursor] || !/^[A-Za-z_$]/.test(this.tokens[cursor].text)) return false;
        cursor++;
        return this.tokens[cursor]?.text === ":";
    }

    private identifier(): string {
        const token = this.take();
        if (!/^[A-Za-z_$]/.test(token.text)) this.fail(`Expected an identifier, found '${token.text}'.`);
        return token.text;
    }

    private at(text: string): boolean {
        return this.peek()?.text === text;
    }

    private expect(text: string): void {
        if (!this.at(text)) this.fail(`Expected '${text}', found '${this.peek()?.text ?? "end of input"}'.`);
        this.take();
    }

    private take(): Token {
        const token = this.tokens[this.position++];
        if (!token) this.fail("Unexpected end of input.");
        return token;
    }

    private peek(): Token | undefined {
        return this.tokens[this.position];
    }

    private fail(message: string): never {
        const offset = this.peek()?.start ?? (this.tokens.length ? this.tokens[this.tokens.length - 1].start : 0);
        throw new SyntaxError(`${message} (offset ${offset})`);
    }
}

