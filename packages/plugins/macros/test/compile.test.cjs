// End-to-end behavior ported from the legacy-monolith compiler tests (unittests/tspp/macros.ts). The other macro
// cases already live in the compiler's own unit tests, which cover the language-service and asynchronous hosts.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { usePlugins, createProgram, diagnosticMessages } = require("../../test-support/compile.cjs");
const { macrosPlugin } = require("../dist");

usePlugins(macrosPlugin);

test("recursively expands macro invocations in a synchronous program", () => {
  const { program } = createProgram({ "/file.tspp": `
    macro function first([target], context) {
      return context.factory.createMacroInvocationStatement(
        context.factory.createIdentifier("second"),
        [context.factory.createIdentifier(target.name)],
      );
    }
    macro function second([target], context) {
      return context.factory.createMacroInvocationStatement(
        context.factory.createIdentifier("finish"),
        [context.factory.createIdentifier(target.name)],
      );
    }
    macro function finish([target], context) {
      return context.factory.createVariableStatement(
        undefined,
        context.factory.createVariableDeclarationList([
          context.factory.createVariableDeclaration(
            target.name + "ExpandedName",
            undefined,
            context.factory.createLiteralTypeNode(context.factory.createStringLiteral(target.name)),
            context.factory.createStringLiteral(target.name),
          ),
        ]),
      );
    }
    interface User { id: number }
    macro first(User);
    const checked: "User" = UserExpandedName;
  ` }, { noImplicitAny: false });
  assert.deepEqual(diagnosticMessages(program), []);
  const expansion = program.getMacroExpansions("/file.tspp")[0].text;
  assert.match(expansion, /var UserExpandedName: "User" = "User";/);
  assert.doesNotMatch(expansion, /macro (second|finish)/);
});
