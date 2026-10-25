import {
  getRawSmtTermError,
  isTrustedAssertionKind,
  VerificationAssertion,
  verificationAssertion,
  VerificationAxiom,
  VerificationExpression,
  VerificationField,
  VerificationFunction,
  VerificationProblem,
  VerificationSort,
  verificationSortKey,
  VerificationStructuredSort,
  VerificationUninterpretedSort,
} from "./verificationIR.js";
import {
  createVerificationLogicFeatures,
  getVerificationLogic,
  inferVerificationSort,
  isVerificationTheorySymbol,
  VerificationSortScope,
} from "./verificationSignatures.js";

/**
 * The SMT-LIB 2.6 backend for the solver-independent verification IR.
 *
 * The printed script contains only standard commands and standard theory
 * symbols. It never runs `check-sat` or sets solver-specific options such as
 * timeouts: the solver protocol (verificationWorker.ts) owns those.
 *
 * @internal
 */
export interface VerificationSmtEncoding {
  /** The standard SMT-LIB script, without `check-sat`. */
  readonly solverInput: string;
  /** The script followed by the commands needed to replay the query by hand. */
  readonly replayableSmtLib: string;
  readonly query: VerificationQuery;
}

/** Everything the solver protocol needs to run a script and explain its answer. @internal */
export interface VerificationQuery {
  readonly script: string;
  /** Declared constants whose values make up a counterexample. */
  readonly values: readonly VerificationValueSymbol[];
  readonly sorts: readonly VerificationModelSort[];
  /** Trusted assertions, named so an unsat core can report which ones a proof used. */
  readonly trusted: readonly { readonly name: string; readonly label: string; }[];
  /** Trusted inputs that hold for the whole problem and cannot be tracked through a core. */
  readonly modelAssumptions: readonly string[];
}

/** @internal */
export interface VerificationValueSymbol {
  readonly symbol: string;
  readonly sourceName: string;
  readonly sort: string;
}

/** @internal */
export interface VerificationModelSort {
  readonly sort: string;
  readonly kind: "product" | "sum";
  readonly name: string;
  readonly variants: readonly {
    readonly name: string | undefined;
    readonly constructor: string;
    readonly fields: readonly { readonly name: string; readonly sort: string; }[];
  }[];
}

interface StructuredSortNames {
  readonly sort: string;
  readonly constructors: ReadonlyMap<string, string>;
  readonly selectors: ReadonlyMap<string, string>;
}

interface EncodingNames {
  readonly structured: ReadonlyMap<string, StructuredSortNames>;
}

const trustedNamePrefix = "tspp.trusted.";

function hashText(text: string): string {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function createStructuredSortNames(sort: VerificationStructuredSort): StructuredSortNames {
  const hash = hashText(verificationSortKey(sort));
  const constructors = new Map<string, string>();
  const selectors = new Map<string, string>();
  if (sort.kind === "product") {
    constructors.set("", `|tspp.ctor.${hash}|`);
    for (const field of sort.fields) selectors.set(field.name, `|tspp.field.${hash}.${safeName(field.name)}|`);
  }
  else {
    for (const variant of sort.variants) {
      constructors.set(variant.name, `|tspp.ctor.${hash}.${safeName(variant.name)}|`);
      for (const field of variant.fields) selectors.set(`${variant.name}\0${field.name}`, `|tspp.field.${hash}.${safeName(variant.name)}.${safeName(field.name)}|`);
    }
  }
  return { sort: `|tspp.sort.${hash}|`, constructors, selectors };
}

function safeName(name: string): string {
  if (name.includes("|") || name.includes("\\") || name.includes("\0")) throw new Error(`Verification name '${name}' cannot be encoded as SMT-LIB.`);
  return name.replace(/\s+/g, "_");
}

const simpleSymbolPattern = /^[a-z~!@$%^&*_\-+=<>.?/][\w~!@$%^&*\-+=<>.?/]*$/i;
const reservedWords = new Set(["_", "!", "as", "let", "exists", "forall", "match", "par", "BINARY", "DECIMAL", "HEXADECIMAL", "NUMERAL", "STRING"]);

/** Prints a user or library symbol, quoting it when it is not a simple SMT-LIB symbol. */
function encodeSymbol(name: string): string {
  if (simpleSymbolPattern.test(name) && !reservedWords.has(name)) return name;
  if (name.includes("|") || name.includes("\\")) throw new Error(`Verification symbol '${name}' cannot be encoded as SMT-LIB.`);
  return `|${name}|`;
}

function encodeSort(sort: VerificationSort, names: EncodingNames): string {
  if (typeof sort === "string") return sort;
  if (sort.kind === "uninterpreted") return encodeSymbol(sort.name);
  const result = names.structured.get(verificationSortKey(sort));
  if (!result) throw new Error(`Structured verification sort '${sort.name}' was not declared.`);
  return result.sort;
}

function encodeNumeral(value: string, real: boolean): string {
  const negative = value.startsWith("-");
  let magnitude = negative ? value.slice(1) : value;
  if (real && !magnitude.includes(".")) magnitude += ".0";
  return negative ? `(- ${magnitude})` : magnitude;
}

/** SMT-LIB 2.6 string literals: `""` escapes a quote; everything outside printable ASCII uses `\u{...}`. */
function encodeString(value: string): string {
  let text = "";
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (character === '"') text += '""';
    else if (code < 0x20 || code > 0x7e || character === "\\") text += `\\u{${code.toString(16)}}`;
    else text += character;
  }
  return `"${text}"`;
}

