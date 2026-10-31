import type { TSPPAnalysisDiagnostic, TSPPAnalysisSourceFile } from "@tspp/plugin-sdk/compiler";
import { expressionToSmt, expressionToSmtTerm, type ExpressionEnvironment, type Term } from "./expression";
import type { Z3Query } from "./solver";

export interface PendingProof {
    readonly query: Z3Query;
    readonly fileName: string;
    readonly start: number;
    readonly length: number;
    readonly name: string;
}

function matchingBrace(text: string, open: number): number {
    let depth = 0;
    let quote = "";
    for (let index = open; index < text.length; index++) {
        const char = text[index];
        if (quote) {
            if (char === "\\") index++;
            else if (char === quote) quote = "";
            continue;
        }
        if (char === '"' || char === "'" || char === "`") { quote = char; continue; }
        if (char === "/" && text[index + 1] === "/") { index = text.indexOf("\n", index); if (index < 0) return -1; continue; }
        if (char === "/" && text[index + 1] === "*") { index = text.indexOf("*/", index + 2); if (index < 0) return -1; index++; continue; }
        if (char === "{") depth++;
        else if (char === "}" && --depth === 0) return index;
    }
    return -1;
}

export function maskContractClauses(fileName: string, sourceText: string): string {
    if (!fileName.endsWith(".tspp")) return sourceText;
    const characters = [...sourceText];
    const pattern = /\bwith\s*\{/g;
    for (let match; (match = pattern.exec(sourceText));) {
        let previous = match.index - 1;
        while (previous >= 0 && /\s/.test(sourceText[previous])) previous--;
        if (sourceText[previous] !== ")") continue;
        const prefix = sourceText.slice(Math.max(0, match.index - 500), match.index);
        if (!/\b(function\s+[A-Za-z_$][\w$]*\s*\([^)]*\)|while\s*\([^)]*\))\s*$/.test(prefix)) continue;
        const open = sourceText.indexOf("{", match.index);
        const close = matchingBrace(sourceText, open);
        if (close < 0) continue;
        for (let index = match.index; index <= close; index++) {
            if (characters[index] !== "\n" && characters[index] !== "\r") characters[index] = " ";
        }
        pattern.lastIndex = close + 1;
    }
    const directivePattern = /\b(?:assert|assume)\s*:\s*[^;]+;/g;
    for (let match; (match = directivePattern.exec(sourceText));) {
        for (let index = match.index; index < match.index + match[0].length; index++) {
            if (characters[index] !== "\n" && characters[index] !== "\r") characters[index] = " ";
        }
    }
    return characters.join("");
}

function parseProperties(text: string, absoluteStart: number): { name: string; value: string; start: number; }[] {
    const properties: { name: string; value: string; start: number; }[] = [];
    const pattern = /\b(requires|ensures|invariant)\s*:\s*([^;]+);/g;
    for (let match; (match = pattern.exec(text));) {
        properties.push({ name: match[1], value: match[2].trim(), start: absoluteStart + match.index + match[0].indexOf(match[2]) });
    }
    return properties;
}

function parameterEnvironment(parameters: string): ExpressionEnvironment["variables"] {
    const variables: Record<string, "Bool" | "Int"> = {};
    const pattern = /\b([A-Za-z_$][\w$]*)\s*:\s*(boolean|bigint|number)\b/g;
    for (let match; (match = pattern.exec(parameters));) variables[match[1]] = match[2] === "boolean" ? "Bool" : "Int";
    return variables;
}

