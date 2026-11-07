export type Sort = "Bool" | "Int" | "Real" | "String";
export interface Term { readonly smt: string; readonly sort: Sort; }

export interface ExpressionEnvironment {
    readonly variables?: Readonly<Record<string, Sort>>;
    readonly substitutions?: Readonly<Record<string, { readonly smt: string; readonly sort: Sort; }>>;
    readonly defaultNumberSort?: "Int" | "Real";
    readonly functions?: Readonly<Record<string, { readonly parameters: readonly Sort[]; readonly result: Sort; }>>;
}

/** An ECMAScript identifier, which may also be a private name such as `#count`. */
export const identifierSource = String.raw`#?[\p{ID_Start}_$][\p{ID_Continue}$\u200C\u200D]*`;

const tokenPattern = new RegExp(String.raw`\s*(${identifierSource}(?:\.${identifierSource})*|\d+(?:\.\d+)?n?|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|true|false|===|!==|<=|>=|&&|\|\||[(),+\-*\/%<>!])\s*`, "gyu");
const qualifiedNamePattern = new RegExp(String.raw`^${identifierSource}(?:\.${identifierSource})*$`, "u");

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
    const binary = (next: () => Term, operators: readonly string[], emit: (operator: string, left: Term, right: Term) => Term): Term => {
        let left = next();
        while (operators.includes(peek())) left = emit(take(), left, next());
        return left;
    };
    const primary = (): Term => {
        const token = take();
        if (token === "(") {
            const term = or();
            if (take() !== ")") throw new Error("Expected ')' in proof expression.");
            return term;
        }
        if (token === "true" || token === "false") return { smt: token, sort: "Bool" };
        if (/^\d+(?:\.\d+)?n?$/.test(token ?? "")) {
            const explicitBigInt = token.endsWith("n");
            const decimal = token.includes(".");
            return { smt: token.replace(/n$/, ""), sort: explicitBigInt ? "Int" : decimal ? "Real" : environment.defaultNumberSort ?? "Int" };
        }
        if (/^["']/.test(token ?? "")) {
            const value = JSON.parse(token.startsWith("'") ? `"${token.slice(1, -1).replace(/"/g, '\\"')}"` : token);
            return { smt: `"${String(value).replace(/"/g, '""')}"`, sort: "String" };
        }
        if (qualifiedNamePattern.test(token ?? "")) {
            const substitution = environment.substitutions?.[token];
            if (substitution) return substitution;
            const sort = environment.variables?.[token];
            if (sort) return { smt: `|${token}|`, sort };
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
            throw new Error(`Unknown proof variable '${token}'.`);
        }
        throw new Error(`Unsupported token '${token ?? "<end>"}' in proof expression.`);
    };
    const unary = (): Term => {
        if (peek() === "!") { take(); return { smt: `(not ${requireSort(unary(), "Bool").smt})`, sort: "Bool" }; }
        if (peek() === "-") {
            take();
            const term = unary();
            if (term.sort !== "Int" && term.sort !== "Real") throw new Error(`Expected numeric sort, received ${term.sort}.`);
            return { smt: `(- ${term.smt})`, sort: term.sort };
        }
        return primary();
    };
    const multiply = (): Term => binary(unary, ["*", "/", "%"], (op, left, right) => {
        if (left.sort !== right.sort || (left.sort !== "Int" && left.sort !== "Real")) throw new Error("Arithmetic operands must have the same numeric sort.");
        if (op === "%" && left.sort !== "Int") throw new Error("Remainder requires the integer model.");
        const symbol = op === "/" && left.sort === "Int" ? "tspp.js.trunc.div" : op === "%" ? "tspp.js.trunc.rem" : op;
        return { smt: `(${symbol} ${left.smt} ${right.smt})`, sort: left.sort };
    });
    const add = (): Term => binary(multiply, ["+", "-"], (op, left, right) => {
        if (left.sort !== right.sort || (left.sort !== "Int" && left.sort !== "Real")) throw new Error("Arithmetic operands must have the same numeric sort.");
        return { smt: `(${op} ${left.smt} ${right.smt})`, sort: left.sort };
    });
    const compare = (): Term => binary(add, ["<", "<=", ">", ">="], (op, left, right) => {
        if (left.sort !== right.sort || (left.sort !== "Int" && left.sort !== "Real")) throw new Error("Comparison operands must have the same numeric sort.");
        return { smt: `(${op} ${left.smt} ${right.smt})`, sort: "Bool" };
    });
    const equality = (): Term => binary(compare, ["===", "!=="], (op, left, right) => {
        if (left.sort !== right.sort) throw new Error("Both sides of equality must have the same proof sort.");
        const equal = `(= ${left.smt} ${right.smt})`;
        return { smt: op === "===" ? equal : `(not ${equal})`, sort: "Bool" };
    });
    const and = (): Term => binary(equality, ["&&"], (_op, left, right) => ({ smt: `(and ${requireSort(left, "Bool").smt} ${requireSort(right, "Bool").smt})`, sort: "Bool" }));
    const or = (): Term => binary(and, ["||"], (_op, left, right) => ({ smt: `(or ${requireSort(left, "Bool").smt} ${requireSort(right, "Bool").smt})`, sort: "Bool" }));
    const result = or();
    if (index !== tokens.length) throw new Error(`Unexpected token '${peek()}' in proof expression.`);
    return result;
}