function encodeExpression(expression: VerificationExpression, names: EncodingNames): string {
  switch (expression.kind) {
    case "constant":
      return expression.name;
    case "variable":
      return encodeSymbol(expression.name);
    case "boolean":
      return expression.value ? "true" : "false";
    case "integer":
      return encodeNumeral(expression.value, /*real*/ false);
    case "real":
      return encodeNumeral(expression.value, /*real*/ true);
    case "string":
      return encodeString(expression.value);
    case "construct": {
      const sortNames = names.structured.get(verificationSortKey(expression.sort));
      const constructor = sortNames?.constructors.get(expression.variant ?? "");
      if (!constructor) throw new Error(`Unknown constructor '${expression.variant ?? expression.sort.name}'.`);
      const fields = expression.fields.map(field => encodeExpression(field, names));
      return fields.length ? `(${constructor} ${fields.join(" ")})` : constructor;
    }
    case "select": {
      const sortNames = names.structured.get(verificationSortKey(expression.sort));
      const selector = sortNames?.selectors.get(expression.sort.kind === "sum" ? `${expression.variant ?? ""}\0${expression.field}` : expression.field);
      if (!selector) throw new Error(`Unknown field '${expression.field}' on verification sort '${expression.sort.name}'.`);
      return `(${selector} ${encodeExpression(expression.target, names)})`;
    }
    case "is-variant": {
      const sortNames = names.structured.get(verificationSortKey(expression.sort));
      const constructor = sortNames?.constructors.get(expression.variant);
      if (!constructor) throw new Error(`Unknown variant '${expression.variant}' on verification sort '${expression.sort.name}'.`);
      return `((_ is ${constructor}) ${encodeExpression(expression.target, names)})`;
    }
    case "application": {
      // `and`/`or` are left-associative and need two operands in SMT-LIB.
      if ((expression.symbol === "and" || expression.symbol === "or") && expression.operands.length < 2) {
        return expression.operands.length ? encodeExpression(expression.operands[0], names) : expression.symbol === "and" ? "true" : "false";
      }
      const symbol = isVerificationTheorySymbol(expression.symbol) ? expression.symbol : encodeSymbol(expression.symbol);
      return expression.operands.length ? `(${symbol} ${expression.operands.map(operand => encodeExpression(operand, names)).join(" ")})` : symbol;
    }
    case "quantifier": {
      const bindings = expression.bindings.map(binding => `(${encodeSymbol(binding.name)} ${encodeSort(binding.sort, names)})`).join(" ");
      const body = encodeExpression(expression.body, names);
      const patterns = (expression.patterns ?? []).map(pattern => ` :pattern (${pattern.map(term => encodeExpression(term, names)).join(" ")})`).join("");
      return `(${expression.quantifier} (${bindings}) ${patterns ? `(! ${body}${patterns})` : body})`;
    }
    case "let":
      return `(let (${expression.bindings.map(binding => `(${encodeSymbol(binding.name)} ${encodeExpression(binding.value, names)})`).join(" ")}) ${encodeExpression(expression.body, names)})`;
    case "raw": {
      const error = getRawSmtTermError(expression.text);
      if (error) throw new Error(`Raw SMT-LIB must contain exactly one term: ${error}.`);
      return expression.text;
    }
  }
}