export function collectContractProofs(sourceFile: TSPPAnalysisSourceFile, diagnostics: TSPPAnalysisDiagnostic[]): PendingProof[] {
    const proofs: PendingProof[] = [];
    const source = sourceFile.text;
    const functionPattern = /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*with\s*\{/g;
    for (let match; (match = functionPattern.exec(source));) {
        const contractOpen = source.indexOf("{", match.index + match[0].lastIndexOf("with"));
        const contractClose = matchingBrace(source, contractOpen);
        if (contractClose < 0) continue;
        const bodyOpen = source.indexOf("{", contractClose + 1);
        const bodyClose = bodyOpen < 0 ? -1 : matchingBrace(source, bodyOpen);
        if (bodyClose < 0) continue;
        const variables = parameterEnvironment(match[2]);
        const properties = parseProperties(source.slice(contractOpen + 1, contractClose), contractOpen + 1);
        const requirements: string[] = [];
        for (const property of properties.filter(property => property.name === "requires")) {
            try { requirements.push(expressionToSmt(property.value, { variables })); }
            catch (error) { diagnostics.push(contractDiagnostic(sourceFile.fileName, property, 19003, error)); }
        }
        const declarations = Object.entries(variables ?? {}).map(([name, sort]) => `(declare-const |${name}| ${sort})`);
        const script = [...declarations, ...requirements.map(requirement => `(assert ${requirement})`)].join("\n");
        const body = source.slice(bodyOpen + 1, bodyClose);
        proofs.push(...collectLoopProofs(sourceFile.fileName, body, bodyOpen + 1, variables ?? {}, requirements, diagnostics));
        const returns = [...body.matchAll(/\breturn\s+([^;]+);/g)];
        for (const property of properties.filter(property => property.name === "ensures")) {
            if (!returns.length) {
                diagnostics.push(contractDiagnostic(sourceFile.fileName, property, 19003, new Error("A verified function must have an explicit return expression.")));
                continue;
            }
            for (let index = 0; index < returns.length; index++) {
                try {
                    const returned = expressionToSmtTerm(returns[index][1].trim(), { variables });
                    const goal = expressionToSmt(property.value, {
                        variables,
                        substitutions: { result: returned },
                    });
                    proofs.push({
                        query: { script, goal },
                        fileName: sourceFile.fileName,
                        start: property.start,
                        length: property.value.length,
                        name: `${match[1]} postcondition ${index + 1}`,
                    });
                }
                catch (error) { diagnostics.push(contractDiagnostic(sourceFile.fileName, property, 19003, error)); }
            }
        }
        functionPattern.lastIndex = bodyClose + 1;
    }
    return proofs;
}

function collectLoopProofs(
    fileName: string,
    functionBody: string,
    bodyStart: number,
    parameterVariables: Readonly<Record<string, "Bool" | "Int">>,
    requirements: readonly string[],
    diagnostics: TSPPAnalysisDiagnostic[],
): PendingProof[] {
    const proofs: PendingProof[] = [];
    const variables: Record<string, "Bool" | "Int"> = { ...parameterVariables };
    const initialValues: Record<string, Term> = {};
    const declarationPattern = /\b(?:let|const)\s+([A-Za-z_$][\w$]*)\s*(?::\s*(boolean|bigint|number))?\s*=\s*([^;]+);/g;
    for (let match; (match = declarationPattern.exec(functionBody));) {
        variables[match[1]] = match[2] === "boolean" ? "Bool" : "Int";
        try { initialValues[match[1]] = expressionToSmtTerm(match[3].trim(), { variables, substitutions: initialValues }); }
        catch { /* A later proof reports unsupported expressions in context. */ }
    }
    const loopPattern = /\bwhile\s*\(([^)]*)\)\s*with\s*\{/g;
    for (let match; (match = loopPattern.exec(functionBody));) {
        const contractOpen = functionBody.indexOf("{", match.index + match[0].lastIndexOf("with"));
        const contractClose = matchingBrace(functionBody, contractOpen);
        if (contractClose < 0) continue;
        const loopBodyOpen = functionBody.indexOf("{", contractClose + 1);
        const loopBodyClose = loopBodyOpen < 0 ? -1 : matchingBrace(functionBody, loopBodyOpen);
        if (loopBodyClose < 0) continue;
        const properties = parseProperties(functionBody.slice(contractOpen + 1, contractClose), bodyStart + contractOpen + 1)
            .filter(property => property.name === "invariant");
        const declarations = Object.entries(variables).map(([name, sort]) => `(declare-const |${name}| ${sort})`);
        for (const property of properties) {
            try {
                const initialGoal = expressionToSmt(property.value, { variables, substitutions: initialValues });
                proofs.push({
                    query: { script: [...declarations, ...requirements.map(value => `(assert ${value})`)].join("\n"), goal: initialGoal },
                    fileName,
                    start: property.start,
                    length: property.value.length,
                    name: "loop invariant initialization",
                });
                const invariant = expressionToSmt(property.value, { variables });
                const condition = expressionToSmt(match[1].trim(), { variables });
                const updates: Record<string, Term> = {};
                const loopBody = functionBody.slice(loopBodyOpen + 1, loopBodyClose);
                const updatePattern = /\b([A-Za-z_$][\w$]*)\s*(\+=|-=|\*=|=)\s*([^;]+);/g;
                for (let update; (update = updatePattern.exec(loopBody));) {
                    if (!variables[update[1]]) continue;
                    const right = expressionToSmtTerm(update[3].trim(), { variables, substitutions: updates });
                    updates[update[1]] = update[2] === "="
                        ? right
                        : { smt: `(${update[2][0]} ${updates[update[1]]?.smt ?? `|${update[1]}|`} ${right.smt})`, sort: variables[update[1]] };
                }
                const preservedGoal = expressionToSmt(property.value, { variables, substitutions: updates });
                proofs.push({
                    query: {
                        script: [...declarations, ...requirements.map(value => `(assert ${value})`), `(assert ${invariant})`, `(assert ${condition})`].join("\n"),
                        goal: preservedGoal,
                    },
                    fileName,
                    start: property.start,
                    length: property.value.length,
                    name: "loop invariant preservation",
                });
            }
            catch (error) { diagnostics.push(contractDiagnostic(fileName, property, 19004, error)); }
        }
        loopPattern.lastIndex = loopBodyClose + 1;
    }
    return proofs;
}

function contractDiagnostic(fileName: string, property: { start: number; value: string; }, code: number, error: unknown): TSPPAnalysisDiagnostic {
    return {
        fileName,
        start: property.start,
        length: property.value.length,
        code,
        category: "error",
        source: "TS++ verification",
        message: error instanceof Error ? error.message : String(error),
    };
}
