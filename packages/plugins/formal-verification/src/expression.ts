import { ts } from "./host-api";

/** NumberInt is a JavaScript number represented by an SMT integer; Int represents bigint. */
export type Sort = "Bool" | "Int" | "NumberInt" | "Real" | "String";
export const smtSort = (sort: Sort): Exclude<Sort, "NumberInt"> => sort === "NumberInt" ? "Int" : sort;
export const isNumericSort = (sort: Sort): boolean => sort === "Int" || sort === "NumberInt" || sort === "Real";
export interface Term {
    readonly smt: string;
    readonly sort: Sort;
    /** The uncapped length in the same sort, when this term came from String.length. */
    readonly stringLength?: string;
}

/** A signature may widen an integer number to the real model, but never change its JavaScript type. */
export function termForSort(term: Term, sort: Sort, description: string): Term {
    if (term.sort === sort) return term;
    if (term.sort === "NumberInt" && sort === "Real") return { smt: `(to_real ${term.smt})`, sort };
    throw new Error(`${description} must have proof sort ${sort}, received ${term.sort}.`);
}

export function stringTerm(value: string): Term {
    let smt = '"';
    // Z3 accepts escapes for lone surrogates, so every JavaScript UTF-16 unit can be one SMT character.
    for (let index = 0; index < value.length; index++) {
        const unit = value.charCodeAt(index);
        if (unit === 0x22) smt += '""';
        else if (unit === 0x5c || unit < 0x20 || unit > 0x7e) smt += `\\u{${unit.toString(16)}}`;
        else smt += value[index];
    }
    return { smt: `${smt}"`, sort: "String" };
}

export function stringLengthTerm(value: Term, numberSort: "NumberInt" | "Real" = "NumberInt"): Term {
    if (value.sort !== "String") throw new Error("Proof property '.length' requires a string.");
    const units = `(str.len ${value.smt})`;
    const length = numberSort === "Real" ? `(to_real ${units})` : units;
    // SMT strings can be longer than JavaScript permits. Keep length exact throughout the JavaScript domain.
    const max = Number.MAX_SAFE_INTEGER;
    return { smt: `(ite (<= ${length} ${max}) ${length} ${max})`, sort: numberSort, stringLength: length };
}

export function strictlyLessThan(left: Term, right: Term): string {
    if (right.stringLength === undefined) return `(< ${left.smt} ${right.smt})`;
    // Compare against both bounds of min(length, MAX), so arithmetic proofs need not unfold string operations.
    return `(and (< ${left.smt} ${Number.MAX_SAFE_INTEGER}) (< ${left.smt} ${right.stringLength}))`;
}

/** JavaScript strict equality distinguishes bigint from both number models, even when their SMT sorts coincide. */
export function strictEquality(left: Term, right: Term): string {
    if (isNumericSort(left.sort) && isNumericSort(right.sort)) {
        if ((left.sort === "Int") !== (right.sort === "Int")) return "false";
        if (left.sort !== right.sort) {
            const real = (term: Term) => term.sort === "Real" ? term.smt : `(to_real ${term.smt})`;
            return `(= ${real(left)} ${real(right)})`;
        }
    }
    if (left.sort !== right.sort) throw new Error("Both sides of equality must have the same proof sort.");
    return `(= ${left.smt} ${right.smt})`;
}

export interface ExpressionEnvironment {
    readonly variables?: Readonly<Record<string, Sort>>;
    readonly substitutions?: Readonly<Record<string, Term>>;
    readonly defaultNumberSort?: "NumberInt" | "Real";
    readonly functions?: Readonly<Record<string, { readonly parameters: readonly Sort[]; readonly result: Sort; }>>;
}

/** An ECMAScript identifier, which may also be a private name such as `#count`. */
export const identifierSource = String.raw`#?[\p{ID_Start}_$][\p{ID_Continue}$\u200C\u200D]*`;

const tokenPattern = new RegExp(String.raw`\s*(${identifierSource}|\d+(?:\.\d+)?n?|"(?:\\(?:\r\n|[\s\S])|[^"\\])*"|'(?:\\(?:\r\n|[\s\S])|[^'\\])*'|===|!==|<=|>=|&&|\|\||[().,+\-*\/%<>!])\s*`, "gyu");
const identifierPattern = new RegExp(String.raw`^${identifierSource}$`, "u");

function proofStringLiteral(token: string): Term {
    const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, token, () => {
        throw new Error(`Invalid proof string literal '${token}'.`);
    });
    scanner.scan();
    return stringTerm(scanner.getTokenValue());
}

