import { normalizeMlttTerm, type MlttTerm } from "./core";
import { getDependentBinderMode } from "./parser";

interface Binder {
    readonly name: string;
    readonly domain: MlttTerm;
    readonly mode: "explicit" | "implicit";
}

export function projectMlttTermToTypeScript(term: MlttTerm): string {
    return render(term, []);
}

function render(term: MlttTerm, scope: readonly string[]): string {
    switch (term.kind) {
        case "universe": return "unknown";
        case "bool-type": return "boolean";
        case "true": return "true";
        case "false": return "false";
        case "nat-type": return "number";
        case "zero": return "0";
        case "successor": return renderNatural(term) ?? "number";
        case "nat-add": return renderNatural(term) ?? "number";
        case "variable": return scope[term.index] ?? "unknown";
        case "external": return renderExternal(term, scope);
        case "pi": return renderFunction(term, scope);
        case "bool-elim": {
            const subject = render(term.scrutinee, scope);
            return `${subject} extends true?${render(term.trueCase, scope)}:${render(term.falseCase, scope)}`;
        }
        case "type-match": return renderTypeMatch(term, scope);
        case "identity-type": return `Readonly<{type:${render(term.type, scope)},left:${render(term.left, scope)},right:${render(term.right, scope)} }>`;
        case "refl": return render(term.term, scope);
        case "sigma": return `readonly [${render(term.domain, scope)},unknown]`;
        case "pair": return `readonly [${render(term.first, scope)},${render(term.second, scope)}]`;
        case "first": return `${render(term.pair, scope)}[0]`;
        case "second": return `${render(term.pair, scope)}[1]`;
        case "annotation": return render(term.term, scope);
        case "application": return renderReduced(term, scope);
        case "lambda": return "unknown";
        case "nat-elim":
        case "identity-elim": return renderReduced(term, scope);
    }
}

function renderFunction(term: Extract<MlttTerm, { kind: "pi"; }>, outerScope: readonly string[]): string {
    const binders: Binder[] = [];
    let result: MlttTerm = term;
    while (result.kind === "pi") {
        binders.push({
            name: uniqueName(result.parameterName, binders.map(binder => binder.name)),
            domain: result.domain,
            mode: getDependentBinderMode(result) ?? "explicit",
        });
        result = result.codomain;
    }

    const scope = [...outerScope];
    const typeParameters: string[] = [];
    const parameters: string[] = [];
    for (let index = 0; index < binders.length; index++) {
        const binder = binders[index];
        const domain = render(binder.domain, scope);
        const dependent = binder.mode === "implicit" || isReferencedByRemainder(binders, result, index);
        if (dependent) {
            const constraint = domain === "unknown" ? "" : ` extends ${domain}`;
            typeParameters.push(`${binder.name}${constraint}`);
        }
        if (binder.mode === "explicit") {
            parameters.push(`${binder.name}:${dependent ? binder.name : domain}`);
        }
        scope.unshift(binder.name);
    }
    const generics = typeParameters.length ? `<${typeParameters.join(",")}>` : "";
    return `${generics}(${parameters.join(",")})=>${render(result, scope)}`;
}

function renderExternal(term: Extract<MlttTerm, { kind: "external"; }>, scope: readonly string[]): string {
    if (!term.arguments.length) return term.displayName;
    if (term.key.startsWith("Array<") && term.arguments.length === 1) {
        return `Array<${render(term.arguments[0], scope)}>`;
    }
    return `${term.key}<${term.arguments.map(argument => render(argument, scope)).join(",")}>`;
}

function renderTypeMatch(term: Extract<MlttTerm, { kind: "type-match"; }>, scope: readonly string[]): string {
    const subject = render(term.scrutinee, scope);
    let result = render(term.defaultCase, scope);
    for (let index = term.cases.length - 1; index >= 0; index--) {
        const matchCase = term.cases[index];
        const captureNames = matchCase.captures?.map(capture => capture.name) ?? [];
        const pattern = renderPattern(matchCase.pattern, captureNames, scope);
        const branchScope = [...captureNames, ...scope];
        const branch = render(matchCase.result, branchScope);
        result = `[${subject}] extends [${pattern}]?[${pattern}] extends [${subject}]?${branch}:${result}:${result}`;
    }
    return result;
}

function renderPattern(term: MlttTerm, captures: readonly string[], scope: readonly string[]): string {
    if (term.kind === "variable" && term.index < captures.length) return `infer ${captures[term.index]}`;
    if (term.kind === "external" && term.arguments.length) {
        return `${term.key}<${term.arguments.map(argument => renderPattern(argument, captures, scope)).join(",")}>`;
    }
    return render(term, [...captures, ...scope]);
}

function renderNatural(term: MlttTerm): string | undefined {
    const normalized = normalizeSafely(term);
    let current = normalized;
    let value = 0;
    while (current.kind === "successor") {
        value++;
        current = current.predecessor;
    }
    return current.kind === "zero" ? String(value) : undefined;
}

function normalizeSafely(term: MlttTerm): MlttTerm {
    try {
        return normalizeMlttTerm(term);
    }
    catch {
        return term;
    }
}

function renderReduced(term: MlttTerm, scope: readonly string[]): string {
    const normalized = normalizeSafely(term);
    return normalized === term ? "unknown" : render(normalized, scope);
}

function uniqueName(preferred: string, existing: readonly string[]): string {
    let name = preferred || "T";
    while (existing.includes(name)) name += "_";
    return name;
}

function isReferencedByRemainder(binders: readonly Binder[], result: MlttTerm, binderIndex: number): boolean {
    for (let index = binderIndex + 1; index < binders.length; index++) {
        if (containsVariable(binders[index].domain, index - binderIndex - 1)) return true;
    }
    return containsVariable(result, binders.length - binderIndex - 1);
}

function containsVariable(value: unknown, index: number): boolean {
    if (!value || typeof value !== "object") return false;
    const candidate = value as { readonly kind?: string; readonly index?: number; };
    if (candidate.kind === "variable" && candidate.index === index) return true;
    return Object.values(value).some(child =>
        Array.isArray(child)
            ? child.some(item => containsVariable(item, index))
            : containsVariable(child, index));
}
