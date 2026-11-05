// `final`, `sealed` and final members belong to a declaration, not to a name: plugin state lives as long as the process,
// and one program can hold any number of unrelated classes with the same name.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { ts, usePlugins, createProgram, diagnosticMessages } = require("../../test-support/compile.cjs");
const { definePlugin, TSPP_PLUGIN_API_VERSION } = require("@tspp/plugin-sdk");
const { advancedClassesPlugin } = require("../dist");

usePlugins(advancedClassesPlugin);

const messages = files => diagnosticMessages(createProgram(files).program);

const unrelated = {
  "final class": "export final class A {}",
  "sealed class": "export sealed class A {}",
  "class with a final member": "export class A { final m(): number { return 1; } }",
};

for (const [kind, declaration] of Object.entries(unrelated)) {
  const ordinary = "class A { m(): number { return 2; } } export class B extends A { m(): number { return 3; } }";

  test(`a ${kind} leaves an unrelated class of the same name alone`, () => {
    assert.deepEqual(messages({ "/restricted.tspp": declaration, "/ordinary.tspp": ordinary }), []);
    assert.deepEqual(messages({ "/ordinary.tspp": ordinary, "/restricted.tspp": declaration }), []);
  });

  test(`a ${kind} leaves the next program alone`, () => {
    assert.deepEqual(messages({ "/restricted.tspp": declaration }), []);
    assert.deepEqual(messages({ "/ordinary.tspp": ordinary }), []);
  });
}

test("a file that imports nothing and declares nothing of that name is not affected", () => {
  assert.deepEqual(messages({
    "/restricted.tspp": "export final class A {}",
    "/other.tspp": "export class A {} export class B extends A {}",
    "/third.tspp": `import { A } from "./other"; export class C extends A {}`,
  }), []);
});

const restricted = {
  "/lib.tspp": `
    export final class Closed {}
    export sealed class Family {}
    export class Locked { final kept(): number { return 1; } other(): number { return 2; } }
  `,
};
const using = body => messages({ ...restricted, "/main.tspp": body }).join("\n");

test("the rules follow the class through a renaming import", () => {
  assert.match(using(`import { Closed as Open } from "./lib"; export class A extends Open {}`), /Cannot inherit from final class 'Closed'/);
  assert.match(using(`import { Family as Open } from "./lib"; export class A extends Open {}`), /Cannot extend sealed class 'Family'/);
  assert.match(using(`import { Locked as Open } from "./lib"; export class A extends Open { kept(): number { return 2; } }`), /Cannot override final member 'kept' of class 'Locked'/);
});

test("the rules follow the class through a namespace import", () => {
  assert.match(using(`import * as lib from "./lib"; export class A extends lib.Closed {}`), /Cannot inherit from final class 'Closed'/);
  assert.match(using(`import * as lib from "./lib"; export class A extends lib.Family {}`), /Cannot extend sealed class 'Family'/);
  assert.match(using(`import * as lib from "./lib"; export class A extends lib.Locked { kept(): number { return 2; } }`), /Cannot override final member 'kept'/);
});

test("the rules follow the class when the subclass reuses its name", () => {
  assert.match(using(`import { Closed as Base } from "./lib"; export class Closed extends Base {}`), /Cannot inherit from final class 'Closed'/);
});

test("the rules hold through a re-export", () => {
  const files = { ...restricted, "/barrel.tspp": `export { Closed as Renamed } from "./lib";` };
  assert.match(messages({ ...files, "/main.tspp": `import { Renamed } from "./barrel"; export class A extends Renamed {}` }).join(), /Cannot inherit from final class 'Closed'/);
});

test("a sealed class can be extended in its own file, a final class cannot", () => {
  assert.deepEqual(messages("sealed class A {} export class B extends A {}"), []);
  assert.match(messages("final class A {} export class B extends A {}").join(), /Cannot inherit from final class 'A'/);
});

test("a nested class shadowing a restricted one is judged by what the name resolves to", () => {
  const source = `
    final class A {}
    export function f() { class A {} return class extends A {}; }
    export class B extends A {}
  `;
  assert.deepEqual(messages(source), ["Cannot inherit from final class 'A'."]);
});

