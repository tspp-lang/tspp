// End-to-end behavior ported from the legacy-monolith compiler tests (unittests/tspp/newtypeData.ts).
// Not ported: feature-flag gating and its quick fixes. Newtype constructors are identity functions at runtime.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { ts, usePlugins, createProgram, diagnosticMessages, emitJavaScript, createLanguageService } = require("../../test-support/compile.cjs");
const { nominalTypesPlugin } = require("../dist");

usePlugins(nominalTypesPlugin);

const messagesOf = source => diagnosticMessages(createProgram(source).program);
const javascriptOf = source => {
  const { program, outputs } = createProgram(source);
  return emitJavaScript(program, outputs);
};
const hoverText = (source, at) => {
  const info = createLanguageService("/main.tspp", source).getQuickInfoAtPosition("/main.tspp", at);
  return ts.displayPartsToString(info?.displayParts);
};

const typeChecks = [
  ["a newtype is assignable to its underlying type but not the reverse", 1, `
    newtype UserId = number;
    declare const userId: UserId;
    const ok: number = userId;
    const bad: UserId = 1;`],
  ["@ts-expect-error suppresses newtype and data diagnostics", 0, `
    newtype UserId = number;
    newtype OrderId = number;
    declare const userId: UserId;
    // @ts-expect-error -- a plain number is not a UserId
    const badNumber: UserId = 1;
    // @ts-expect-error -- distinct newtypes are nominal
    const badOrder: OrderId = userId;
    data Option<T> = None | Some(value: T);
    // @ts-expect-error -- the variant field has the wrong type
    const badOption: Option<number> = Some("x");
    // @ts-expect-error -- structural lookalikes do not carry the variant brand
    const badVariant: typeof None = { _tag: "None" as const };`],
  ["distinct newtypes stay nominal over identical underlying types", 1, `
    newtype UserId = number;
    newtype OrderId = number;
    declare const userId: UserId;
    const bad: OrderId = userId;`],
  ["match binds data fields and infers the union of branch results", 0, `
    data Result<T> = Ok(value: T) | Err(error: string);
    declare const result: Result<number>;
    const selected: number | string = match result {
      Ok(value) => value,
      Err(error) => error,
    };`],
  ["guarded branches do not count as exhaustive on their own", 0, `
    data Result<T> = Ok(value: T) | Err(error: string);
    declare const result: Result<number>;
    const selected: number | string = match result {
      Ok(value) if value > 0 => value,
      Ok(value) => -value,
      Err(error) if error !== "" => error,
      Err(_) => "unknown",
    };`],
  ["or-patterns cover nullary variants", 0, `
    data State = Idle | Loading | Ready(value: string);
    declare const state: State;
    const selected: number = match state {
      Idle | Loading => 0,
      Ready(value) => 1,
    };`],
  ["nested constructor patterns can be exhaustive", 0, `
    data Result<T> = Ok(value: T) | Err(error: string);
    data Envelope<T> = Empty | Wrapped(result: Result<T>);
    declare const envelope: Envelope<number>;
    const selected: number = match envelope {
      Empty => 0,
      Wrapped(Ok(value)) if value > 0 => value,
      Wrapped(Ok(value)) => -value,
      Wrapped(Err(error)) => error === "" ? 0 : 1,
    };`],
  ["nested nullary constructors are distinguished from bindings", 0, `
    data Optional<T> = Absent | Present(value: T);
    data Holder<T> = Held(option: Optional<T>);
    declare const holder: Holder<number>;
    const selected: number = match holder {
      Held(Absent()) => 0,
      Held(Present(value)) => value,
    };`],
  ["data forms a union of its variants and checks field types", 1, `
    data Option<T> = None | Some(value: T);
    const none: Option<number> = None;
    const some: Option<number> = Some(1);
    const bad: Option<number> = Some("x");`],
  ["data exposes the _tag discriminant", 0, `
    data Option<T> = None | Some(value: T);
    declare const opt: Option<number>;
    const tag: "None" = (opt === None) ? opt._tag : None._tag;`],
  ["a variant is not a type", 2, `
    data List<T> = Nil | Cons(head: T, tail: List<T>);
    declare const a: Nil;
    type X = Nil;`, /refers to a value/],
  ["typeof reaches the type of a constant variant", 0, `
    data List<T> = Nil | Cons(head: T, tail: List<T>);
    const nil: typeof Nil = Nil;
    const list: List<number> = nil;`],
  ["narrowing by _tag gives the variant's field type", 1, `
    data Either<L, R> = Left(value: L) | Right(value: R) | Empty;
    declare const either: Either<string, number>;
    const n: number = either._tag === "Left" ? either.value : 0;`],
  ["variants are distinguished by their _tag", 1, `
    data Option<T> = None | Some(value: T);
    declare const opt: Option<number>;
    const bad: "Some" = (opt === None) ? opt._tag : None._tag;`],
  ["a variant constructed with a mismatched type argument is rejected", 1, `
    data Either<L, R> = Left(value: L) | Right(value: R) | Empty;
    const bad: Either<number, string> = Left("x");`],
  ["recursive data types check", 0, `
    data List<T> = Nil | Cons(head: T, tail: List<T>);
    declare const list: List<number>;
    const n: number = list._tag === "Cons" ? list.head : 0;
    const t: List<number> = list._tag === "Cons" ? list.tail : Nil;
    const ok: List<number> = Nil;`],
  ["variant fields are not accessible on the whole union", 1, `
    data Option<T> = None | Some(value: T);
    declare const opt: Option<number>;
    const n: number = opt.value;`, /does not exist/],
  ["generic newtypes are nominal over their instantiation", 1, `
    newtype Box<T> = T;
    declare const box: Box<number>;
    const n: number = box;
    const bad: Box<number> = 1;`],
  ["distinct generic newtypes stay nominal", 1, `
    newtype A<T> = T;
    newtype B<T> = T;
    declare const a: A<number>;
    const bad: B<number> = a;`],
  ["a generic newtype constructor has the identity signature", 0, `
    newtype Box<T> = T;
    const box: Box<number> = Box(42);`],
  ["a newtype over an object type stays nominal", 1, `
    newtype Point = { x: number; y: number };
    declare const p: Point;
    const obj: { x: number; y: number } = p;
    const bad: Point = { x: 1, y: 2 };`],
  ["keyof does not expose the nominal brand", 1, `
    newtype Point = { x: number; y: number };
    declare const k: keyof Point;
    const ok: "x" | "y" = k;
    const bad: keyof Point = "z";`],
  ["a newtype over a union stays nominal", 1, `
    newtype StringOrNumber = string | number;
    declare const v: StringOrNumber;
    const s: string | number = v;
    const bad: StringOrNumber = "x";`],
  ["a newtype cannot erase its brand with any, unknown, or never", 3, `
    newtype AnyValue = any;
    newtype UnknownValue = unknown;
    newtype NeverValue = never;`, /cannot use 'any', 'unknown', or 'never'/],
];

