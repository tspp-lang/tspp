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