test("an unresolved base reports only that it cannot be found", () => {
  assert.deepEqual(messages({ "/restricted.tspp": "export final class A {}", "/main.tspp": "export class B extends A {}" }), ["Cannot find name 'A'."]);
});

test("a final member binds every class below it, not only the direct subclass", () => {
  const chain = "export class Top { final kept(): number { return 1; } other(): number { return 2; } } export class Mid extends Top {} export class Low extends Mid {}";
  assert.deepEqual(messages(`${chain} export class Sub extends Mid { kept(): number { return 2; } }`), ["Cannot override final member 'kept' of class 'Top'."]);
  assert.deepEqual(messages(`${chain} export class Sub extends Low { kept(): number { return 2; } }`), ["Cannot override final member 'kept' of class 'Top'."]);
  assert.deepEqual(messages(`${chain} export const Sub = class extends Low { kept(): number { return 2; } };`), ["Cannot override final member 'kept' of class 'Top'."]);
  assert.deepEqual(messages(`${chain} export class Sub extends Low { other(): number { return 3; } }`), []);
});

test("a final member is followed across files, renames and generic classes", () => {
  assert.match(messages({
    "/top.tspp": "export class Top<T> { final kept(value: T): T { return value; } }",
    "/mid.tspp": `import { Top as Base } from "./top"; export class Mid<T> extends Base<T> {}`,
    "/main.tspp": `import * as mid from "./mid"; export class Sub extends mid.Mid<number> { kept(value: number): number { return value; } }`,
  }).join(), /Cannot override final member 'kept' of class 'Top'/);
});

test("a final member is followed through declaration files", () => {
  assert.match(messages({
    "/lib/index.d.tspp": "export declare class Top { final kept(): number; } export declare class Mid extends Top {}",
    "/main.tspp": `import { Mid } from "./lib/index"; export class Sub extends Mid { kept(): number { return 2; } }`,
  }).join(), /Cannot override final member 'kept' of class 'Top'/);
});

test("one override reports once, against the nearest class that made it final", () => {
  assert.deepEqual(messages(`
    export class Top { final kept(): number { return 1; } }
    export class Mid extends Top { final kept(): number { return 2; } }
    export class Sub extends Mid { kept(): number { return 3; } }
  `), ["Cannot override final member 'kept' of class 'Top'.", "Cannot override final member 'kept' of class 'Mid'."]);
});

test("the walk up follows what each name resolves to", () => {
  assert.deepEqual(messages({
    "/other.tspp": "export class Top { final kept(): number { return 1; } } export class Mid extends Top {}",
    "/main.tspp": "class Top { kept(): number { return 2; } } class Mid extends Top {} export class Sub extends Mid { kept(): number { return 3; } }",
  }), []);
});

test("a circular base ends the walk up", () => {
  const found = messages("class A extends B { final kept(): number { return 1; } } class B extends A {} export class C extends B { kept(): number { return 2; } }");
  assert.ok(found.some(message => /in its own base expression/.test(message)), found.join());
  // The checker drops a circular base, so the circular error is what this code gets; `A` declaring its own member is no override.
  assert.deepEqual(found.filter(message => /final member/.test(message)), []);
});

test("the rules follow the class through a variable", () => {
  const lib = "export final class Closed {} export sealed class Family {} export class Locked { final kept(): number { return 1; } other(): number { return 2; } }";
  const via = body => messages({ "/lib.tspp": lib, "/main.tspp": body });
  assert.deepEqual(via(`import { Closed } from "./lib"; const Base = Closed; export class Sub extends Base {}`), ["Cannot inherit from final class 'Closed'."]);
  assert.deepEqual(via(`import { Family } from "./lib"; const Base = Family; export class Sub extends Base {}`), ["Cannot extend sealed class 'Family' outside of its declaring file."]);
  assert.deepEqual(via(`import { Locked } from "./lib"; const Base = Locked; export class Sub extends Base { kept(): number { return 2; } }`), ["Cannot override final member 'kept' of class 'Locked'."]);
  assert.deepEqual(via(`import { Locked } from "./lib"; const Base = Locked; export class Sub extends Base { other(): number { return 3; } }`), []);
});