for (const [name, count, source, pattern = /not assignable/] of typeChecks) {
  test(name, () => {
    const messages = messagesOf(source);
    assert.equal(messages.length, count, messages.join("\n"));
    for (const message of messages) assert.match(message, pattern);
  });
}

test("a newtype constructor returns the newtype", () => {
  const { program } = createProgram(`
    newtype UserId = number;
    const created: UserId = UserId(42);
  `);
  assert.deepEqual(diagnosticMessages(program), []);
  const file = program.getSourceFile("/main.tspp");
  const declaration = file.statements.filter(ts.isVariableStatement)[0].declarationList.declarations[0];
  assert.equal(program.getTypeChecker().typeToString(program.getTypeChecker().getTypeAtLocation(declaration.name)), "UserId");
});

test("match reports missing, duplicate, and unknown variants", () => {
  const declarations = `
    data Result<T> = Ok(value: T) | Err(error: string);
    data Envelope<T> = Empty | Wrapped(result: Result<T>);
    declare const result: Result<number>;
    declare const envelope: Envelope<number>;
  `;
  const messages = arms => messagesOf(`${declarations}\nconst selected = ${arms};`).join("\n");
  assert.match(messages("match result { Ok(value) => value }"), /Non-exhaustive.*Err/);
  // Only the pattern errors are reported, not comparisons from the lowered tag tests.
  const invalid = messages("match result { Ok(value) => value, Ok(other) => other, Missing => 0, _ => 0 }");
  assert.deepEqual(invalid.split("\n").sort(), ["Duplicate match branch for pattern 'Ok'.", "Pattern 'Missing' does not belong to data type 'Result<number>'."]);
  assert.match(messages("match envelope { Empty => 0, Wrapped(Ok(value)) => value }"), /Non-exhaustive.*Wrapped/);
  assert.match(messages("match envelope { Wrapped(Missing(value)) => value, Wrapped(_) => 0, Empty => 0 }"), /Pattern 'Missing' does not belong/);
});

test("match stays an ordinary identifier outside match expressions", () => {
  assert.deepEqual(messagesOf("let match = 5;\nmatch = 6;\nexport const out = match + 1;"), []);
  assert.deepEqual(messagesOf("declare const match: { x: number };\nexport const x = match.x;"), []);
  // A call followed by a block on the next line is not a match with arms.
  assert.deepEqual(messagesOf("const match = (x: number) => x;\nmatch(1)\n{ const ignored = 2; }"), []);
});

