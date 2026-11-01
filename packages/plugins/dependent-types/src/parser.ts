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

export function parseDependentTypeText(
    text: string,
    aliases: ReadonlyMap<string, MlttTerm> = new Map(),
): MlttTerm {
    return new Parser(tokenize(text), aliases).parse();
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

class Parser {
    private position = 0;
    private readonly scope: string[] = [];
    private patternCaptures: string[] | undefined;

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
        if (this.at("typecase")) return this.parseTypeMatch();
        if ((this.at("(") || this.at("{")) && this.isBinder()) return this.parseBinder(stop);
        return this.parseUnion(stop);
    }

    private parseBinder(stop?: string): MlttTerm {
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
        const binder = mlttPi(name, domain, codomain);
        binderModes.set(binder, open === "{" ? "implicit" : "explicit");
        return binder;
    }

    private parseUnion(stop?: string): MlttTerm {
        const terms = [this.parseApplication(stop)];
        const separators: string[] = [];
        while (this.at("|") || this.at("&")) {
            separators.push(this.take().text);
            terms.push(this.parseApplication(stop));
        }
        if (terms.length === 1) return terms[0];
        const displayName = terms.map((term, index) =>
            `${index ? ` ${separators[index - 1]} ` : ""}${display(term)}`).join("");
        return mlttExternal(displayName, displayName, terms, mlttUniverse(0));
    }

    private parseApplication(stop?: string): MlttTerm {
        let term = this.parseAtom(stop);
        while (this.at("<")) {
            const argumentsList = this.parseArguments();
            if (term.kind === "external" && term.arguments.length === 0) {
                term = this.createNamedApplication(term.key, argumentsList);
            }
            else {
                for (const argument of argumentsList) term = mlttApplication(term, argument);
            }
        }
        while (this.at("[") && this.tokens[this.position + 1]?.text === "]") {
            this.take();
            this.take();
            term = mlttExternal(`Array<${display(term)}>`, `${display(term)}[]`, [term], mlttUniverse(0));
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
        const name = this.identifier();
        const universe = /^(?:Type)(0|[1-9]\d*)?$/u.exec(name);
        if (universe) return mlttUniverse(universe[1] === undefined ? 0 : Number(universe[1]));
        if (name === "Bool") return mlttBoolType();
        if (name === "True") return mlttTrue();
        if (name === "False") return mlttFalse();
        if (name === "Nat") return mlttNatType();
        if (name === "Zero") return mlttZero();

        const index = this.scope.indexOf(name);
        if (index >= 0) return mlttVariable(index);
        const alias = this.aliases.get(name);
        if (alias) return alias;
        return mlttExternal(name, name, [], mlttUniverse(0));
    }

    private createNamedApplication(name: string, args: readonly MlttTerm[]): MlttTerm {
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
            case "Lam": {
                count(1);
                const binder = args[0];
                if (binder.kind !== "pi") this.fail("Lam expects a binder expression.");
                return mlttLambda(binder.parameterName, binder.codomain, binder.domain);
            }
            case "Sigma": {
                count(1);
                const binder = args[0];
                if (binder.kind !== "pi") this.fail("Sigma expects a binder expression.");
                return mlttSigma(binder.parameterName, binder.domain, binder.codomain);
            }
            default:
                return mlttExternal(name, `${name}<${args.map(display).join(", ")}>`, args, mlttUniverse(0));
        }
    }

    private parseTypeMatch(): MlttTerm {
        this.expect("typecase");
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
        return !!this.tokens[this.position + 1]
            && /^[A-Za-z_$]/u.test(this.tokens[this.position + 1].text)
            && this.tokens[this.position + 2]?.text === ":";
    }

    private identifier(): string {
        const token = this.take();
        if (!/^[A-Za-z_$]/u.test(token.text)) this.fail(`Expected an identifier, found '${token.text}'.`);
        return token.text;
    }

    private at(text: string): boolean { return this.peek()?.text === text; }
    private expect(text: string): void {
        if (!this.at(text)) this.fail(`Expected '${text}', found '${this.peek()?.text ?? "end of input"}'.`);
        this.take();
    }
    private take(): Token {
        const token = this.tokens[this.position++];
        if (!token) this.fail("Unexpected end of input.");
        return token;
    }
    private peek(): Token | undefined { return this.tokens[this.position]; }
    private fail(message: string): never {
        const offset = this.peek()?.start ?? (this.tokens.length ? this.tokens[this.tokens.length - 1].start : 0);
        throw new SyntaxError(`${message} (offset ${offset})`);
    }
}

function display(term: MlttTerm): string {
    if (term.kind === "external") return term.displayName;
    if (term.kind === "variable") return `$${term.index}`;
    if (term.kind === "universe") return `Type${term.level}`;
    return term.kind;
}
