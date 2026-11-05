import type { TSPPTypeScript } from "@tspp/plugin-sdk/compiler";
import type * as TS from "typescript-upstream";

/**
 * Runs the generator of a `handle` with `control` clauses and promises its value, or its error. The generator yields
 * `[handler, operation, arguments]` where it suspends; the driver calls the handler's clause with the arguments and a
 * continuation, which goes on with the generator once, now or later. A clause that resumes before it returns goes on in
 * the same loop rather than deeper in the stack. A clause that throws before it settles throws where it was performed; one
 * that throws after, or that settles twice, rejects the promise, or throws once it has settled.
 */
const source = `function drive(generator, onReturn) {
    return new Promise((resolve, reject) => {
        let next = ["next", undefined];
        let running = false;
        let finished = false;
        const fail = error => {
            finished = true;
            try { generator.return(undefined); } catch {}
            reject(error);
        };
        const step = () => {
            running = true;
            while (next && !finished) {
                const [method, value] = next;
                next = undefined;
                let result;
                try { result = generator[method](value); }
                catch (error) { finished = true; reject(error); break; }
                if (result.done) {
                    finished = true;
                    try { resolve(onReturn ? onReturn(result.value) : result.value); }
                    catch (error) { reject(error); }
                    break;
                }
                const [handler, operation, args] = result.value;
                let settled = false;
                const settle = (how, outcome) => {
                    if (settled) {
                        const error = new Error("A continuation can be resumed or aborted only once.");
                        if (finished) throw error;
                        return fail(error);
                    }
                    settled = true;
                    next = [how, outcome];
                    if (!running && !finished) step();
                };
                try { handler[operation](...args, { resume: resumed => settle("next", resumed), abort: error => settle("throw", error) }); }
                catch (error) {
                    if (!settled) { settled = true; next = ["throw", error]; }
                    else fail(error);
                }
            }
            running = false;
        };
        step();
    });
}`;

/** The driver as a declaration named `name`, parsed afresh for each file and synthesized, so it prints from its nodes. */
export function createDriver(ts: TSPPTypeScript, name: TS.Identifier): TS.FunctionDeclaration {
    const parsed = ts.createSourceFile("driver.js", source, ts.ScriptTarget.Latest, /*setParentNodes*/ false, ts.ScriptKind.JS).statements[0] as TS.FunctionDeclaration;
    // Module output substitutes names of the parse tree, and these must not look like they belong to one.
    const detach = (node: TS.Node): void => {
        ts.setTextRange(node, { pos: -1, end: -1 });
        (node as { flags: TS.NodeFlags; }).flags |= ts.NodeFlags.Synthesized;
        ts.forEachChild(node, detach, nodes => {
            ts.setTextRange(nodes, { pos: -1, end: -1 });
            nodes.forEach(detach);
        });
    };
    detach(parsed);
    return ts.factory.updateFunctionDeclaration(parsed, parsed.modifiers, parsed.asteriskToken, name, parsed.typeParameters, parsed.parameters, parsed.type, parsed.body);
}