test("the rules follow the class through a function that returns it", () => {
  const identity = "function same<T>(base: T): T { return base; }";
  assert.deepEqual(messages(`final class Closed {} ${identity} export class Sub extends same(Closed) {}`), ["Cannot inherit from final class 'Closed'."]);
  assert.deepEqual(messages(`class Locked { final kept(): number { return 1; } } ${identity} export class Sub extends same(Locked) { kept(): number { return 2; } }`), ["Cannot override final member 'kept' of class 'Locked'."]);
});

test("the walk up passes through an intermediate class that extends a variable or call", () => {
  assert.deepEqual(messages(`
    class Locked { final kept(): number { return 1; } }
    const Base = Locked;
    class Mid extends Base {}
    const Named = class extends Mid {};
    export class Sub extends Named { kept(): number { return 2; } }
  `), ["Cannot override final member 'kept' of class 'Locked'."]);
});

test("the rules follow the class through a mixin", () => {
  const mixin = `
    type Constructor = new (...args: any[]) => object;
    function Tagged<T extends Constructor>(base: T) { return class extends base { tag = 1; }; }
  `;
  const compile = source => diagnosticMessages(createProgram(source, { noLib: false }).program);
  assert.deepEqual(compile(`${mixin} class Open {} export class Sub extends Tagged(Open) {}`), []);
  assert.deepEqual(compile(`${mixin} final class Closed {} export class Sub extends Tagged(Closed) {}`), ["Cannot inherit from final class 'Closed'."]);
  assert.deepEqual(compile(`${mixin} class Locked { final kept(): number { return 1; } } export class Sub extends Tagged(Locked) { kept(): number { return 2; } }`), ["Cannot override final member 'kept' of class 'Locked'."]);
});

test("a value whose type merely resembles a restricted class is not that class", () => {
  assert.deepEqual(messages(`
    final class Closed { value = 1; }
    class Lookalike { value = 2; }
    const Base = Lookalike;
    export class Sub extends Base {}
    export const closed = new Closed();
  `), []);
});

test("the rules hold for a declaration a program rebuild copied", () => {
  // Replacing a statement inside a class makes the rebuilt program bind a copy of the class, not the node that was parsed.
  const statement = "let replaced = 1;";
  const source = `
    export final class Closed { m(): void { ${statement} } }
    export sealed class Family { m(): void { ${statement} } }
    export class Inside extends Family {}
    export class Sub extends Closed {}
  `;
  const replaced = [];
  const replacements = [...source.matchAll(new RegExp(statement, "g"))].map(({ index }) => ({
    start: index,
    end: index + statement.length,
    replace(node) {
      replaced.push(node);
      return [ts.factory.createEmptyStatement()];
    },
  }));
  usePlugins(definePlugin({
    manifest: { id: "test.class-identity-rebuild", version: "0.0.0", apiVersion: TSPP_PLUGIN_API_VERSION, displayName: "Rebuild" },
    facets: {
      compiler: {
        activate(context) {
          context.onDispose(context.compiler.registerProgramRebuilder({
            id: "class-identity-rebuild",
            rebuild: program => program.getSourceFile("/rebuilt.tspp") ? { replacements: new Map([["/rebuilt.tspp", replacements]]) } : undefined,
          }));
        },
      },
    },
  }));
  assert.deepEqual(messages({ "/rebuilt.tspp": source }), ["Cannot inherit from final class 'Closed'."]);
  assert.equal(replaced.length, 2);
  const outside = { "/rebuilt.tspp": source, "/outside.tspp": `import { Family } from "./rebuilt"; export class Other extends Family {}` };
  assert.deepEqual(messages(outside).sort(), ["Cannot extend sealed class 'Family' outside of its declaring file.", "Cannot inherit from final class 'Closed'."]);
});
