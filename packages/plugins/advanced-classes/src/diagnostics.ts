import type {
    TSPPDiagnosticProvider,
    TSPPTypeOperations,
    TSPPTypeScript,
} from "@tspp/plugin-sdk/compiler";
import type * as TS from "typescript-upstream";

import type { createAdvancedClassDeclarations } from "./class-decl";
import type { createFieldSyntax } from "./field";
import type { createWithSyntax } from "./with";

export const DIAGNOSTIC_CANNOT_INHERIT_FINAL = 19101;
export const DIAGNOSTIC_CANNOT_EXTEND_SEALED = 19102;
export const DIAGNOSTIC_CANNOT_OVERRIDE_FINAL_MEMBER = 19103;
export const DIAGNOSTIC_FIELD_OUTSIDE_ACCESSOR = 19104;
export const DIAGNOSTIC_INVALID_MODIFIER_COMBINATION = 19105;

export interface ModifierError {
    fileName: string;
    start: number;
    length: number;
    messageText: string;
}

export const recordedModifierErrors: ModifierError[] = [];

export function recordModifierError(fileName: string, start: number, length: number, messageText: string): void {
    recordedModifierErrors.push({ fileName, start, length, messageText });
}

export function createAdvancedClassDiagnostics(
    ts: TSPPTypeScript,
    classDecls: ReturnType<typeof createAdvancedClassDeclarations>,
    fieldSyntax: ReturnType<typeof createFieldSyntax>,
    withSyntax: ReturnType<typeof createWithSyntax>,
): TSPPDiagnosticProvider {
    const kinds = ts.SyntaxKind;

    return {
        id: "advanced-classes-diagnostics",
        getSemanticDiagnostics(sourceFile, checker) {
            const diagnostics: TS.Diagnostic[] = [];

            for (const modErr of recordedModifierErrors) {
                if (!modErr.fileName || modErr.fileName === sourceFile.fileName || modErr.fileName === sourceFile.text) {
                    diagnostics.push({
                        file: sourceFile,
                        start: modErr.start,
                        length: modErr.length,
                        messageText: modErr.messageText,
                        category: ts.DiagnosticCategory.Error,
                        code: DIAGNOSTIC_INVALID_MODIFIER_COMBINATION,
                    });
                }
            }

            function visit(node: TS.Node) {
                // Check class inheritance
                if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
                    if (node.heritageClauses) {
                        for (const clause of node.heritageClauses) {
                            if (clause.token === kinds.ExtendsKeyword) {
                                for (const typeNode of clause.types) {
                                    const baseExpr = typeNode.expression;
                                    const baseName = ts.isIdentifier(baseExpr) ? ts.idText(baseExpr) : undefined;
                                    if (baseName) {
                                        const nodeStart = typeof typeNode.getStart === "function" ? typeNode.getStart(sourceFile) : typeNode.pos;
                                        const nodeEnd = typeof typeNode.getEnd === "function" ? typeNode.getEnd() : typeNode.end;
                                        const nodeLen = Math.max(1, nodeEnd - nodeStart);

                                        // 1. Check final class inheritance
                                        if (classDecls.finalClasses.has(baseName)) {
                                            diagnostics.push({
                                                file: sourceFile,
                                                start: nodeStart,
                                                length: nodeLen,
                                                messageText: `Cannot inherit from final class '${baseName}'.`,
                                                category: ts.DiagnosticCategory.Error,
                                                code: DIAGNOSTIC_CANNOT_INHERIT_FINAL,
                                            });
                                        }

                                        // 2. Check sealed class same-file inheritance
                                        const sealedDeclaringFile = classDecls.sealedClasses.get(baseName);
                                        if (sealedDeclaringFile !== undefined && sealedDeclaringFile !== sourceFile.fileName && sealedDeclaringFile !== sourceFile.text) {
                                            diagnostics.push({
                                                file: sourceFile,
                                                start: nodeStart,
                                                length: nodeLen,
                                                messageText: `Cannot extend sealed class '${baseName}' outside of its declaring file.`,
                                                category: ts.DiagnosticCategory.Error,
                                                code: DIAGNOSTIC_CANNOT_EXTEND_SEALED,
                                            });
                                        }

                                        // 3. Check final member overrides
                                        const finalMethods = classDecls.finalMethodsByClass.get(baseName);
                                        if (finalMethods && node.members) {
                                            for (const member of node.members) {
                                                if (member.name && ts.isIdentifier(member.name)) {
                                                    const memberName = ts.idText(member.name);
                                                    if (finalMethods.has(memberName)) {
                                                        const mStart = typeof member.name.getStart === "function" ? member.name.getStart(sourceFile) : member.name.pos;
                                                        const mEnd = typeof member.name.getEnd === "function" ? member.name.getEnd() : member.name.end;
                                                        diagnostics.push({
                                                            file: sourceFile,
                                                            start: mStart,
                                                            length: Math.max(1, mEnd - mStart),
                                                            messageText: `Cannot override final member '${memberName}' of class '${baseName}'.`,
                                                            category: ts.DiagnosticCategory.Error,
                                                            code: DIAGNOSTIC_CANNOT_OVERRIDE_FINAL_MEMBER,
                                                        });
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }

                // 4. Check field outside accessor
                if (fieldSyntax.invalidFieldNodes.has(node)) {
                    diagnostics.push({
                        file: sourceFile,
                        start: node.pos,
                        length: Math.max(1, node.end - node.pos),
                        messageText: "'field' is only allowed inside a getter or setter.",
                        category: ts.DiagnosticCategory.Error,
                        code: DIAGNOSTIC_FIELD_OUTSIDE_ACCESSOR,
                    });
                }

                ts.forEachChild(node, visit);
            }

            visit(sourceFile);
            return diagnostics;
        },

        filterDiagnostic(diagnostic) {
            // Filter constructor cannot have return type or async modifier errors
            if (diagnostic.code === 1089 || diagnostic.code === 1038) {
                return false;
            }
            return true;
        },
    };
}