export function expressionToSmtTerm(text: string, environment: ExpressionEnvironment = {}): Term {
    const tokens: string[] = [];
    let offset = 0;
    while (offset < text.length) {
        tokenPattern.lastIndex = offset;
        const match = tokenPattern.exec(text);
        if (!match || match.index !== offset) throw new Error(`Unsupported proof expression near '${text.slice(offset)}'.`);
        tokens.push(match[1]);
        offset = tokenPattern.lastIndex;
    }
    let index = 0;
    const peek = () => tokens[index];
    const take = () => tokens[index++];
    const requireSort = (term: Term, sort: Sort) => {
        if (term.sort !== sort) throw new Error(`Expected ${sort}, received ${term.sort}.`);
        return term;
    };
    const binding = (name: string): Term | undefined => {
        const substitution = environment.substitutions?.[name];
        if (substitution) return substitution;
        const sort = environment.variables?.[name];
        return sort && { smt: `|${name}|`, sort };
    };
    const lengthOf = (value: Term) => stringLengthTerm(value, environment.defaultNumberSort);
    const binary = (next: () => Term, operators: readonly string[], emit: (operator: string, left: Term, right: Term) => Term): Term => {
        let left = next();
        while (operators.includes(peek())) left = emit(take(), left, next());
        return left;
    };
    const primary = (): Term => {
        let token = take();
        if (token === "(") {
            const term = or();
            if (take() !== ")") throw new Error("Expected ')' in proof expression.");
            return term;
        }
        if (token === "true" || token === "false") return { smt: token, sort: "Bool" };
        if (/^\d+(?:\.\d+)?n?$/.test(token ?? "")) {
            const explicitBigInt = token.endsWith("n");
            const decimal = token.includes(".");
            return { smt: token.replace(/n$/, ""), sort: explicitBigInt ? "Int" : decimal ? "Real" : environment.defaultNumberSort ?? "NumberInt" };
        }
        if (/^["']/.test(token ?? "")) return proofStringLiteral(token);
        if (identifierPattern.test(token ?? "")) {
            while (peek() === "." && identifierPattern.test(tokens[index + 1] ?? "")) {
                take();
                token += `.${take()}`;
            }
            const value = binding(token);
            if (value) return value;
            const signature = environment.functions?.[token];
            if (signature && peek() === "(") {
                take();
                const arguments_: Term[] = [];
                while (peek() !== ")") {
                    arguments_.push(or());
                    if (peek() !== ",") break;
                    take();
                }
                if (take() !== ")") throw new Error(`Expected ')' after '${token}' arguments.`);
                if (arguments_.length !== signature.parameters.length) throw new Error(`'${token}' expects ${signature.parameters.length} arguments.`);
                signature.parameters.forEach((expected, position) => {
                    if (arguments_[position].sort !== expected) throw new Error(`Argument ${position + 1} of '${token}' must be ${expected}.`);
                });
                return { smt: `(|${token}|${arguments_.length ? ` ${arguments_.map(argument => argument.smt).join(" ")}` : ""})`, sort: signature.result };
            }
            if (token.endsWith(".length")) {
                const receiver = binding(token.slice(0, -".length".length));
                if (receiver) return lengthOf(receiver);
            }
            throw new Error(`Unknown proof variable '${token}'.`);
        }
        throw new Error(`Unsupported token '${token ?? "<end>"}' in proof expression.`);
    };
    const unary = (): Term => {
        if (peek() === "!") { take(); return { smt: `(not ${requireSort(unary(), "Bool").smt})`, sort: "Bool" }; }
        if (peek() === "-") {
            take();
            const term = unary();
            if (!isNumericSort(term.sort)) throw new Error(`Expected numeric sort, received ${term.sort}.`);
            return { smt: `(- ${term.smt})`, sort: term.sort };
        }
        const term = primary();
        if (peek() === "." && tokens[index + 1] === "length") {
            take();
            take();
            return lengthOf(term);
        }
        return term;
    };
    const multiply = (): Term => binary(unary, ["*", "/", "%"], (op, left, right) => {
        if (left.sort !== right.sort || !isNumericSort(left.sort)) throw new Error("Arithmetic operands must have the same numeric sort.");
        if (op === "%" && left.sort === "Real") throw new Error("Remainder requires the integer model.");
        const symbol = op === "/" && left.sort !== "Real" ? "tspp.js.trunc.div" : op === "%" ? "tspp.js.trunc.rem" : op;
        return { smt: `(${symbol} ${left.smt} ${right.smt})`, sort: left.sort };
    });
    const add = (): Term => binary(multiply, ["+", "-"], (op, left, right) => {
        if (left.sort !== right.sort || !isNumericSort(left.sort)) throw new Error("Arithmetic operands must have the same numeric sort.");
        return { smt: `(${op} ${left.smt} ${right.smt})`, sort: left.sort };
    });
    const compare = (): Term => binary(add, ["<", "<=", ">", ">="], (op, left, right) => {
        if (!isNumericSort(left.sort) || !isNumericSort(right.sort)) throw new Error("Comparison operands must have numeric sorts.");
        return { smt: op === "<" ? strictlyLessThan(left, right) : `(${op} ${left.smt} ${right.smt})`, sort: "Bool" };
    });
    const equality = (): Term => binary(compare, ["===", "!=="], (op, left, right) => {
        const equal = strictEquality(left, right);
        return { smt: op === "===" ? equal : `(not ${equal})`, sort: "Bool" };
    });
    const and = (): Term => binary(equality, ["&&"], (_op, left, right) => ({ smt: `(and ${requireSort(left, "Bool").smt} ${requireSort(right, "Bool").smt})`, sort: "Bool" }));
    const or = (): Term => binary(and, ["||"], (_op, left, right) => ({ smt: `(or ${requireSort(left, "Bool").smt} ${requireSort(right, "Bool").smt})`, sort: "Bool" }));
    const result = or();
    if (index !== tokens.length) throw new Error(`Unexpected token '${peek()}' in proof expression.`);
    return result;
}
