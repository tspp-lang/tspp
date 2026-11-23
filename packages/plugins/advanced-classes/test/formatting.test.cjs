const assert = require("node:assert/strict");
const { test } = require("node:test");
const { usePlugins, formatDocument, withoutIndentation, withDoubledSpaces } = require("../../test-support/compile.cjs");

usePlugins(require("../dist"));

const formatted = `class Counter {
    field count: number = 0 {
        get() {
            return field;
        }
        set(next) {
            if (next >= 0) {
                field = next;
            }
        }
    }
}
`;

test("formatting keeps fields and their accessors as they are laid out", () => {
  assert.equal(formatDocument(formatted), formatted);
});

test("formatting restores the indentation of fields and their accessors", () => {
  assert.equal(formatDocument(withoutIndentation(formatted)), formatted);
});

test("formatting tidies the spaces of fields and their accessors", () => {
  assert.equal(formatDocument(withDoubledSpaces(formatted)), formatted);
});

const severalBases = `class Point {
    constructor(public x: number) { }
}

class Named {
    #label = "unnamed";
    get label(): string {
        return this.#label;
    }
}

/** A named point. */
export class Landmark extends Point, Named {
    describe(): string {
        return this.label + "@" + this.x;
    }
}
`;

test("formatting lays out a class with several bases like any other class", () => {
  assert.equal(formatDocument(severalBases), severalBases);
  assert.equal(formatDocument(withoutIndentation(severalBases)), severalBases);
  assert.equal(formatDocument(withDoubledSpaces(severalBases)), severalBases);
});

const nested = `class Point {
    constructor(public x: number) { }
}

class Named { }

export function make(): unknown {
    const origin = 1;
    // A sealed point.
    final class Fixed { }
    // A named point.
    /** Documented. */
    class Landmark extends Point, Named { }
    // A single instance.
    object Registry {
        size = origin;
    }
    return [Fixed, Landmark, Registry];
}
`;

test("formatting indents the comments above plugin classes nested in a function", () => {
  assert.equal(formatDocument(nested), nested);
  assert.equal(formatDocument(withoutIndentation(nested)), nested);
  assert.equal(formatDocument(withDoubledSpaces(nested)), nested);
});


const mappedBases = `class A { constructor(n: number) { } }
class B { }
class C extends A, B {
    constructor() {
        super({ A: [1], B: [] });
    }
    m() { return super[A].toString(); }
}
`;

test("formatting preserves mapped super and indents its enclosing class", () => {
  assert.equal(formatDocument(mappedBases), mappedBases);
  assert.equal(formatDocument(withoutIndentation(mappedBases)), mappedBases);
  assert.equal(formatDocument(withDoubledSpaces(mappedBases)), mappedBases);
});