function validateStructuredSort(sort: VerificationStructuredSort): void {
  if (!sort.name) throw new Error("A structured verification sort must have a name.");
  if (sort.kind === "sum" && !sort.variants.length) throw new Error(`Sum verification sort '${sort.name}' must have at least one variant.`);
  const variantNames = new Set<string>();
  const variants = sort.kind === "product" ? [{ name: "", fields: sort.fields }] : sort.variants;
  for (const variant of variants) {
    if (variantNames.has(variant.name)) throw new Error(`Duplicate variant '${variant.name}' on verification sort '${sort.name}'.`);
    variantNames.add(variant.name);
    const fieldNames = new Set<string>();
    for (const field of variant.fields) {
      if (fieldNames.has(field.name)) throw new Error(`Duplicate field '${field.name}' on verification sort '${sort.name}'.`);
      fieldNames.add(field.name);
    }
  }
}

/** Collects every structured and uninterpreted sort reachable from the given sorts, including field sorts. */
function collectSorts(roots: Iterable<VerificationSort>): { readonly structured: VerificationStructuredSort[]; readonly uninterpreted: VerificationUninterpretedSort[]; } {
  const structured = new Map<string, VerificationStructuredSort>();
  const uninterpreted = new Map<string, VerificationUninterpretedSort>();
  const visit = (sort: VerificationSort): void => {
    if (typeof sort === "string") return;
    if (sort.kind === "uninterpreted") {
      uninterpreted.set(sort.name, sort);
      return;
    }
    const key = verificationSortKey(sort);
    if (structured.has(key)) return;
    validateStructuredSort(sort);
    structured.set(key, sort);
    const fields = sort.kind === "product" ? sort.fields : sort.variants.flatMap(variant => variant.fields);
    for (const field of fields) visit(field.sort);
  };
  for (const sort of roots) visit(sort);
  return { structured: [...structured.values()], uninterpreted: [...uninterpreted.values()] };
}

/**
 * Sort-checks the problem and returns the functions it reaches, ordered so
 * that every definition follows the definitions its body uses.
 */
