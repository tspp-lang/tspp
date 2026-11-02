import {
    mlttAnnotation,
    mlttApplication,
    mlttBoolElim,
    mlttBoolType,
    mlttExternal,
    mlttFalse,
    mlttFirst,
    mlttIdentityElim,
    mlttIdentityType,
    mlttLambda,
    mlttNatAdd,
    mlttNatElim,
    mlttNatType,
    mlttPair,
    mlttPi,
    mlttRefl,
    mlttSecond,
    mlttSigma,
    mlttSuccessor,
    mlttTrue,
    mlttTypeMatch,
    mlttUniverse,
    mlttVariable,
    mlttZero,
    type MlttTerm,
    type MlttTypeMatchCase,
} from "./core";

interface Token {
    readonly text: string;
    readonly start: number;
}

const binderModes = new WeakMap<MlttTerm, "explicit" | "implicit">();

export function getDependentBinderMode(term: MlttTerm): "explicit" | "implicit" | undefined {
    return binderModes.get(term);
}

/** The tokens a term is parsed from: the text of a term, or the compiler's parser at plugin syntax. */
export interface TermTokens {
    /** The text of the token `offset` tokens ahead; undefined at the end of the input. */
    peek(offset?: number): string | undefined;
    next(): void;
    /** Where the current token starts, for messages. */
    position(): number;
}

/** Where a name embedded in a term is written, kept as its `identity`, so that TypeScript's errors can point at it. */
export interface TermLocation {
    readonly start: number;
    readonly end: number;
}

export interface TermParserOptions {
    /** Earlier aliases of the file, by name, which are inlined. */
    readonly aliases?: ReadonlyMap<string, MlttTerm>;
    /** Names the file declares itself, which are ordinary types even if they spell a built-in term. */
    readonly shadowed?: ReadonlySet<string>;
}

export function parseDependentTypeText(
    text: string,
    aliases: ReadonlyMap<string, MlttTerm> = new Map(),
): MlttTerm {
    return new TermParser(textTokens(text), { aliases }).parse();
}

function textTokens(text: string): TermTokens {
    const tokens = tokenize(text);
    let index = 0;
    return {
        peek: (offset = 0) => tokens[index + offset]?.text,
        next: () => void index++,
        position: () => tokens[index]?.start ?? (tokens.length ? tokens[tokens.length - 1].start : 0),
    };
}

