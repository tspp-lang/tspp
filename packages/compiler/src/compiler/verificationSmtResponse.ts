import type {
  VerificationModelSort,
  VerificationQuery,
} from "./verificationSmt.js";
import type {
  VerificationSolverResponse,
  VerificationSolverResult,
} from "./verificationWorker.js";

/*
 * Interprets standard SMT-LIB solver responses (`check-sat`, `get-value`,
 * `get-unsat-core`, `get-info :reason-unknown`) for one verification query.
 * Keeping this in the compiler means every solver backend only has to run
 * SMT-LIB text; counterexamples and trust reports are produced the same way
 * for all of them.
 */

/** The follow-up command to run after `check-sat`, by its answer. @internal */
export function getVerificationFollowUps(query: VerificationQuery): { readonly onSat?: string; readonly onUnsat?: string; readonly onUnknown: string; } {
  return {
    onSat: query.values.length ? `(get-value (${query.values.map(value => value.symbol).join(" ")}))` : undefined,
    onUnsat: query.trusted.length ? "(get-unsat-core)" : undefined,
    onUnknown: "(get-info :reason-unknown)",
  };
}

/** @internal */
export function interpretVerificationResponse(query: VerificationQuery, response: VerificationSolverResponse): VerificationSolverResult {
  switch (response.status) {
    case "unsat": {
      const core = new Set(flattenAtoms(parseSExpressions(response.output ?? "")));
      const trustedInputs = [
        ...query.modelAssumptions,
        ...query.trusted.filter(input => core.has(input.name)).map(input => input.label),
      ];
      const message = "The SMT solver proved the obligation: its negation is unsatisfiable.";
      return trustedInputs.length
        ? { status: "proved", message: `${message} The proof relies on trusted input: ${trustedInputs.join("; ")}.`, trustedInputs }
        : { status: "proved", message };
    }
    case "sat": {
      const model = response.output ?? "";
      return {
        status: "failed",
        message: "The SMT solver found a counterexample.",
        counterexample: formatCounterexample(query, model) || "the obligation is false for every assignment",
        model: model || undefined,
      };
    }
    case "unknown": {
      const reason = readReasonUnknown(response.output ?? "");
      const message = `The SMT solver returned unknown${reason ? `: ${reason}` : ""}.`;
      return reason === "timeout" || reason === "canceled"
        ? { status: "unknown", message, reason: { code: "timeout", message } }
        : { status: "unknown", message };
    }
    case "error":
      return { status: "error", message: response.message ?? "The SMT solver reported an error." };
  }
}

type SExpression = string | SExpression[];

function tokenizeSExpressions(text: string): string[] {
  return text.match(/\(|\)|\|(?:\\.|[^|])*\||"(?:""|[^"])*"|[^\s()]+/g) ?? [];
}

function parseSExpressions(text: string): SExpression[] {
  const tokens = tokenizeSExpressions(text);
  let index = 0;
  const parse = (): SExpression => {
    const token = tokens[index++];
    if (token !== "(") return token;
    const result: SExpression[] = [];
    while (index < tokens.length && tokens[index] !== ")") result.push(parse());
    index++;
    return result;
  };
  const result: SExpression[] = [];
  while (index < tokens.length) result.push(parse());
  return result;
}

function flattenAtoms(expressions: readonly SExpression[]): string[] {
  return expressions.flatMap(expression => typeof expression === "string" ? [unquoteSymbol(expression)] : flattenAtoms(expression));
}

function unquoteSymbol(symbol: string): string {
  return symbol.startsWith("|") && symbol.endsWith("|") ? symbol.slice(1, -1) : symbol;
}

function readReasonUnknown(output: string): string | undefined {
  const [response] = parseSExpressions(output);
  if (!Array.isArray(response) || response[0] !== ":reason-unknown") return undefined;
  const reason = response[1];
  return typeof reason === "string" ? reason.replace(/^"|"$/g, "") : reason && formatSExpression(reason);
}

function formatCounterexample(query: VerificationQuery, output: string): string {
  const [response] = parseSExpressions(output);
  if (!Array.isArray(response)) return "";
  const values = new Map<string, SExpression>();
  for (const pair of response) {
    if (Array.isArray(pair) && pair.length === 2 && typeof pair[0] === "string") values.set(unquoteSymbol(pair[0]), pair[1]);
  }
  const selected = query.values.filter(value => values.has(value.symbol));
  const seenSourceNames = new Set<string>();
  const duplicateSourceNames = new Set<string>();
  for (const value of selected) {
    if (seenSourceNames.has(value.sourceName)) duplicateSourceNames.add(value.sourceName);
    seenSourceNames.add(value.sourceName);
  }
  const sorts = new Map(query.sorts.map(sort => [sort.sort, sort]));
  return selected.map(value => {
    const label = duplicateSourceNames.has(value.sourceName) ? `${value.sourceName} (${value.symbol})` : value.sourceName;
    return `${label} = ${formatModelValue(values.get(value.symbol)!, value.sort, sorts)}`;
  }).join(", ");
}

function formatModelValue(value: SExpression, sortName: string, sorts: ReadonlyMap<string, VerificationModelSort>): string {
  // `(as Nil Sort)` qualifies an otherwise ambiguous nullary constructor.
  if (Array.isArray(value) && value[0] === "as" && value.length === 3) return formatModelValue(value[1], sortName, sorts);
  const structured = sorts.get(sortName);
  if (!structured) return formatPrimitiveModelValue(value);
  const head = Array.isArray(value) ? value[0] : value;
  const variant = structured.variants.find(candidate => typeof head === "string" && unquoteSymbol(candidate.constructor) === unquoteSymbol(head));
  if (!variant) return formatSExpression(value);
  const fields = variant.fields.map((field, index) => `${field.name}: ${formatModelValue(Array.isArray(value) ? value[index + 1] : "", field.sort, sorts)}`);
  if (structured.kind === "sum") fields.unshift(`_tag: ${JSON.stringify(variant.name)}`);
  return fields.length ? `{ ${fields.join(", ")} }` : "{}";
}

function formatPrimitiveModelValue(value: SExpression): string {
  if (Array.isArray(value) && value[0] === "-" && value.length === 2) return `-${formatPrimitiveModelValue(value[1])}`;
  if (Array.isArray(value) && value[0] === "/" && value.length === 3) return `${formatPrimitiveModelValue(value[1])}/${formatPrimitiveModelValue(value[2])}`;
  if (typeof value === "string" && /^\d+\.0$/.test(value)) return value.slice(0, -2);
  if (typeof value === "string" && value.startsWith('"') && value.endsWith('"')) return JSON.stringify(value.slice(1, -1).replace(/""/g, '"'));
  return formatSExpression(value);
}

function formatSExpression(value: SExpression): string {
  return Array.isArray(value) ? `(${value.map(formatSExpression).join(" ")})` : value;
}
