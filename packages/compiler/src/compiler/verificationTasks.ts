import {
  createAnalysisTaskId,
  verificationResultToAnalysisOutcome,
} from "./analysisTasks.js";
import { skipTrivia } from "./scanner.js";
import {
  AnalysisTaskReason,
  Diagnostic,
  DiagnosticCategory,
  Node,
  Program,
  SourceFile,
  SyntaxKind,
  VerificationArtifact,
  WithProperty,
} from "./types.js";
import type { VerificationQuery } from "./verificationSmt.js";

const verificationDiagnosticCode = 18090;

/** @internal */
export interface PendingVerificationTask {
  artifact: VerificationArtifact;
  query?: VerificationQuery;
}

/** @internal */
export function createVerificationArtifact(
  sourceFile: SourceFile,
  node: Node,
  kind: VerificationArtifact["kind"],
  obligation: VerificationArtifact["obligation"],
  name: string,
  status: VerificationArtifact["status"],
  solverInput: string,
  replayableSmtLib: string,
  message: string,
  reason?: AnalysisTaskReason,
): VerificationArtifact {
  const target = node.kind === SyntaxKind.WithProperty ? (node as WithProperty).value : node;
  const start = skipTrivia(sourceFile.text, target.pos);
  const length = target.end - start;
  return {
    taskId: createAnalysisTaskId("verification", sourceFile.fileName, start, length, name),
    taskKind: "verification",
    outcome: verificationResultToAnalysisOutcome(status, reason),
    reason,
    fileName: sourceFile.fileName,
    start,
    length,
    kind,
    obligation,
    name,
    status,
    solverInput,
    replayableSmtLib,
    message,
  };
}

/** @internal */
export function updateVerificationArtifact(
  artifact: VerificationArtifact,
  update: Pick<VerificationArtifact, "status" | "message"> & Partial<Pick<VerificationArtifact, "counterexample" | "model" | "reason" | "trustedInputs">>,
): VerificationArtifact {
  return {
    ...artifact,
    ...update,
    outcome: verificationResultToAnalysisOutcome(update.status, update.reason),
  };
}

/** @internal */
export function createVerificationDiagnostic(program: Program, artifact: VerificationArtifact): Diagnostic {
  return {
    category: DiagnosticCategory.Error,
    code: verificationDiagnosticCode,
    file: program.getSourceFile(artifact.fileName),
    start: artifact.start,
    length: artifact.length,
    source: "TS++ verification",
    messageText: formatVerificationMessage(artifact),
  };
}

/** @internal */
export function formatVerificationMessage(artifact: VerificationArtifact): string {
  const summary = `${artifact.name}: ${artifact.status === "failed" ? "proof failed" : "verification unknown"}. ${artifact.message}`;
  return artifact.counterexample ? `${summary} Counterexample: ${artifact.counterexample}.` : summary;
}
