import { getTSPPTypeOperations } from "../../../compiler/tspp/types.js";
import * as documents from "../../_namespaces/documents.js";
import * as fakes from "../../_namespaces/fakes.js";
import * as Harness from "../../_namespaces/Harness.js";
import * as ts from "../../_namespaces/ts.js";
import * as vfs from "../../_namespaces/vfs.js";

describe("unittests:: tspp:: type operations", () => {
    function fixture() {
        const source = `
            type ReadonlyContext = readonly [head: "int", tail?: "bool"];
            type MutableContext = [head: "int", tail?: "bool"];
            type ReadonlyTail = readonly [tail?: "bool"];
            type MutableTail = [tail?: "bool"];
            type OpenContext = readonly [head: "int", ...rest: "bool"[]];
            type OrdinaryArray = readonly "int"[];
        `;
        const fs = vfs.createFromFileSystem(Harness.IO, /*ignoreCase*/ true, {
            documents: [new documents.TextDocument("/context.tspp", source)],
            cwd: "/",
        });
        const options: ts.CompilerOptions = { noLib: true, strict: true };
        const host = new fakes.CompilerHost(fs, options);
        const program = ts.createProgram({ host, rootNames: ["/context.tspp"], options });
        const checker = program.getTypeChecker();
        const operations = getTSPPTypeOperations(program)!;
        const file = program.getSourceFile("/context.tspp")!;
        const aliases = new Map(file.statements.filter(ts.isTypeAliasDeclaration).map(node => [node.name.text, checker.getTypeFromTypeNode(node.type)]));
        const type = (name: string) => aliases.get(name)! as never;
        return { checker, operations, type };
    }

    it("retains readonly and optional context tails without allowing mutation", () => {
        const { checker, operations, type } = fixture();
        const tail = operations.sliceTupleType(type("ReadonlyContext"), 1)! as unknown as ts.Type;
        assert.equal(checker.typeToString(tail), "readonly [tail?: \"bool\" | undefined]");
        assert.isTrue(checker.isTypeAssignableTo(tail, type("ReadonlyTail")));
        assert.isFalse(checker.isTypeAssignableTo(tail, type("MutableTail")));
        const empty = operations.sliceTupleType(type("ReadonlyContext"), 2)! as unknown as ts.Type;
        assert.equal(checker.typeToString(empty), "readonly []");
    });

    it("keeps mutable context tails mutable and respects the exclusive end", () => {
        const { checker, operations, type } = fixture();
        const tail = operations.sliceTupleType(type("MutableContext"), 1)! as unknown as ts.Type;
        assert.isTrue(checker.isTypeAssignableTo(tail, type("MutableTail")));
        const head = operations.sliceTupleType(type("ReadonlyContext"), 0, 1)! as unknown as ts.Type;
        assert.equal(checker.typeToString(head), "readonly [head: \"int\"]");
    });

    it("does not guess a fixed tail through an open rest or an ordinary array", () => {
        const { operations, type } = fixture();
        assert.isUndefined(operations.sliceTupleType(type("OpenContext"), 1));
        assert.isUndefined(operations.sliceTupleType(type("OrdinaryArray"), 1));
    });
});
