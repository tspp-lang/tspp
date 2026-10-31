export type Sort = "Bool" | "Int";
export interface Term { readonly smt: string; readonly sort: Sort; }

export interface ExpressionEnvironment {
    readonly variables?: Readonly<Record<string, Sort>>;
    readonly substitutions?: Readonly<Record<string, { readonly smt: string; readonly sort: Sort; }>>;
}

const tokenPattern = /\s*([A-Za-z_$][\w$]*|\d+n?|true|false|===|!==|<=|>=|&&|\|\||[()+\-*<>!])\s*/gy;

export function expressionToSmt(text: string, environment: ExpressionEnvironment = {}): string {
    const result = expressionToSmtTerm(text, environment);
    if (result.sort !== "Bool") throw new Error(`Expected Bool, received ${result.sort}.`);
    return result.smt;
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
        if (/^\d+n?$/.test(token ?? "")) return { smt: token.replace(/n$/, ""), sort: "Int" };
        if (/^[A-Za-z_$][\w$]*$/.test(token ?? "")) {
            const substitution = environment.substitutions?.[token];
            if (substitution) return substitution;
            const sort = environment.variables?.[token];
            if (sort) return { smt: `|${token}|`, sort };
            throw new Error(`Unknown proof variable '${token}'.`);
        }
        throw new Error(`Unsupported token '${token ?? "<end>"}' in proof expression.`);
    };
    const unary = (): Term => {
        if (peek() === "!") { take(); return { smt: `(not ${requireSort(unary(), "Bool").smt})`, sort: "Bool" }; }
        if (peek() === "-") { take(); return { smt: `(- ${requireSort(unary(), "Int").smt})`, sort: "Int" }; }
        return primary();
    };
    const multiply = (): Term => binary(unary, ["*"], (op, left, right) => ({ smt: `(${op} ${requireSort(left, "Int").smt} ${requireSort(right, "Int").smt})`, sort: "Int" }));
    const add = (): Term => binary(multiply, ["+", "-"], (op, left, right) => ({ smt: `(${op} ${requireSort(left, "Int").smt} ${requireSort(right, "Int").smt})`, sort: "Int" }));
    const compare = (): Term => binary(add, ["<", "<=", ">", ">="], (op, left, right) => ({ smt: `(${op} ${requireSort(left, "Int").smt} ${requireSort(right, "Int").smt})`, sort: "Bool" }));
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
