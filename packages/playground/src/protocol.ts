export interface FeatureDefinition {
  readonly id: string;
  readonly name: string;
  readonly dependencies?: readonly string[];
}

export interface CheckResult {
  readonly projected: string;
  readonly diagnostics: readonly string[];
}

export type WorkerRequest =
  | { readonly type: "initialize"; readonly features: readonly string[] }
  | { readonly type: "check"; readonly source: string };

export type WorkerResponse =
  | { readonly type: "ready" }
  | { readonly type: "result"; readonly result: CheckResult }
  | { readonly type: "error"; readonly message: string };