test("malformed match arms report syntax errors and finish parsing", () => {
  const declarations = "data Opt = None | Some(value: number); declare const o: Opt;\n";
  // Each of these used to reparse the same token forever until the heap ran out.
  assert.match(messagesOf(`${declarations}const n = match o { None: 0 };`).join("\n"), /'=>' expected/);
  assert.match(messagesOf(`${declarations}const n = match o { Some(1) => 0 };`).join("\n"), /Identifier expected/);
  assert.match(messagesOf(`${declarations}const n = match o { None => 0`).join("\n"), /'}' expected/);
  assert.match(messagesOf(`${declarations}const n = match o { Some(`).join("\n"), /expected/);
});

test("explains that a bare variant field is a field name, not a type", () => {
  const hint = /Variant fields need a name, as in 'Some\(value: T\)'; a bare name is a field name, not a type\./;
  assert.match(messagesOf("data Maybe<T> = None | Some(T);").join("\n"), hint);
  assert.match(messagesOf("data Maybe<T> = None | Some(T[], other: number);").join("\n"), /as in 'Some\(value: Type\)'/);
  // A named field without its colon keeps the ordinary diagnostic.
  assert.deepEqual(messagesOf("data Maybe = None | Some(value number);"), ["':' expected."]);
});

test("guards alone do not make a match exhaustive", () => {
  const messages = messagesOf(`
    data Option<T> = None | Some(value: T);
    declare const option: Option<number>;
    const selected = match option { Some(value) if value > 0 => value, None => 0 };
  `);
  assert.match(messages.join("\n"), /Non-exhaustive.*Some/);
});

test("or-patterns reject variants with fields", () => {
  const messages = messagesOf(`
    data Result = Ok(value: number) | Err(value: number);
    declare const result: Result;
    const selected = match result { Ok | Err(value) => value };
  `);
  assert.match(messages.join("\n"), /Or-patterns support only variants without fields/);
});