function tokenize(text: string): Token[] {
    const tokens: Token[] = [];
    for (let index = 0; index < text.length;) {
        if (/\s/u.test(text[index])) {
            index++;
            continue;
        }
        if (text.startsWith("->", index) || text.startsWith("=>", index)) {
            tokens.push({ text: text.slice(index, index + 2), start: index });
            index += 2;
            continue;
        }
        const identifier = /^[A-Za-z_$][\w$]*/u.exec(text.slice(index));
        if (identifier) {
            tokens.push({ text: identifier[0], start: index });
            index += identifier[0].length;
            continue;
        }
        const literal = /^(?:\d+(?:\.\d+)?|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/u.exec(text.slice(index));
        if (literal) {
            tokens.push({ text: literal[0], start: index });
            index += literal[0].length;
            continue;
        }
        if ("(){}<>,:|&[]?".includes(text[index])) {
            tokens.push({ text: text[index], start: index++ });
            continue;
        }
        throw new SyntaxError(`Unexpected character '${text[index]}' at offset ${index}.`);
    }
    return tokens;
}

const atomTerms: Readonly<Record<string, () => MlttTerm>> = {
    Bool: mlttBoolType, True: mlttTrue, False: mlttFalse, Nat: mlttNatType, Zero: mlttZero,
};
const appliedTerms = new Set(["Succ", "NatAdd", "BoolElim", "If", "NatElim", "Eq", "Refl", "J", "Pair", "First", "Second", "Ann", "Sigma"]);

/** The built-in terms: `Nat` and the like on their own, and `Succ` and the like when applied. */
export const builtinTermNames: readonly string[] = [...Object.keys(atomTerms), ...appliedTerms];

/** Whether `name`, followed by `next`, starts a built-in term. */
export function startsBuiltinTerm(name: string, next: string | undefined): boolean {
    return name in atomTerms || appliedTerms.has(name) && next === "<";
}

export class TermParser {
    private readonly scope: string[] = [];
    private patternCaptures: string[] | undefined;
    private readonly aliases: ReadonlyMap<string, MlttTerm>;
    private readonly shadowed: ReadonlySet<string>;

    public constructor(private readonly tokens: TermTokens, options: TermParserOptions = {}) {
        this.aliases = options.aliases ?? new Map();
        this.shadowed = options.shadowed ?? new Set();
    }

    public parse(): MlttTerm {
        const term = this.parseTerm();
        if (this.peek()) this.fail(`Unexpected token '${this.peek()}'.`);
        return term;
    }

    /** Parses one term and leaves the tokens after it, for the compiler's parser to go on from. */
    public parseOne(): MlttTerm {
        return this.parseTerm();
    }

    private parseTerm(stop?: string): MlttTerm {
        if (this.at("match")) return this.parseTypeMatch();
        if (this.at("<")) return this.parseLambda(stop);
        if ((this.at("(") || this.at("{")) && this.isBinder()) return this.parseBinder(stop);
        const term = this.parseUnion(stop);
        if (!this.at("=>")) return term;
        // `A => B` is `(_: A) -> B`; the name stays out of the scope, since nothing can refer to it.
        this.take();
        this.scope.unshift("");
        const codomain = this.parseTerm(stop);
        this.scope.shift();
        return mlttPi("_", term, codomain);
    }

    /** `<x: A, y: B> =>> body`; a parameter without a kind is an ordinary type, as it is in any type constructor. */
    private parseLambda(stop?: string): MlttTerm {
        this.expect("<");
        const parameters: { readonly name: string; readonly type: MlttTerm; }[] = [];
        while (!this.at(">")) {
            const name = this.identifier();
            let type: MlttTerm = mlttUniverse(0);
            if (this.at(":")) {
                this.take();
                type = this.parseTerm(">");
            }
            parameters.push({ name, type });
            this.scope.unshift(name);
            if (!this.at(",")) break;
            this.take();
        }
        this.expect(">");
        this.expect("=>");
        this.expect(">");
        const body = this.parseTerm(stop);
        for (let index = 0; index < parameters.length; index++) this.scope.shift();
        return parameters.reduceRight<MlttTerm>((result, parameter) => mlttLambda(parameter.name, result, parameter.type), body);
    }

    private parseBinder(stop?: string): MlttTerm {
        const open = this.take();
        const close = open === "(" ? ")" : "}";
        const name = this.identifier();
        this.expect(":");
        const domain = this.parseTerm(close);
        this.expect(close);
        this.expect("->");
        this.scope.unshift(name);
        const codomain = this.parseTerm(stop);
        this.scope.shift();
        const binder = mlttPi(name, domain, codomain);
        binderModes.set(binder, open === "{" ? "implicit" : "explicit");
        return binder;
    }

    private parseUnion(stop?: string): MlttTerm {
        const terms = [this.parseApplication(stop)];
        const separators: string[] = [];
        while (this.at("|") || this.at("&")) {
            separators.push(this.take());
            terms.push(this.parseApplication(stop));
        }
        if (terms.length === 1) return terms[0];
        const displayName = terms.map((term, index) =>
            `${index ? ` ${separators[index - 1]} ` : ""}${display(term)}`).join("");
        return mlttExternal(unionKey(separators), displayName, terms, mlttUniverse(0));
    }

    private parseApplication(stop?: string): MlttTerm {
        let term = this.parseAtom(stop);
        while (this.at("<")) {
            const argumentsList = this.parseArguments();
            if (term.kind === "external" && term.arguments.length === 0) {
                term = this.createNamedApplication(term.key, argumentsList, term.identity as TermLocation | undefined);
            }
            else {
                for (const argument of argumentsList) term = mlttApplication(term, argument);
            }
        }
        while (this.at("[") && this.tokens.peek(1) === "]") {
            this.take();
            this.take();
            term = mlttExternal("Array", `${display(term)}[]`, [term], mlttUniverse(0));
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
        if (this.at("infer")) {
            if (!this.patternCaptures) this.fail("'infer' is only valid in a type-match pattern.");
            this.take();
            const name = this.identifier();
            this.patternCaptures.unshift(name);
            this.scope.unshift(name);
            return mlttVariable(0);
        }
        if (/^["'\d]/u.test(this.peek() ?? "")) {
            const literal = this.take();
            return mlttExternal(literal, literal, [], mlttUniverse(0));
        }
        const start = this.tokens.position();
        const name = this.identifier();
        const location: TermLocation = { start, end: start + name.length };
        const universe = /^(?:Type)(0|[1-9]\d*)?$/u.exec(name);
        if (universe) return mlttUniverse(universe[1] === undefined ? 0 : Number(universe[1]));
        const index = this.scope.indexOf(name);
        if (index >= 0) return mlttVariable(index);
        const alias = this.aliases.get(name);
        if (alias) return alias;
        if (name in atomTerms && !this.shadowed.has(name)) return atomTerms[name]();
        return mlttExternal(name, name, [], mlttUniverse(0), location);
    }

    private createNamedApplication(name: string, args: readonly MlttTerm[], location?: TermLocation): MlttTerm {
        if (this.shadowed.has(name)) return mlttExternal(name, `${name}<${args.map(display).join(", ")}>`, args, mlttUniverse(0), location);
        const count = (expected: number): void => {
            if (args.length !== expected) this.fail(`${name} expects ${expected} type arguments, received ${args.length}.`);
        };
        switch (name) {
            case "Succ": count(1); return mlttSuccessor(args[0]);
            case "NatAdd": count(2); return mlttNatAdd(args[0], args[1]);
            case "BoolElim": count(4); return mlttBoolElim(args[0], args[1], args[2], args[3]);
            case "If": count(4); return mlttBoolElim(args[1], args[2], args[3], args[0]);
            case "NatElim": count(4); return mlttNatElim(args[0], args[1], args[2], args[3]);
            case "Eq": count(3); return mlttIdentityType(args[0], args[1], args[2]);
            case "Refl": count(2); return mlttRefl(args[0], args[1]);
            case "J": count(6); return mlttIdentityElim(args[0], args[1], args[2], args[3], args[4], args[5]);
            case "Pair": count(3); return mlttPair(args[0], args[1], args[2]);
            case "First": count(1); return mlttFirst(args[0]);
            case "Second": count(1); return mlttSecond(args[0]);
            case "Ann": count(2); return mlttAnnotation(args[0], args[1]);
            case "Sigma": {
                count(1);
                const binder = args[0];
                if (binder.kind !== "pi") this.fail("Sigma expects a binder expression.");
                return mlttSigma(binder.parameterName, binder.domain, binder.codomain);
            }
            default:
                return mlttExternal(name, `${name}<${args.map(display).join(", ")}>`, args, mlttUniverse(0), location);
        }
    }

    private parseTypeMatch(): MlttTerm {
        this.expect("match");
        const scrutinee = this.parseTerm("{");
        this.expect("{");
        const cases: MlttTypeMatchCase[] = [];
        let defaultCase: MlttTerm | undefined;
        while (!this.at("}")) {
            // Arms match in source order, so an arm after `_` could never be selected.
            if (defaultCase) this.fail("The '_' default arm must be the last arm of a type match.");
            if (this.at("_")) {
                this.take();
                this.expect(":");
                defaultCase = this.parseTerm(this.at(",") ? "," : "}");
            }
            else {
                const captures: string[] = [];
                this.patternCaptures = captures;
                const pattern = this.parseTerm(":");
                this.patternCaptures = undefined;
                this.expect(":");
                const result = this.parseTerm(this.at(",") ? "," : "}");
                cases.push({
                    pattern,
                    captures: captures.map(name => ({ name, type: mlttUniverse(0) })),
                    result,
                });
                for (let index = 0; index < captures.length; index++) this.scope.shift();
            }
            if (this.at(",")) this.take();
            else if (!this.at("}")) this.fail("Expected ',' or '}' after a type-match arm.");
        }
        this.expect("}");
        if (!defaultCase) this.fail("A type match must end with an '_' default arm.");
        return mlttTypeMatch(scrutinee, cases, defaultCase);
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
        return /^[A-Za-z_$]/u.test(this.tokens.peek(1) ?? "") && this.tokens.peek(2) === ":";
    }

    private identifier(): string {
        const token = this.take();
        if (!/^[A-Za-z_$]/u.test(token)) this.fail(`Expected an identifier, found '${token}'.`);
        return token;
    }

    private at(text: string): boolean { return this.peek() === text; }
    private expect(text: string): void {
        if (!this.at(text)) this.fail(`Expected '${text}', found '${this.peek() ?? "end of input"}'.`);
        this.take();
    }
    private take(): string {
        const token = this.tokens.peek();
        if (token === undefined) this.fail("Unexpected end of input.");
        this.tokens.next();
        return token;
    }
    private peek(): string | undefined { return this.tokens.peek(); }
    private fail(message: string): never {
        throw new SyntaxError(`${message} (offset ${this.tokens.position()})`);
    }
}

/** The key of a union or intersection: its separators, which the lowering reads back. */
function unionKey(separators: readonly string[]): string {
    return `${unionKeyPrefix}${separators.join("")}`;
}

export const unionKeyPrefix = "union:";

function display(term: MlttTerm): string {
    if (term.kind === "external") return term.displayName;
    if (term.kind === "variable") return `$${term.index}`;
    if (term.kind === "universe") return `Type${term.level}`;
    return term.kind;
}
