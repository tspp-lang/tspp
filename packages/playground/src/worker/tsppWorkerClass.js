/**
 * The tspp TypeScriptWorker class, factored out of the worker entry so it can be exercised
 * directly (see scripts/worker-spike.mjs) with a mock of monaco's mirror-model context.
 *
 * The class extends the TypeScriptWorker vendored inside monaco-editor, so the worker
 * protocol always matches the monaco version the client uses.
 */
import { TypeScriptWorker } from "monaco-editor/languages/features/typescript/tsWorker.js";
import { solveBatch as solveZ3Batch } from "./z3Bridge.js";

export class TsppWorker extends TypeScriptWorker {
  /**
   * @param {*} ctx monaco's IWorkerContext (mirror-models host)
   * @param {*} createData
   * @param {*} tspp the loaded compiler bundle module (the worker entry only constructs
   *   this class after the runtime-fetched compiler module has finished loading, so it
   *   arrives synchronously — no construction-time race with incoming RPC requests)
   */
  constructor(ctx, createData, tspp) {
    super(ctx, createData);
    this._tspp = tspp;
    // Replace the stock language service (created in the base constructor with
    // monaco's bundled TypeScript) with one from the tspp compiler bundle.
    this._languageService = tspp.createLanguageService(this);
  }

  get tspp() {
    return this._tspp;
  }

  getScriptKind(fileName) {
    if (fileName.endsWith(".tspp") || fileName.endsWith(".d.tspp")) {
      return this.tspp.ScriptKind.TS;
    }
    return super.getScriptKind(fileName);
  }

  /**
   * Formal-verification obligations for the Verify sidebar tab: a plain passthrough
   * to the compiler's program API. With the host solver seam wired (see
   * setCompilerHost), the artifacts the program carries are already final — proved,
   * failed with a counterexample, or unknown with a reason — because the compiler
   * produced them after its own async solve through this host.
   *
   * @returns {Promise<object[]>}
   */
  async getVerificationArtifacts() {
    const program = this._languageService.getProgram();
    return program?.getVerificationArtifacts?.() ?? [];
  }

  /**
   * The compiler's verification seam (CompilerHost.solveVerificationQueries,
   * @internal): the services layer calls languageServiceHost.setCompilerHost
   * with its constructed CompilerHost, and the compiler's
   * runVerificationQueries prefers that hook over its node:worker_threads Z3
   * worker when present. This is the whole browser Z3 integration — the
   * compiler then drives artifacts, the 18090 diagnostics, and its own
   * placeholder→resolved program sync end to end.
   *
   * @param {*} compilerHost the compiler's CompilerHost for this language service
   */
  setCompilerHost(compilerHost) {
    compilerHost.solveVerificationQueries = (requests, cancellationToken) => solveZ3Batch(requests, cancellationToken);
    compilerHost.resolveMacroModule = specifier => specifier === "ts-plus-plus" ? this.tspp : undefined;
    compilerHost.evaluateMacroModule = (javascript, fileName, requireLocal, module) => evaluateMacroModule(javascript, fileName, requireLocal, module);
  }
}

/**
 * The compiler's macro execution seam (CompilerHost.evaluateMacroModule,
 * @internal): runs the emitted CommonJS macro module inside this worker. Local
 * macro sources and the "ts-plus-plus" binding come from requireLocal; there
 * is no module loader behind it, so any other specifier is reported as missing.
 *
 * @param {string} javascript
 * @param {string} fileName
 * @param {(specifier: string) => unknown} requireLocal
 * @param {{ exports: Record<string, unknown> }} module
 */
function evaluateMacroModule(javascript, fileName, requireLocal, module) {
  const require = specifier => {
    const local = requireLocal(specifier);
    if (local !== undefined) return local;
    throw new Error(`Cannot find module '${specifier}': the playground only provides local macro sources and 'ts-plus-plus'.`);
  };
  const directoryName = fileName.slice(0, Math.max(0, fileName.lastIndexOf("/"))) || "/";
  new Function("require", "exports", "module", "__filename", "__dirname", javascript)(require, module.exports, module, fileName, directoryName);
}
