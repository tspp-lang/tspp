/** Messages between the page and the language worker (src/worker/languageWorker.ts). */

export interface FeatureDefinition {
  readonly id: string;
  /** Plugin name written in tsconfig.json, such as `ts-plus-plus/plugins/modern-syntax`. */
  readonly packageName: string;
  readonly name: string;
  readonly dependencies: readonly string[];
  readonly description?: string;
  /** The output tabs this feature adds, from its editor contribution. */
  readonly outputs: readonly { readonly id: string; readonly label: string }[];
}

export interface Span {
  readonly start: number;
  readonly length: number;
}

export interface DiagnosticInfo {
  /** Project file this diagnostic belongs to. Defaults to the requested source file. */
  readonly fileName?: string;
  /** Undefined for diagnostics that belong to no position (compiler options). */
  readonly span?: Span;
  readonly message: string;
  readonly code: number;
  readonly category: "error" | "warning" | "suggestion" | "message";
  readonly unnecessary: boolean;
  readonly deprecated: boolean;
}

export interface QuickInfo {
  readonly span: Span;
  /** Signature-style text, rendered as a code block. */
  readonly display?: string;
  readonly documentation?: string;
  readonly tags: readonly string[];
  /** TS++ type computation result, when it differs from the written type. */
  readonly normalized?: { readonly text: string; readonly label: string; readonly classification: string };
  /** What a plugin puts in place of the source under the cursor. */
  readonly overlay?: { readonly hoverTitle: string; readonly hoverWhenEmpty: string; readonly text: string };
  /** The formal-contract obligation under the cursor. */
  readonly verification?: { readonly status: string; readonly message: string; readonly counterexample?: string };
}

export interface CompletionEntry {
  readonly name: string;
  readonly kind: string;
  readonly kindModifiers?: string;
  readonly sortText: string;
  readonly insertText?: string;
  readonly isSnippet?: true;
  readonly replacementSpan?: Span;
  readonly labelDetail?: string;
  readonly labelDescription?: string;
  readonly source?: string;
  readonly data?: unknown;
}

export interface CompletionDetails {
  readonly display: string;
  readonly documentation: string;
}

export interface SignatureHelp {
  readonly items: readonly {
    readonly label: string;
    readonly documentation: string;
    readonly parameters: readonly { readonly label: [number, number]; readonly documentation: string }[];
  }[];
  readonly activeSignature: number;
  readonly activeParameter: number;
}

export interface Location {
  readonly fileName: string;
  readonly span: Span;
}

/** A compiler output, or the id of an output a feature adds. */
export type OutputCategory = string;

/** One read-only compiler or plugin artifact shown beside the source editor. */
export interface OutputItem {
  readonly id: string;
  readonly category: OutputCategory;
  readonly label: string;
  /** Monaco language id. Plugin artifacts may contribute languages such as `smt2`. */
  readonly language: string;
  readonly content: string;
  readonly fileName?: string;
  readonly span?: Span;
  readonly status?: "proved" | "failed" | "unknown" | "error";
}

export interface OutputSnapshot {
  readonly items: readonly OutputItem[];
  readonly diagnostics: readonly DiagnosticInfo[];
}

/** The JavaScript of one module, with where its imports name other modules of the program. */
export interface RunnableModule {
  readonly code: string;
  readonly imports: readonly { readonly start: number; readonly end: number; readonly specifier: string; readonly target: string }[];
}

/** What Run executes: a module and everything it imports, by source file name. */
export interface RunnableProgram {
  readonly entry: string;
  readonly format: "esm" | "commonjs";
  readonly modules: Readonly<Record<string, RunnableModule>>;
}

/** Project files keyed by absolute path, e.g. `/src/index.tspp`. */
export type ProjectFiles = Readonly<Record<string, string>>;

export interface WorkerApi {
  /** URLs are resolved by the page: the worker's own location differs between dev and build. */
  init(z3: { workerUrl: string; wasmUrl: string }): { version: string; features: readonly FeatureDefinition[] };
  setProject(files: ProjectFiles, features: readonly string[]): void;
  editFile(fileName: string, text: string): void;
  /** Includes program analyzer results once their background run for this Program settles. */
  diagnostics(fileName: string): DiagnosticInfo[];
  outputs(fileName: string, category: OutputCategory): Promise<OutputSnapshot>;
  /** The program Run executes for a JavaScript output of `fileName`. */
  runnable(fileName: string, outputName: string): RunnableProgram;
  quickInfo(fileName: string, offset: number): QuickInfo | undefined;
  completions(fileName: string, offset: number, triggerCharacter: string | undefined): { entries: CompletionEntry[]; isIncomplete: boolean } | undefined;
  completionDetails(fileName: string, offset: number, name: string, source: string | undefined, data: unknown): CompletionDetails | undefined;
  signatureHelp(fileName: string, offset: number, triggerCharacter: string | undefined, isRetrigger: boolean): SignatureHelp | undefined;
  definition(fileName: string, offset: number): Location[];
}

/** Notifications the worker sends on its own. */
export type WorkerEvent =
  /** Macro expansion or program analysis finished in the background; diagnostics may have changed. */
  | { readonly event: "analysisSettled" }
  /** Macro expansion finished after the Program that started it was built: results from that Program are out of date. */
  | { readonly event: "programChanged" }
  | {
    readonly event: "solver";
    readonly phase: "loading-worker" | "loading-wasm" | "initializing" | "solving" | "idle";
    readonly loaded?: number;
    readonly total?: number;
  };

export type Request = { [K in keyof WorkerApi]: { id: number; method: K; args: Parameters<WorkerApi[K]> } }[keyof WorkerApi];
export type Response = { id: number; result: unknown } | { id: number; error: string };
/** Asks the worker to skip a request that has not started yet. */
export type Cancel = { cancel: number };
