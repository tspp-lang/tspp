/** Messages between the page and the language worker (src/worker/languageWorker.ts). */

export interface FeatureDefinition {
  readonly name: string;
  readonly dependencies: readonly string[];
  readonly initComments: readonly string[];
}

export interface Span {
  readonly start: number;
  readonly length: number;
}

export interface DiagnosticInfo {
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
  /** The statements a macro invocation under the cursor expands to. */
  readonly macroExpansion?: { readonly macroName: string; readonly text: string };
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

/** Project files keyed by absolute path, e.g. `/src/index.tspp`. */
export type ProjectFiles = Readonly<Record<string, string>>;

export interface WorkerApi {
  /** URLs are resolved by the page: the worker's own location differs between dev and build. */
  init(z3: { workerUrl: string; wasmUrl: string }): { version: string; features: readonly FeatureDefinition[] };
  setProject(files: ProjectFiles, features: readonly string[]): void;
  editFile(fileName: string, text: string): void;
  diagnostics(fileName: string): DiagnosticInfo[];
  quickInfo(fileName: string, offset: number): QuickInfo | undefined;
  completions(fileName: string, offset: number, triggerCharacter: string | undefined): { entries: CompletionEntry[]; isIncomplete: boolean } | undefined;
  completionDetails(fileName: string, offset: number, name: string, source: string | undefined, data: unknown): CompletionDetails | undefined;
  signatureHelp(fileName: string, offset: number, triggerCharacter: string | undefined, isRetrigger: boolean): SignatureHelp | undefined;
  definition(fileName: string, offset: number): Location[];
}

/** Notifications the worker sends on its own. */
export type WorkerEvent =
  /** Macro expansion or verification finished in the background; diagnostics may have changed. */
  | { readonly event: "analysisSettled" }
  | { readonly event: "solver"; readonly busy: boolean };

export type Request = { [K in keyof WorkerApi]: { id: number; method: K; args: Parameters<WorkerApi[K]> } }[keyof WorkerApi];
export type Response = { id: number; result: unknown } | { id: number; error: string };
