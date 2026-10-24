import * as documents from "../../_namespaces/documents.js";
import * as fakes from "../../_namespaces/fakes.js";
import * as Harness from "../../_namespaces/Harness.js";
import * as ts from "../../_namespaces/ts.js";
import * as vfs from "../../_namespaces/vfs.js";

describe("unittests:: tspp:: formal contracts", () => {
  async function createProgram(content: string, tsppFeatures: string[] = ["formalContracts"]) {
    const fileName = "/file.tspp";
    const options: ts.CompilerOptions = {
      noLib: true,
      noImplicitAny: false,
      target: ts.ScriptTarget.ES2022,
      tsppFeatures,
    };
    const fs = vfs.createFromFileSystem(
      Harness.IO,
      /*ignoreCase*/ true,
      { documents: [new documents.TextDocument(fileName, content)], cwd: "/" },
    );
    const host = new fakes.CompilerHost(fs, options);
    const program = await ts.createProgramAsync({ host, rootNames: [fileName], options });
    return { fileName, fs, program };
  }

  it("parses and prints while invariant clauses", () => {
    const file = ts.createSourceFile(
      "/file.tspp",
      "while (x < n) with { invariant: [x >= 0n, x <= n]; } { x += 1n; }",
      ts.ScriptTarget.Latest,
      /*setParentNodes*/ true,
    );
    assert.isEmpty(file.parseDiagnostics);
    const statement = file.statements[0] as ts.WhileStatement;
    assert.isTrue(ts.isWhileStatement(statement));
    assert.equal(statement.withClause?.properties.length, 1);
    assert.isTrue(ts.isArrayLiteralExpression(statement.withClause!.properties[0].value));
    assert.include(ts.createPrinter().printFile(file), "with { invariant: [x >= 0n, x <= n]; }");
  });

  it("proves contracts and both loop invariant obligations", async () => {
    const { fs, program } = await createProgram(`
      function sum(n: bigint) with {
        requires: n >= 0n;
        ensures: result === n;
      }: bigint {
        let x = 0n;
        while (x < n) with {
          invariant: [x >= 0n, x <= n];
        } {
          x += 1n;
        }
        return x;
      }
    `);
    const artifacts = program.getVerificationArtifacts!();
    assert.lengthOf(artifacts, 5);
    assert.isTrue(artifacts.every(artifact => artifact.status === "proved"));
    assert.isTrue(artifacts.every(artifact => artifact.taskKind === "verification"));
    assert.isTrue(artifacts.every(artifact => artifact.outcome === "succeeded"));
    assert.equal(new Set(artifacts.map(artifact => artifact.taskId)).size, artifacts.length);
    assert.deepEqual(program.getAnalysisArtifacts!(), artifacts);
    assert.isTrue(artifacts.every(artifact => artifact.replayableSmtLib.includes("(check-sat)")));
    const sourceFile = program.getSourceFile("/file.tspp")!;
    assert.isTrue(artifacts.every(artifact => !sourceFile.text.slice(artifact.start, artifact.start + artifact.length).includes("\n")));
    assert.isEmpty(program.getSemanticDiagnostics());

    const emit = program.emit();
    assert.isFalse(emit.emitSkipped);
    const js = fs.readFileSync("/file.js").toString();
    assert.include(js, "while (x < n)");
    assert.notInclude(js, "invariant");
    assert.notInclude(js, "ensures");
  });

  it("rejects duplicate keys in with clauses", async () => {
    const { program } = await createProgram(`
      function duplicateEnsures(value: bigint) with {
        ensures: result >= value;
        ensures: result === value;
      }: bigint { return value; }
      while (true) with {
        invariant: true;
        invariant: true;
      } {}
    `);
    const messages = program.getSemanticDiagnostics().map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
    assert.equal(messages.filter(message => message.includes("may only be specified once")).length, 2);
  });

  it("reports a counterexample instead of accepting a false postcondition", async () => {
    const { fileName, program } = await createProgram(`
      function bad(x: bigint) with { ensures: result > x; }: bigint {
        return x;
      }
    `);
    const [artifact] = program.getVerificationArtifacts!();
    assert.equal(artifact.status, "failed");
    assert.include(artifact.message, "counterexample");
    assert.isString(artifact.model);
    assert.equal(artifact.counterexample, "x = 0");
    assert.equal(program.getSourceFile(fileName)!.text.slice(artifact.start, artifact.start + artifact.length), "result > x");
    const message = ts.flattenDiagnosticMessageText(program.getSemanticDiagnostics()[0].messageText, "\n");
    assert.include(message, "proof failed");
    assert.include(message, "Counterexample: x = 0");
  });

  it("proves and erases local assert proof points", async () => {
    const { fs, program } = await createProgram(`
      function increment(x: bigint) with { requires: x >= 0n; }: bigint {
        const next = x + 1n;
        assert: next > 0n;
        return next;
      }
    `);
    const [artifact] = program.getVerificationArtifacts!();
    assert.equal(artifact.kind, "assertion");
    assert.equal(artifact.obligation, "assertion");
    assert.equal(artifact.status, "proved");
    assert.isEmpty(program.getSemanticDiagnostics());
    program.emit();
    assert.notInclude(fs.readFileSync("/file.js").toString(), "assert");
  });

  it("uses and erases trusted local assumptions", async () => {
    const { fs, program } = await createProgram(`
      function incrementFromTrustedInput(x: bigint): bigint {
        assume: x >= 0n;
        const next = x + 1n;
        assert: next > 0n;
        return next;
      }
    `);
    const [artifact] = program.getVerificationArtifacts!();
    assert.equal(artifact.kind, "assertion");
    assert.equal(artifact.status, "proved");
    assert.isEmpty(program.getSemanticDiagnostics());
    const sourceFile = program.getSourceFile("/file.tspp")!;
    const functionBody = (sourceFile.statements[0] as ts.FunctionDeclaration).body!;
    const assume = (functionBody.statements[0] as ts.ExpressionStatement).expression;
    const assumeChildren = assume.getChildren(sourceFile);
    assert.strictEqual(assumeChildren[0].kind, ts.SyntaxKind.Identifier);
    assert.strictEqual(assumeChildren[0].getText(sourceFile), "assume");
    program.emit();
    const output = fs.readFileSync("/file.js").toString();
    assert.notInclude(output, "assume");
    assert.notInclude(output, "assert");
  });

  it("reports a source-level counterexample for a false assert", async () => {
    const { fileName, program } = await createProgram(`
      function positive(x: bigint): bigint {
        assert: x > 0n;
        return x;
      }
    `);
    const [artifact] = program.getVerificationArtifacts!();
    assert.equal(artifact.status, "failed");
    assert.equal(program.getSourceFile(fileName)!.text.slice(artifact.start, artifact.start + artifact.length), "x > 0n");
    assert.include(artifact.counterexample!, "x =");
  });

  it("keeps calls to a user-defined assert as ordinary function calls", async () => {
    const { program } = await createProgram(`
      function assert(condition: unknown, message?: string): void {}
      function check(x: number) {
        assert(
          x > 0,
        );
        return x;
      }
    `);
    assert.isEmpty(program.getSemanticDiagnostics());
    const sourceFile = program.getSourceFile("/file.tspp")!;
    const functionBody = (sourceFile.statements[1] as ts.FunctionDeclaration).body!;
    const call = (functionBody.statements[0] as ts.ExpressionStatement).expression;
    assert.isTrue(ts.isCallExpression(call), "expected an ordinary call, not a proof directive");
  });

  it("still parses a labeled statement when the colon is followed by a block", async () => {
    const { program } = await createProgram(`
      function check(x: number) {
        assert: {
          break assert;
        }
        return x;
      }
    `);
    assert.isEmpty(program.getSemanticDiagnostics());
    const sourceFile = program.getSourceFile("/file.tspp")!;
    const functionBody = (sourceFile.statements[0] as ts.FunctionDeclaration).body!;
    assert.isTrue(ts.isLabeledStatement(functionBody.statements[0]));
  });

  it("supports standard predicates only in verification contexts", async () => {
    const { program } = await createProgram(
      `
      const runtimeCall = isEven(2n);
    `,
      ["formalContracts", "standardLibraryPredicates"],
    );
    const messages = program.getSemanticDiagnostics().map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
    assert.include(messages.join("\n"), "Standard predicate 'isEven' can only be used in a formal verification predicate");
  });

  it("allows an ordinary same-named function outside verification contexts", async () => {
    const { program } = await createProgram(
      `
      function isEven(_value: bigint): boolean { return true; }
      const runtimeCall = isEven(2n);
    `,
      ["formalContracts", "standardLibraryPredicates"],
    );
    assert.isEmpty(program.getSemanticDiagnostics());
  });

  it("verifies intrinsic standard predicates", async () => {
    const { program } = await createProgram(
      `
      type Even = bigint with { predicate: isEven(value); };
      const good: Even = 2n;
      const bad: Even = 3n;
    `,
      ["formalContracts", "refinementTypes", "standardLibraryPredicates"],
    );
    const artifacts = program.getVerificationArtifacts!();
    assert.lengthOf(artifacts, 2);
    assert.equal(artifacts[0].status, "proved");
    assert.equal(artifacts[1].status, "failed");
  });

  it("verifies the isNegative standard predicate", async () => {
    const { program } = await createProgram(
      `
      type Negative = bigint with { predicate: isNegative(value); };
      const good: Negative = -2n;
      const bad: Negative = 2n;
    `,
      ["formalContracts", "refinementTypes", "standardLibraryPredicates"],
    );
    const artifacts = program.getVerificationArtifacts!();
    assert.lengthOf(artifacts, 2);
    assert.equal(artifacts[0].status, "proved");
    assert.equal(artifacts[1].status, "failed");
  });

  it("proves standard predicates applied to the implicit result value", async () => {
    const { program } = await createProgram(
      `
      function evenPlusTwo(n: bigint) with {
        requires: isEven(n);
        ensures: isEven(result);
      }: bigint {
        return n + 2n;
      }
    `,
      ["formalContracts", "refinementTypes", "standardLibraryPredicates"],
    );
    const artifacts = program.getVerificationArtifacts!();
    assert.lengthOf(artifacts, 1);
    assert.equal(artifacts[0].status, "proved");
    assert.isEmpty(program.getSemanticDiagnostics());
  });

  it("checks intrinsic standard predicate arguments", async () => {
    const { program } = await createProgram(
      `
      type BadType = bigint with { predicate: isEven("x"); };
      type BadArity = bigint with { predicate: divides(value); };
      type MixedNumericKinds = bigint with { predicate: divides(2n, 4); };
    `,
      ["formalContracts", "refinementTypes", "standardLibraryPredicates"],
    );
    const messages = program.getSemanticDiagnostics().map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")).join("\n");
    assert.include(messages, "number | bigint");
    assert.include(messages, "Expected 2 arguments, but got 1");
    assert.include(messages, "not assignable to parameter of type 'bigint'");
  });

  it("does not treat a shadowing function as an intrinsic standard predicate", async () => {
    const { program } = await createProgram(
      `
      function isEven(_value: bigint): boolean { return false; }
      type Local = bigint with { predicate: isEven(value); };
      const value: Local = 2n;
    `,
      ["formalContracts", "refinementTypes", "standardLibraryPredicates"],
    );
    assert.isFalse(program.getVerificationArtifacts!().every(artifact => artifact.status === "proved"));
  });

  it("maps a loop counterexample back to source variable names", async () => {
    const { program } = await createProgram(`
      function countTo(limit: bigint) with { ensures: result === limit; }: bigint {
        let current = 0n;
        while (current < limit) with {
          invariant: [current >= 0n, current <= limit];
        } {
          current += 1n;
        }
        return current;
      }
    `);
    const artifact = program.getVerificationArtifacts!().find(candidate => candidate.status === "failed" && candidate.obligation === "invariant-initialization")!;
    assert.equal(artifact.counterexample, "limit = -1");
    assert.include(ts.flattenDiagnosticMessageText(program.getSemanticDiagnostics()[0].messageText, "\n"), "Counterexample: limit = -1");
  });

  it("rejects a direct call that violates a requires clause", async () => {
    const { fileName, program } = await createProgram(`
      function successor(value: bigint) with { requires: value >= 0n; }: bigint {
        return value + 1n;
      }
      successor(-5n);
    `);
    const [artifact] = program.getVerificationArtifacts!();
    assert.equal(artifact.kind, "call-precondition");
    assert.equal(artifact.obligation, "precondition");
    assert.equal(artifact.status, "failed");
    assert.equal(artifact.counterexample, "value = -5");
    assert.equal(program.getSourceFile(fileName)!.text.slice(artifact.start, artifact.start + artifact.length), "successor(-5n)");
    assert.include(ts.flattenDiagnosticMessageText(program.getSemanticDiagnostics()[0].messageText, "\n"), "Counterexample: value = -5");
  });

  it("verifies every requires expression in an array", async () => {
    const { program } = await createProgram(`
      function bounded(value: bigint) with { requires: [value >= 0n, value <= 10n]; }: bigint {
        return value;
      }
      bounded(5n);
    `);
    const artifacts = program.getVerificationArtifacts!();
    assert.lengthOf(artifacts, 2);
    assert.isTrue(artifacts.every(artifact => artifact.kind === "call-precondition" && artifact.status === "proved"));
  });

  it("proves requires clauses at direct call sites", async () => {
    const { program } = await createProgram(`
      function successor(value: bigint) with { requires: value >= 0n; }: bigint {
        return value + 1n;
      }
      successor(5n);
    `);
    const [artifact] = program.getVerificationArtifacts!();
    assert.equal(artifact.kind, "call-precondition");
    assert.equal(artifact.status, "proved");
    assert.isEmpty(program.getSemanticDiagnostics());
  });

  it("reports unknown when a call argument depends on an unsupported callee result", async () => {
    const { program } = await createProgram(`
      declare function opaque(): bigint;
      function successor(value: bigint) with { requires: value >= 0n; }: bigint {
        return value + 1n;
      }
      successor(opaque());
    `);
    const artifact = program.getVerificationArtifacts!().find(candidate => candidate.kind === "call-precondition")!;
    assert.equal(artifact.status, "unknown");
    assert.equal(artifact.outcome, "unknown");
    assert.equal(artifact.reason?.code, "unsupported");
    assert.include(artifact.message, "outside the supported verification subset");
  });

  it("uses caller path assumptions to prove requires clauses", async () => {
    const { program } = await createProgram(`
      function successor(value: bigint) with { requires: value >= 0n; }: bigint {
        return value + 1n;
      }
      function wrapper(value: bigint) with { requires: value >= 0n; }: bigint {
        return successor(value);
      }
    `);
    const artifact = program.getVerificationArtifacts!().find(candidate => candidate.kind === "call-precondition")!;
    assert.equal(artifact.status, "proved");
    assert.isEmpty(program.getSemanticDiagnostics());
  });

  it("uses branch facts to prove requires clauses", async () => {
    const { program } = await createProgram(`
      function positive(value: bigint) with { requires: value > 0n; }: bigint {
        return value;
      }
      function guarded(value: bigint): bigint {
        if (value > 0n) positive(value);
        return value;
      }
    `);
    const artifact = program.getVerificationArtifacts!().find(candidate => candidate.kind === "call-precondition")!;
    assert.equal(artifact.status, "proved");
    assert.isEmpty(program.getSemanticDiagnostics());
  });

  it("verifies every return path", async () => {
    const { program } = await createProgram(`
      function absolute(x: bigint) with { ensures: result >= 0n; }: bigint {
        if (x >= 0n) return x;
        return -x;
      }
    `);
    const artifacts = program.getVerificationArtifacts!();
    assert.lengthOf(artifacts, 2);
    assert.isTrue(artifacts.every(artifact => artifact.status === "proved"));
  });

  it("uses TypeScript control-flow narrowing for discriminated unions", async () => {
    const { program } = await createProgram(`
      type Result =
        | { _tag: "Success"; value: bigint }
        | { _tag: "Failure"; code: bigint };

      function extract(input: Result) with { ensures: result === result; }: bigint {
        if (input._tag === "Success") return input.value;
        return input.code;
      }
    `);
    const artifacts = program.getVerificationArtifacts!();
    assert.lengthOf(artifacts, 2);
    assert.isTrue(artifacts.every(artifact => artifact.status === "proved"));
    assert.isTrue(artifacts.every(artifact => artifact.solverInput.includes("declare-datatypes")));
    assert.isEmpty(program.getSemanticDiagnostics());
  });

  it("lowers TS++ data declarations through their checker union type", async () => {
    const { program } = await createProgram(
      `
      data Result = Success(value: bigint) | Failure(code: bigint);

      function extract(input: Result) with { ensures: result === result; }: bigint {
        if (input._tag === "Success") return input.value;
        return input.code;
      }
    `,
      ["dataDeclarations", "formalContracts"],
    );
    const artifacts = program.getVerificationArtifacts!();
    assert.lengthOf(artifacts, 2);
    assert.isTrue(artifacts.every(artifact => artifact.status === "proved"));
    assert.isTrue(artifacts.every(artifact => artifact.solverInput.includes("tspp.ctor")));
    assert.isEmpty(program.getSemanticDiagnostics());
  });

  it("narrows variant fields through short-circuit operators in contract clauses", async () => {
    const { program } = await createProgram(
      `
      data Shape = Circle(radius: bigint) | Square(side: bigint);

      export function guarded(s: Shape) with {
        requires: s._tag !== "Circle" || s.radius >= 0n;
        ensures: true;
      }: bigint {
        switch (s._tag) {
          case "Circle": return s.radius;
          case "Square": return s.side;
          default: return 0n;
        }
      }

      export function ensured(s: Shape) with {
        requires: s._tag !== "Circle" || s.radius >= 0n;
        ensures: s._tag !== "Circle" || s.radius >= 0n;
      }: bigint {
        switch (s._tag) {
          case "Circle": return s.radius;
          case "Square": return s.side;
          default: return 0n;
        }
      }
    `,
      ["dataDeclarations", "formalContracts"],
    );
    const artifacts = program.getVerificationArtifacts!();
    assert.lengthOf(artifacts, 6);
    assert.isTrue(
      artifacts.every(artifact => artifact.status === "proved"),
      artifacts.map(artifact => `${artifact.status}: ${artifact.message}`).join("\n"),
    );
    // The body's own switch narrowing must be unaffected by clause-level field access.
    assert.isEmpty(program.getSemanticDiagnostics());
  });

  it("reports clause field access without a variant assumption as unknown", async () => {
    const { program } = await createProgram(
      `
      data Shape = Circle(radius: bigint) | Square(side: bigint);

      export function bare(s: Shape) with {
        requires: s.radius >= 0n;
        ensures: true;
      }: bigint {
        return 0n;
      }
    `,
      ["dataDeclarations", "formalContracts"],
    );
    const [artifact] = program.getVerificationArtifacts!();
    assert.equal(artifact.status, "unknown");
    assert.include(artifact.message, "enclosing");
    // The access is a verification concern, not a static type error.
    const diagnostics = program.getSemanticDiagnostics();
    assert.lengthOf(diagnostics.filter(diagnostic => diagnostic.code === 18090), 1);
    assert.isEmpty(diagnostics.filter(diagnostic => diagnostic.code === 2339));
  });

  it("proves contracts over non-recursive record fields", async () => {
    const { program } = await createProgram(`
      function sum(point: { x: bigint; y: bigint }) with {
        ensures: result === result;
      }: bigint {
        return point.x + point.y;
      }
    `);
    const [artifact] = program.getVerificationArtifacts!();
    assert.equal(artifact.status, "proved");
    assert.include(artifact.solverInput, "declare-datatypes");
    const diagnostics = program.getSemanticDiagnostics();
    assert.isEmpty(diagnostics, diagnostics.map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")).join("\n"));
  });

  it("supports string equality without treating strings as arithmetic", async () => {
    const { program } = await createProgram(`
      function echo(value: string) with { ensures: result === value; }: string {
        return value;
      }
    `);
    const [artifact] = program.getVerificationArtifacts!();
    assert.equal(artifact.status, "proved");
    assert.include(artifact.solverInput, "String");
    assert.isEmpty(program.getSemanticDiagnostics());
  });

  it("reports optional structures as unknown and supports recursive data", async () => {
    const optional = await createProgram(`
      type OptionalResult =
        | { _tag: "Some"; value?: bigint }
        | { _tag: "None" };
      function inspect(input: OptionalResult) with { ensures: result === result; }: bigint {
        return 0n;
      }
    `);
    const [optionalArtifact] = optional.program.getVerificationArtifacts!();
    assert.equal(optionalArtifact.status, "unknown");
    assert.include(optionalArtifact.message, "Optional property");

    const recursive = await createProgram(
      `
      data List = Nil | Cons(head: bigint, tail: List);
      function inspect(input: List) with { ensures: result === result; }: bigint {
        return 0n;
      }
    `,
      ["dataDeclarations", "formalContracts"],
    );
    const [recursiveArtifact] = recursive.program.getVerificationArtifacts!();
    assert.equal(recursiveArtifact.status, "proved");
  });

  it("reports unsupported expressions as unknown without invoking Z3", async () => {
    const { program } = await createProgram(`
      declare function identity(value: bigint): bigint;
      function opaque(x: bigint) with { ensures: result === x; }: bigint {
        return identity(x);
      }
    `);
    const [artifact] = program.getVerificationArtifacts!();
    assert.equal(artifact.status, "unknown");
    assert.include(artifact.message, "outside the supported verification subset");
    assert.include(artifact.replayableSmtLib, "No SMT query was executed");
    assert.include(ts.flattenDiagnosticMessageText(program.getSemanticDiagnostics()[0].messageText, "\n"), "verification unknown");
  });

  it("requires an explicit mathematical-real model for number", async () => {
    const withoutModel = await createProgram(`
      function addOne(x: number) with { ensures: result === x + 1; }: number { return x + 1; }
    `);
    assert.equal(withoutModel.program.getVerificationArtifacts!()[0].status, "unknown");
    assert.include(withoutModel.program.getVerificationArtifacts!()[0].message, "numberModel");
    assert.lengthOf(withoutModel.program.getSemanticDiagnostics().filter(diagnostic => diagnostic.code === 18090), 1);

    const withModel = await createProgram(`
      function addOne(x: number) with {
        numberModel: "mathematical-real";
        ensures: result === x + 1;
      }: number { return x + 1; }
    `);
    assert.equal(withModel.program.getVerificationArtifacts!()[0].status, "proved");
  });

  it("parses and prints refinement type aliases", () => {
    const file = ts.createSourceFile(
      "/file.tspp",
      'type Positive = number with { numberModel: "mathematical-real"; predicate: value > 0; };',
      ts.ScriptTarget.Latest,
      /*setParentNodes*/ true,
    );
    assert.isEmpty(file.parseDiagnostics);
    const declaration = file.statements[0] as ts.TypeAliasDeclaration;
    assert.equal(declaration.withClause?.properties.length, 2);
    assert.include(ts.createPrinter().printFile(file), 'with { numberModel: "mathematical-real"; predicate: value > 0; }');
  });

  it("proves refinement type introduction and erases its predicate", async () => {
    const { fs, program } = await createProgram(
      `
      type Positive = number with {
        numberModel: "mathematical-real";
        predicate: value > 0;
      };
      const age: Positive = 18;
    `,
      ["formalContracts", "refinementTypes"],
    );
    const [artifact] = program.getVerificationArtifacts!();
    assert.equal(artifact.kind, "refinement");
    assert.equal(artifact.obligation, "refinement-introduction");
    assert.equal(artifact.status, "proved");
    assert.isEmpty(program.getSemanticDiagnostics());
    const emit = program.emit();
    assert.isFalse(emit.emitSkipped);
    const js = fs.readFileSync("/file.js").toString();
    assert.include(js, "const age = 18");
    assert.notInclude(js, "predicate");
  });

  it("proves with constraints on newtype constructor calls", async () => {
    const { fs, program } = await createProgram(
      `
      newtype Port = bigint with {
        predicate: value > 0n && value <= 65535n;
      };
      const http = Port(80n);
    `,
      ["newtypeDeclarations", "formalContracts", "refinementTypes"],
    );
    const [artifact] = program.getVerificationArtifacts!();
    assert.equal(artifact.kind, "refinement");
    assert.equal(artifact.status, "proved");
    assert.isEmpty(program.getSemanticDiagnostics());
    const emit = program.emit();
    assert.isFalse(emit.emitSkipped);
    const js = fs.readFileSync("/file.js").toString();
    assert.include(js, "function Port(value)");
    assert.notInclude(js, "predicate");
  });

  it("rejects a refinement type introduction with a counterexample", async () => {
    const { program } = await createProgram(
      `
      type Positive = bigint with { predicate: value > 0n; };
      const bad: Positive = -1n;
    `,
      ["formalContracts", "refinementTypes"],
    );
    const [artifact] = program.getVerificationArtifacts!();
    assert.equal(artifact.kind, "refinement");
    assert.equal(artifact.status, "failed");
    assert.include(ts.flattenDiagnosticMessageText(program.getSemanticDiagnostics()[0].messageText, "\n"), "proof failed");
  });

  it("uses branch facts when proving refinement introduction", async () => {
    const { program } = await createProgram(
      `
      type Positive = bigint with { predicate: value > 0n; };
      function guarded(value: bigint): Positive {
        if (value > 0n) return value;
        return 1n;
      }
    `,
      ["formalContracts", "refinementTypes"],
    );
    const [artifact] = program.getVerificationArtifacts!();
    assert.equal(artifact.kind, "refinement");
    assert.equal(artifact.status, "proved");
  });

  it("propagates a stronger refinement through a function parameter", async () => {
    const { program } = await createProgram(
      `
      type Positive = bigint with { predicate: value > 0n; };
      type NonNegative = bigint with { predicate: value >= 0n; };
      function widen(value: Positive): NonNegative {
        return value;
      }
    `,
      ["formalContracts", "refinementTypes"],
    );
    const [artifact] = program.getVerificationArtifacts!();
    assert.equal(artifact.kind, "refinement");
    assert.equal(artifact.status, "proved");
  });

  it("does not silently accept contracts through the synchronous API", () => {
    const fileName = "/sync.tspp";
    const content = "function same(x: bigint) with { ensures: result === x; }: bigint { return x; }";
    const options: ts.CompilerOptions = { noLib: true, tsppFeatures: ["formalContracts"] };
    const fs = vfs.createFromFileSystem(
      Harness.IO,
      /*ignoreCase*/ true,
      { documents: [new documents.TextDocument(fileName, content)], cwd: "/" },
    );
    const host = new fakes.CompilerHost(fs, options);
    const program = ts.createProgram({ host, rootNames: [fileName], options });
    const [artifact] = program.getVerificationArtifacts!();
    assert.equal(artifact.status, "unknown");
    assert.include(artifact.message, "createProgramAsync");
    assert.include(ts.flattenDiagnosticMessageText(program.getSemanticDiagnostics()[0].messageText, "\n"), "verification unknown");
  });

  it("does not silently accept refinement construction through the synchronous API", () => {
    const fileName = "/sync-refinement.tspp";
    const content = `
      type Positive = bigint with { predicate: value > 0n; };
      const value: Positive = 1n;
    `;
    const options: ts.CompilerOptions = {
      noLib: true,
      target: ts.ScriptTarget.ES2022,
      tsppFeatures: ["formalContracts", "refinementTypes"],
    };
    const fs = vfs.createFromFileSystem(
      Harness.IO,
      /*ignoreCase*/ true,
      { documents: [new documents.TextDocument(fileName, content)], cwd: "/" },
    );
    const host = new fakes.CompilerHost(fs, options);
    const program = ts.createProgram({ host, rootNames: [fileName], options });
    const [artifact] = program.getVerificationArtifacts!();
    assert.equal(artifact.kind, "refinement");
    assert.equal(artifact.status, "unknown");
    assert.include(artifact.message, "createProgramAsync");
    assert.include(ts.flattenDiagnosticMessageText(program.getSemanticDiagnostics()[0].messageText, "\n"), "verification unknown");
  });

  it("does not silently accept call preconditions through the synchronous API", () => {
    const fileName = "/sync-call.tspp";
    const content = `
      function successor(value: bigint) with { requires: value >= 0n; }: bigint { return value + 1n; }
      successor(-5n);
    `;
    const options: ts.CompilerOptions = { noLib: true, target: ts.ScriptTarget.ES2022, tsppFeatures: ["formalContracts"] };
    const fs = vfs.createFromFileSystem(
      Harness.IO,
      /*ignoreCase*/ true,
      { documents: [new documents.TextDocument(fileName, content)], cwd: "/" },
    );
    const host = new fakes.CompilerHost(fs, options);
    const program = ts.createProgram({ host, rootNames: [fileName], options });
    const artifact = program.getVerificationArtifacts!().find(candidate => candidate.kind === "call-precondition")!;
    assert.equal(artifact.status, "unknown");
    assert.include(artifact.message, "createProgramAsync");
  });

  it("completes formal verification in the background for synchronous language-service programs", async () => {
    const fileName = "/language-service.tspp";
    const content = "function same(x: bigint) with { ensures: result === x; }: bigint { return x; }";
    const options: ts.CompilerOptions = { noLib: true, target: ts.ScriptTarget.ES2022, tsppFeatures: ["formalContracts"] };
    const fs = vfs.createFromFileSystem(
      Harness.IO,
      /*ignoreCase*/ true,
      { documents: [new documents.TextDocument(fileName, content)], cwd: "/" },
    );
    const host = new fakes.CompilerHost(fs, options);
    const formalHost = host as ts.CompilerHost;
    let cached: ts.AsyncFormalVerification | undefined;
    let completion: Promise<void> | undefined;
    formalHost.getResolvedAsyncFormalVerification = () => cached;
    formalHost.isAsyncFormalVerificationPending = () => completion !== undefined && cached === undefined;
    formalHost.scheduleAsyncFormalVerification = (_key, evaluation) => {
      completion = evaluation.then(artifacts => void (cached = artifacts));
    };

    const pendingProgram = ts.createProgram({ host: formalHost, rootNames: [fileName], options });
    assert.include(pendingProgram.getVerificationArtifacts!()[0].message, "running asynchronously");
    assert.isEmpty(pendingProgram.getSemanticDiagnostics().filter(diagnostic => diagnostic.code === 18090));

    await completion;
    const verifiedProgram = ts.createProgram({ host: formalHost, rootNames: [fileName], options });
    assert.equal(verifiedProgram.getVerificationArtifacts!()[0].status, "proved");
    assert.isEmpty(verifiedProgram.getSemanticDiagnostics());
  });

  it("refreshes a language-service program after background verification", async () => {
    const fileName = "/language-service-refresh.tspp";
    const content = "function bad(x: bigint) with { ensures: result > x; }: bigint { return x; }";
    const options: ts.CompilerOptions = { noLib: true, target: ts.ScriptTarget.ES2022, tsppFeatures: ["formalContracts"] };
    let notifyVerificationComplete!: () => void;
    const verificationComplete = new Promise<void>(resolve => notifyVerificationComplete = resolve);
    const host: ts.LanguageServiceHost = {
      getCompilationSettings: () => options,
      getScriptFileNames: () => [fileName],
      getScriptVersion: () => "1",
      getScriptSnapshot: name => name === fileName ? ts.ScriptSnapshot.fromString(content) : undefined,
      getCurrentDirectory: () => "/",
      getDefaultLibFileName: () => "/lib.d.ts",
      fileExists: name => name === fileName,
      readFile: name => name === fileName ? content : undefined,
      readDirectory: () => [],
      onAsyncMacroExpansionComplete: notifyVerificationComplete,
    };
    const service = ts.createLanguageService(host);
    const pendingProgram = service.getProgram()!;

    await verificationComplete;
    assert.strictEqual(service.getCurrentProgram(), pendingProgram);
    const diagnostics = service.getSemanticDiagnostics(fileName);
    assert.notStrictEqual(service.getCurrentProgram(), pendingProgram);
    assert.include(ts.flattenDiagnosticMessageText(diagnostics.find(diagnostic => diagnostic.code === 18090)!.messageText, "\n"), "proof failed");
  });

  it("constructs and verifies record literals", async () => {
    const { program } = await createProgram(`
      type Point = { x: bigint; y: bigint };
      function origin() with {
        ensures: [result.x === 0n, result.y === 0n];
      }: Point {
        return { x: 0n, y: 0n };
      }
    `);
    assert.deepEqual(program.getVerificationArtifacts!().map(artifact => artifact.status), ["proved", "proved"]);
    assert.isEmpty(program.getSemanticDiagnostics());
  });

  it("resolves structured parameters and result inside contracts", async () => {
    const { program } = await createProgram(`
      type Point = { x: bigint; y: bigint };
      function copy(point: Point) with {
        ensures: [result.x === point.x, result.y === point.y];
      }: Point {
        return point;
      }
    `);
    assert.isTrue(program.getVerificationArtifacts!().every(artifact => artifact.status === "proved"));
    assert.isEmpty(program.getSemanticDiagnostics());
  });

  it("constructs TS++ data variants and recursive data", async () => {
    const { program } = await createProgram(
      `
      data List = Nil | Cons(head: bigint, tail: List);
      function singleton(value: bigint) with {
        ensures: result._tag === "Cons";
      }: List {
        return Cons(value, Nil);
      }
    `,
      ["formalContracts", "dataDeclarations"],
    );
    const [artifact] = program.getVerificationArtifacts!();
    assert.equal(artifact.status, "proved");
    assert.include(artifact.solverInput, "declare-datatypes");
    assert.isEmpty(program.getSemanticDiagnostics());
  });

  it("uses checker-narrowed switch control flow", async () => {
    const { program } = await createProgram(
      `
      data ParseResult = Parsed(value: bigint) | Rejected(code: string);
      function magnitude(input: ParseResult) with { ensures: result >= 0n; }: bigint {
        switch (input._tag) {
          case "Parsed":
            if (input.value >= 0n) return input.value;
            return -input.value;
          case "Rejected":
            return 0n;
        }
      }
    `,
      ["formalContracts", "dataDeclarations"],
    );
    assert.isTrue(program.getVerificationArtifacts!().every(artifact => artifact.status === "proved"));
  });

  it("decodes structured counterexamples", async () => {
    const { program } = await createProgram(`
      type Point = { x: bigint; y: bigint };
      function bad(point: Point) with { ensures: result.x === 0n; }: Point {
        return point;
      }
    `);
    const [artifact] = program.getVerificationArtifacts!();
    assert.equal(artifact.status, "failed");
    assert.match(artifact.counterexample!, /^point = \{ x: -?\d+, y: -?\d+ \}$/);
  });

  it("propagates an already requested cancellation", async () => {
    const token: ts.CancellationToken = {
      isCancellationRequested: () => true,
      throwIfCancellationRequested: () => {
        throw new ts.OperationCanceledException();
      },
    };
    let error: unknown;
    try {
      await ts.createProgramAsync({
        rootNames: [],
        options: { noLib: true, tsppFeatures: ["formalContracts"] },
        cancellationToken: token,
      });
    }
    catch (caught) {
      error = caught;
    }
    assert.instanceOf(error, ts.OperationCanceledException);
  });

  describe("program semantics and trust boundaries", () => {
    const artifactsNamed = (program: ts.Program, fragment: string) => program.getVerificationArtifacts!().filter(artifact => artifact.name.includes(fragment));

    it("proves bigint '%' and '/' with JavaScript's truncating semantics", async () => {
      const { program } = await createProgram(`
        function remainderOfNegative(a: bigint) with {
          requires: a < 0n;
          ensures: result <= 0n;
        }: bigint {
          return a % 3n;
        }
        function halve(a: bigint) with {
          requires: a === -7n;
          ensures: result === -3n;
        }: bigint {
          return a / 2n;
        }
      `);
      const artifacts = program.getVerificationArtifacts!();
      // SMT 'mod' would make 'a % 3n' non-negative and 'div' would round -3.5 down to -4.
      assert.deepEqual(artifacts.map(artifact => `${artifact.name}: ${artifact.status}`), [
        "remainderOfNegative postcondition 1, return path 1: proved",
        "halve postcondition 1, return path 1: proved",
      ]);
      assert.include(artifacts[0].solverInput, "(define-fun tspp.js.trunc.rem ((a Int) (b Int)) Int");
      assert.include(artifacts[1].solverInput, "(define-fun tspp.js.trunc.div ((a Int) (b Int)) Int");
      assert.isEmpty(program.getSemanticDiagnostics());
    });

    it("emits a definedness obligation for a variable divisor", async () => {
      const { program } = await createProgram(`
        function unchecked(a: bigint, b: bigint): bigint {
          assert: a === a;
          return a % b;
        }
        function checked(a: bigint, b: bigint) with { requires: b > 0n; }: bigint {
          let total = 0n;
          if (a > 0n) total = a / b;
          return total;
        }
      `);
      const [failed] = artifactsNamed(program, "unchecked divisor");
      assert.equal(failed.kind, "program-semantics");
      assert.equal(failed.obligation, "nonzero-divisor");
      assert.equal(failed.name, "unchecked divisor of 'a % b' is non-zero");
      assert.equal(failed.status, "failed");
      assert.include(failed.counterexample!, "b = 0");
      const [proved] = artifactsNamed(program, "checked divisor of 'a / b'");
      assert.equal(proved.status, "proved");
      const messages = program.getSemanticDiagnostics().map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
      assert.deepEqual(messages, ["unchecked divisor of 'a % b' is non-zero: proof failed. The SMT solver found a counterexample. Counterexample: a = 0, b = 0."]);
    });

    it("treats specifications as logic without runtime obligations", async () => {
      const { program } = await createProgram(`
        function same(a: bigint, b: bigint) with {
          requires: b !== 0n && a % b === 0n;
          ensures: result % b === 0n;
        }: bigint {
          return a;
        }
      `);
      const artifacts = program.getVerificationArtifacts!();
      assert.deepEqual(artifacts.map(artifact => artifact.kind), ["function-contract"]);
      assert.equal(artifacts[0].status, "proved");
    });

    it("reports the trusted inputs a proof relies on", async () => {
      const { program } = await createProgram(`
        function trusted(x: bigint): bigint {
          assume: x > 10n;
          assume: x < 1000n;
          assert: x > 5n;
          return x;
        }
      `);
      const [assertion] = program.getVerificationArtifacts!().filter(artifact => artifact.kind === "assertion");
      assert.equal(assertion.status, "proved");
      assert.deepEqual(assertion.trustedInputs, ["assume: x > 10n (file.tspp:3:19)"]);
      assert.include(assertion.message, "The proof relies on trusted input: assume: x > 10n (file.tspp:3:19).");
      assert.include(assertion.solverInput, "; [assumption, trusted] assume: x > 10n (file.tspp:3:19)\n(assert (! (> v0 10) :named tspp.trusted.0))");

      const { program: untrusted } = await createProgram(`
        function plain(x: bigint) with { requires: x > 10n; ensures: result > 5n; }: bigint { return x; }
      `);
      const [contract] = untrusted.getVerificationArtifacts!();
      assert.equal(contract.status, "proved");
      assert.isUndefined(contract.trustedInputs);
      assert.include(contract.solverInput, "; [precondition] requires: x > 10n (file.tspp:2:52)");
    });

    it("reports the mathematical-real model as a trusted assumption", async () => {
      const { program } = await createProgram(`
        function addOne(x: number) with {
          numberModel: "mathematical-real";
          ensures: result > x;
        }: number { return x + 1; }
      `);
      const [artifact] = program.getVerificationArtifacts!();
      assert.equal(artifact.status, "proved");
      assert.lengthOf(artifact.trustedInputs!, 1);
      assert.include(artifact.trustedInputs![0], 'numberModel "mathematical-real"');
      assert.include(artifact.solverInput, "; Trusted model assumptions:");
    });

    it("verifies number arithmetic under the safe-integer model", async () => {
      const { program } = await createProgram(`
        function sum(n: number) with {
          numberModel: "safe-integer";
          requires: n >= 0 && n <= 1000;
          ensures: result >= 0;
        }: number {
          let i = 0;
          let total = 0;
          while (i < n) with { invariant: [i >= 0, i <= n, total >= 0, total <= i * 1000]; } {
            total += i;
            i += 1;
          }
          return total;
        }
        // Declaring a number model is enough to verify a function's runtime obligations.
        function double(x: number) with { numberModel: "safe-integer"; }: number {
          return x * 2;
        }
      `);
      const artifacts = program.getVerificationArtifacts!();
      const sumArtifacts = artifacts.filter(artifact => artifact.name.startsWith("sum "));
      assert.isTrue(sumArtifacts.every(artifact => artifact.status === "proved"), sumArtifacts.map(artifact => `${artifact.name}: ${artifact.status} ${artifact.message}`).join("\n"));
      // Specifications are logic: 'i * 1000' in the invariant creates no range obligation.
      assert.deepEqual(sumArtifacts.filter(artifact => artifact.kind === "program-semantics").map(artifact => artifact.name), [
        "sum 'total += i' stays within the safe-integer range",
        "sum 'i += 1' stays within the safe-integer range",
      ]);
      assert.include(sumArtifacts[0].solverInput, "(set-logic QF_LIA)");
      const [overflow] = artifactsNamed(program, "double");
      assert.equal(overflow.obligation, "safe-integer-range");
      assert.equal(overflow.status, "failed");
      assert.match(overflow.counterexample!, /^x = -?\d{16}$/);
    });

    it("keeps values the safe-integer model cannot represent outside the subset", async () => {
      const { program } = await createProgram(`
        function half(x: number) with { numberModel: "safe-integer"; ensures: result >= 0; }: number { return 0.5; }
        function ratio(x: number) with { numberModel: "safe-integer"; ensures: result >= 0; }: number { return x / 2; }
        function field(point: { x: number }) with { numberModel: "safe-integer"; ensures: result >= 0; }: number { return 1; }
      `);
      const messages = program.getVerificationArtifacts!().map(artifact => `${artifact.status}: ${artifact.message}`);
      assert.deepEqual(messages, [
        "unknown: Numeric literal '0.5' is not a safe integer.",
        "unknown: Operator '/' on number is not integer division and is outside the safe-integer model.",
        `unknown: Property 'x' cannot be lowered: A number field of a structured value is outside the "safe-integer" number model in this version.`,
      ]);
    });

    it("accepts only known number models", async () => {
      const { program } = await createProgram(`
        function a(x: number) with { numberModel: "safe-integer"; ensures: result === x; }: number { return x; }
        function b(x: number) with { numberModel: "ieee-float64"; ensures: result === x; }: number { return x; }
      `);
      const messages = program.getSemanticDiagnostics().map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
      assert.isTrue(messages.some(message => message.includes("numberModel: invalid value")), messages.join("\n"));
      assert.isFalse(messages.some(message => message.includes("a postcondition")) && messages.length > 2);
    });

    it("prints standard predicates as library definitions", async () => {
      const { program } = await createProgram(
        `
        type Even = bigint with { predicate: isEven(value); };
        const four: Even = 4n;
      `,
        ["formalContracts", "refinementTypes", "standardLibraryPredicates"],
      );
      const [artifact] = program.getVerificationArtifacts!();
      assert.equal(artifact.status, "proved");
      assert.include(artifact.solverInput, "; TS++ standard predicate isEven over Int (lib.tspp.d.ts)");
      assert.include(artifact.solverInput, "(define-fun tspp.std.isEven.Int ((value Int)) Bool (= (mod value 2) 0))");
      assert.include(artifact.solverInput, "(assert (not (tspp.std.isEven.Int 4)))");
    });
  });
});