test("data declarations lower to tagged constructors and newtypes to identity constructors", () => {
  const javascript = javascriptOf(`
    newtype UserId = number;
    data Option<T> = None | Some(value: T);
    const values = [UserId(1), Some(2), None];
  `);
  assert.match(javascript, /const None = \{ _tag: "None"/);
  assert.match(javascript, /function Some\(value\) \{\s*return \{ _tag: "Some"/);
  assert.match(javascript, /function UserId\(value\) \{\s*return value;\s*\}/);
  assert.match(javascript, /const values = \[UserId\(1\), Some\(2\), None\];/);
});

test("value matches lower to a single-evaluation tag dispatch", () => {
  const javascript = javascriptOf(`
    data Result<T> = Ok(value: T) | Err(error: string);
    declare const result: Result<number>;
    const selected = match result { Ok(value) => value, Err(error) => error };
  `);
  // A variable is read again in each tag test; any other scrutinee is evaluated once, as the dispatch's default parameter.
  assert.match(javascript, /\(\(\) => result\._tag === "Ok" \? /);
  assert.match(javascript, /\)\(\);/);
  const computed = javascriptOf(`
    data Result<T> = Ok(value: T) | Err(error: string);
    declare function load(): Result<number>;
    const selected = match load() { Ok(value) => value, Err(error) => error };
  `);
  assert.match(computed, /\(\(match = load\(\)\) => match\._tag === "Ok" \? /);
  assert.doesNotMatch(javascript, /match result/);
});

test("guards, or-patterns, and nested patterns lower after binding fields", () => {
  const guarded = javascriptOf(`
    data Option<T> = None | Some(value: T);
    declare const option: Option<number>;
    const selected = match option { Some(value) if value > 0 => value, _ => 0 };
  `);
  assert.match(guarded, /\._tag === "Some" && [^?]*> 0/);
  const alternatives = javascriptOf(`
    data State = Idle | Loading | Ready(value: string);
    const state: State = Loading;
    const selected = match state { Idle | Loading => 0, Ready(value) => value.length };
  `);
  assert.match(alternatives, /\._tag === "Idle" \|\| [\w$]+\._tag === "Loading"/);
  const nested = javascriptOf(`
    data Result<T> = Ok(value: T) | Err(error: string);
    data Envelope<T> = Wrapped(result: Result<T>);
    const envelope: Envelope<number> = Wrapped(Ok(2));
    const selected = match envelope { Wrapped(Ok(value)) => value, Wrapped(Err(error)) => error === "" ? 0 : 1 };
  `);
  assert.match(nested, /\._tag === "Wrapped" && [\w$]+\._values\[0\]\._tag === "Ok"/);
  assert.doesNotMatch(nested, /match envelope/);
});

test("feature-rich declarations keep newtype and data syntax", () => {
  const { program, outputs } = createProgram(`
    export newtype UserId = number;
    export data Option<T> = None | Some(value: T);
  `, { declaration: true, emitDeclarationOnly: true });
  program.emit();
  const declarations = outputs.get("/main.d.tspp") ?? "";
  assert.match(declarations, /export newtype UserId = number;/, declarations);
  assert.match(declarations, /export data Option<T> = None \| Some\(value: T\);/, declarations);
});

test("hover never shows the nominal brand", () => {
  const source = `
    newtype UserId = number;
    declare const userId: UserId;
  `;
  const text = hoverText(source, source.lastIndexOf("userId"));
  assert.match(text, /UserId/);
  assert.doesNotMatch(text, /__@tsppNominal@|__@nominal@/);
});

test("hover types match pattern bindings and names variants", () => {
  const source = `
    data Outcome = Success(value: number) | Failure(code: number);
    data ScreenState = Idle | Loading | Finished(outcome: Outcome);
    declare const screen: ScreenState;
    const score: number = match screen {
      Idle | Loading => 0,
      Finished(Success(value)) if value > 0 => value,
      Finished(Success(_)) => 0,
      Finished(Failure(code)) => -code,
    };
  `;
  assert.match(hoverText(source, source.indexOf("Idle |")), /Idle/);
  assert.match(hoverText(source, source.indexOf("Loading =>")), /Loading/);
  assert.match(hoverText(source, source.indexOf("Finished(Success")), /Finished/);
  assert.match(hoverText(source, source.indexOf("Success(value)")), /Success/);
  assert.match(hoverText(source, source.indexOf("value)) if")), /value: number/);
  assert.match(hoverText(source, source.indexOf("code)) =>")), /code: number/);
});

test("hovering pattern bindings leaves later diagnostics working", () => {
  // Pattern names are scanned beside the tree; checking them as expressions once queued a diagnostic that crashed.
  const source = `
    data Option<T> = None | Some(value: T);
    declare const maybe: Option<number>;
    const selected: number = match maybe {
      None => 0,
      Some(value) => value,
    };
  `;
  for (const target of ["value) =>", "None =>", "Some("]) {
    const service = createLanguageService("/main.tspp", source);
    service.getQuickInfoAtPosition("/main.tspp", source.indexOf(target));
    assert.deepEqual(service.getSemanticDiagnostics("/main.tspp").map(diagnostic => diagnostic.messageText), [], target);
  }
  const info = createLanguageService("/main.tspp", source).getQuickInfoAtPosition("/main.tspp", source.indexOf("value) =>"));
  assert.equal(ts.displayPartsToString(info?.displayParts), "(parameter) value: number");
});

test("unused generated brand members are not reported, but other unused declarations are", () => {
  // Brand members are empty generated declarations; the drop is limited to them, so other plugins' empty nodes
  // keep their unused diagnostics (integration/test/cross-plugin.test.cjs covers `let` bindings).
  const source = `
    export newtype UserId = number;
    export data Option<T> = None | Some(value: T);
    const Unused = 1;
  `;
  const { program } = createProgram(source, { noUnusedLocals: true, noUnusedParameters: true });
  const reported = program.getSemanticDiagnostics().map(diagnostic => [diagnostic.code, source.slice(diagnostic.start, diagnostic.start + diagnostic.length)]);
  assert.ok(reported.every(([, text]) => text === "Unused"), JSON.stringify(reported));
  assert.ok(reported.length > 0, "the unused authored constant is still reported");
});

test("newtype constructors can only be called directly", () => {
  // Restores the core's former `valueUse: "call-only"` rule (TS18062): calls, `typeof`, imports, and exports are
  // allowed; any other value reference would let the erased constructor escape into runtime values.
  const { program } = createProgram({
    "/lib.tspp": `export newtype UserId = string;\nexport newtype Box<T> = T;\nexport { UserId as Renamed };\n`,
    "/main.tspp": `import { UserId, Box } from "./lib";
      type Constructor = typeof UserId;
      const ok: UserId = UserId("x");
      const generic = Box<number>(1);
      const escaped: Constructor = UserId;
      const shorthand = { UserId };
      const property = { key: UserId, UserId: 1 };
      function shadowed(UserId: number) { return UserId; }
      // @ts-expect-error -- the directive is used by the escaping reference
      const suppressed: Constructor = Box;
      export default Box;
    `,
  });
  const diagnostics = program.getSemanticDiagnostics();
  const lines = diagnostics.map(diagnostic => diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line + 1);
  assert.deepEqual(diagnostics.map(diagnostic => diagnostic.code), [18062, 18062, 18062, 18062], diagnosticMessages(program).join("\n"));
  assert.deepEqual(lines, [5, 6, 7, 11]);
  assert.match(diagnosticMessages(program)[0], /The extension value 'UserId' can only be used as the target of a direct call/);
});