function checkProblem(problem: VerificationProblem, scope: VerificationSortScope): { readonly functions: readonly VerificationFunction[]; readonly axioms: readonly VerificationAssertion[]; } {
  const checkBoolean = (expression: VerificationExpression, what: string) => {
    if (inferVerificationSort(expression, scope) !== "Bool") throw new Error(`${what} must have sort Bool.`);
  };
  problem.assertions.forEach((assertion, index) => checkBoolean(assertion.expression, `Assertion ${index + 1}`));
  checkBoolean(problem.goal, "The goal");

  const ordered: VerificationFunction[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (name: string): void => {
    const status = state.get(name);
    if (status === "done") return;
    const definition = scope.functions.get(name)!;
    if (status === "visiting") {
      throw new Error(`Function '${name}' is part of a definition cycle; only a function marked recursive may refer to itself.`);
    }
    state.set(name, "visiting");
    for (const parameter of definition.parameters) scope.sorts.add(parameter.sort);
    scope.sorts.add(definition.sort);
    if (definition.body) {
      const references = new Set<string>();
      const bodyScope: VerificationSortScope = { ...scope, referencedFunctions: references };
      const bound = new Map(definition.parameters.map(parameter => [parameter.name, parameter.sort]));
      const sort = inferVerificationSort(definition.body, bodyScope, bound);
      if (verificationSortKey(sort) !== verificationSortKey(definition.sort)) throw new Error(`The body of function '${name}' does not have its declared sort.`);
      if (definition.recursive) {
        // define-fun-rec means a quantified axiom over an uninterpreted function.
        scope.features.uninterpretedFunctions = true;
        scope.features.quantifiers = true;
      }
      for (const reference of references) {
        if (reference === name && definition.recursive) continue;
        visit(reference);
      }
    }
    else if (definition.parameters.length) scope.features.uninterpretedFunctions = true;
    state.set(name, "done");
    ordered.push(definition);
    for (const axiom of definition.axioms ?? []) pendingAxioms.push({ axiom, definition });
  };
  // Axioms are assertions, printed after every declaration, so they may refer
  // to any function (including mutually) without creating a definition cycle.
  const pendingAxioms: { readonly axiom: VerificationAxiom; readonly definition: VerificationFunction; }[] = [];
  const axioms: VerificationAssertion[] = [];
  for (const name of [...scope.referencedFunctions]) visit(name);
  // An array iterator also visits entries appended while iterating.
  for (const { axiom, definition } of pendingAxioms) {
    const references = new Set<string>();
    if (inferVerificationSort(axiom.expression, { ...scope, referencedFunctions: references }) !== "Bool") {
      throw new Error(`Axiom '${axiom.label}' of function '${definition.name}' must have sort Bool.`);
    }
    for (const reference of references) visit(reference);
    axioms.push(verificationAssertion(axiom.expression, "axiom", `${axiom.label} (axiom of ${definition.name})`));
  }
  return { functions: ordered, axioms };
}

export function encodeVerificationProblem(problem: VerificationProblem): VerificationSmtEncoding {
  const functions = new Map<string, VerificationFunction>();
  for (const definition of problem.functions ?? []) {
    if (isVerificationTheorySymbol(definition.name)) throw new Error(`Function '${definition.name}' would shadow a standard theory symbol.`);
    if (functions.has(definition.name)) throw new Error(`Function '${definition.name}' is declared twice.`);
    functions.set(definition.name, definition);
  }
  const constants = new Map<string, VerificationSort>();
  for (const declaration of problem.declarations) {
    if (constants.has(declaration.name) || functions.has(declaration.name)) throw new Error(`Symbol '${declaration.name}' is declared twice.`);
    constants.set(declaration.name, declaration.sort);
  }
  const sorts = new Set<VerificationSort>([...problem.structuredSorts ?? [], ...problem.uninterpretedSorts ?? [], ...problem.declarations.map(declaration => declaration.sort)]);
  const scope: VerificationSortScope = {
    constants,
    functions,
    features: createVerificationLogicFeatures(),
    referencedFunctions: new Set(),
    sorts,
  };
  const { functions: reachableFunctions, axioms } = checkProblem(problem, scope);
  const collected = collectSorts(sorts);
  if (collected.uninterpreted.length) scope.features.uninterpretedFunctions = true;
  const names: EncodingNames = {
    structured: new Map(collected.structured.map(sort => [verificationSortKey(sort), createStructuredSortNames(sort)])),
  };

  const trusted: { name: string; label: string; }[] = [];
  const trustedDefinitions = reachableFunctions.filter(definition => definition.recursive).map(definition => `recursive definition ${definition.name} (${definition.origin})`);
  const modelAssumptions = [...problem.modelAssumptions ?? [], ...trustedDefinitions];
  const assertions = [...axioms, ...problem.assertions].map(assertion => encodeAssertion(assertion, names, trusted));

  const header = [
    "; Generated by TS++ verification backend (SMT-LIB 2.6)",
    ...modelAssumptions.length ? ["; Trusted model assumptions:", ...modelAssumptions.map(text => `;   ${commentText(text)}`)] : [],
    ...trusted.length ? ["; Trusted inputs (reported when a proof depends on them):", ...trusted.map(input => `;   ${input.name}: ${commentText(input.label)}`)] : [],
    ...problem.declarations.filter(declaration => declaration.sourceName !== undefined).map(declaration => `; ${declaration.name} = ${commentText(declaration.sourceName!)}`),
  ];
  const script = [
    ...header,
    "(set-option :produce-models true)",
    ...trusted.length ? ["(set-option :produce-unsat-cores true)"] : [],
    `(set-logic ${getVerificationLogic(scope.features)})`,
    ...collected.uninterpreted.map(sort => `(declare-sort ${encodeSymbol(sort.name)} 0)`),
    ...collected.structured.length ? [encodeStructuredSortDeclarations(collected.structured, names)] : [],
    ...reachableFunctions.flatMap(definition => [`; ${commentText(definition.origin)}`, encodeFunction(definition, names)]),
    ...problem.declarations.map(declaration => `(declare-const ${declaration.name} ${encodeSort(declaration.sort, names)})`),
    ...assertions,
    "; goal (negated)",
    `(assert (not ${encodeExpression(problem.goal, names)}))`,
  ].join("\n") + "\n";

  const sortName = (sort: VerificationSort) => encodeSort(sort, names);
  const query: VerificationQuery = {
    script,
    values: problem.declarations.map(declaration => ({
      symbol: declaration.name,
      sourceName: declaration.sourceName ?? declaration.name,
      sort: sortName(declaration.sort),
    })),
    sorts: collected.structured.map(sort => createModelSort(sort, names, sortName)),
    trusted,
    modelAssumptions,
  };
  return {
    solverInput: script,
    replayableSmtLib: `${script}(check-sat)\n(get-model)\n`,
    query,
  };
}

function encodeAssertion(assertion: VerificationAssertion, names: EncodingNames, trusted: { name: string; label: string; }[]): string {
  const { kind, label } = assertion.origin;
  const comment = `; [${kind}${isTrustedAssertionKind(kind) ? ", trusted" : ""}]${label ? ` ${commentText(label)}` : ""}`;
  const term = encodeExpression(assertion.expression, names);
  if (!isTrustedAssertionKind(kind)) return `${comment}\n(assert ${term})`;
  const name = `${trustedNamePrefix}${trusted.length}`;
  trusted.push({ name, label: label ?? kind });
  return `${comment}\n(assert (! ${term} :named ${name}))`;
}

function encodeFunction(definition: VerificationFunction, names: EncodingNames): string {
  const name = encodeSymbol(definition.name);
  const result = encodeSort(definition.sort, names);
  if (!definition.body) return `(declare-fun ${name} (${definition.parameters.map(parameter => encodeSort(parameter.sort, names)).join(" ")}) ${result})`;
  const parameters = definition.parameters.map(parameter => `(${encodeSymbol(parameter.name)} ${encodeSort(parameter.sort, names)})`).join(" ");
  return `(${definition.recursive ? "define-fun-rec" : "define-fun"} ${name} (${parameters}) ${result} ${encodeExpression(definition.body, names)})`;
}

function commentText(text: string): string {
  return text.replace(/[\r\n]+/g, " ");
}

function encodeFields(fields: readonly VerificationField[], sortNames: StructuredSortNames, variant: string | undefined, names: EncodingNames): string {
  return fields.map(field => {
    const selector = sortNames.selectors.get(variant === undefined ? field.name : `${variant}\0${field.name}`)!;
    return `(${selector} ${encodeSort(field.sort, names)})`;
  }).join(" ");
}

function encodeStructuredSortConstructors(sort: VerificationStructuredSort, names: EncodingNames): string {
  const sortNames = names.structured.get(verificationSortKey(sort))!;
  return sort.kind === "product"
    ? encodeConstructorDeclaration(sortNames.constructors.get("")!, encodeFields(sort.fields, sortNames, /*variant*/ undefined, names))
    : sort.variants.map(variant => encodeConstructorDeclaration(sortNames.constructors.get(variant.name)!, encodeFields(variant.fields, sortNames, variant.name, names))).join(" ");
}

function encodeConstructorDeclaration(constructor: string, fields: string): string {
  return fields ? `(${constructor} ${fields})` : `(${constructor})`;
}

function encodeStructuredSortDeclarations(sorts: readonly VerificationStructuredSort[], names: EncodingNames): string {
  const heads = sorts.map(sort => `(${names.structured.get(verificationSortKey(sort))!.sort} 0)`).join(" ");
  const bodies = sorts.map(sort => `(${encodeStructuredSortConstructors(sort, names)})`).join(" ");
  return `(declare-datatypes (${heads}) (${bodies}))`;
}

function createModelSort(sort: VerificationStructuredSort, names: EncodingNames, sortName: (sort: VerificationSort) => string): VerificationModelSort {
  const sortNames = names.structured.get(verificationSortKey(sort))!;
  const variants = sort.kind === "product"
    ? [{ name: undefined, fields: sort.fields }]
    : sort.variants;
  return {
    sort: sortNames.sort,
    kind: sort.kind,
    name: sort.name,
    variants: variants.map(variant => ({
      name: variant.name,
      constructor: sortNames.constructors.get(variant.name ?? "")!,
      fields: variant.fields.map(field => ({ name: field.name, sort: sortName(field.sort) })),
    })),
  };
}
