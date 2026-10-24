/*
 * `ts-plus-plus/macros`: the public SDK for compile-time macros.
 *
 * Compatibility promise, version 1 (`macroApiVersion`):
 *
 * - Stable: everything exported from this module. The macro types
 *   (`MacroTarget`, `MacroContext`, `MacroResult`, `MacroReturn`,
 *   `MacroFailure`, `MacroDiagnostic`, `MacroFunction`, `MacroTimeout`), the
 *   curated AST node types and type guards, `SyntaxKind`, `NodeFlags`,
 *   `DiagnosticCategory`, `forEachChild`, and `idText`. Removing or changing
 *   any of them requires a new `macroApiVersion`.
 * - Node creation: `context.factory` is the one supported way to build AST.
 *   Node shapes follow the compiler's AST, which tracks TypeScript's.
 * - Same-version coupled: `context.program` and `context.checker` give
 *   read-only access to the whole compiler. They are intentionally powerful
 *   and follow the running compiler's internals without a compatibility
 *   promise, as does `import * as ts from "ts-plus-plus"`.
 *
 * At compile time the compiler serves this module itself, so a macro always
 * runs against the compiler that loaded it.
 */

export { DiagnosticCategory, forEachChild, idText, isArrayLiteralExpression, isArrowFunction, isBlock, isCallExpression, isClassDeclaration, isDataDeclaration, isDataVariant, isEnumDeclaration, isExportDeclaration, isExpressionStatement, isFunctionDeclaration, isFunctionExpression, isIdentifier, isImportDeclaration, isInterfaceDeclaration, isMacroInvocationStatement, isMethodDeclaration, isMethodSignature, isNewtypeDeclaration, isNumericLiteral, isObjectLiteralExpression, isParameter, isPropertyAccessExpression, isPropertyDeclaration, isPropertySignature, isReturnStatement, isStringLiteral, isTypeAliasDeclaration, isTypeLiteralNode, isTypeReferenceNode, isVariableDeclaration, isVariableStatement, NodeFlags, SyntaxKind } from "./_namespaces/ts.js";

export type { Block, ClassDeclaration, DataDeclaration, DataVariant, Declaration, Expression, FunctionDeclaration, Identifier, InterfaceDeclaration, MacroContext, MacroDiagnostic, MacroFailure, MacroFunction, MacroInvocationStatement, MacroResult, MacroReturn, MacroTarget, MacroTimeout, NewtypeDeclaration, Node, NodeFactory, ParameterDeclaration, Program, ReturnStatement, SourceFile, Statement, Symbol, Type, TypeAliasDeclaration, TypeChecker, TypeNode, VariableDeclaration, VariableStatement } from "./_namespaces/ts.js";

/** The version of the compatibility promise above. */
export const macroApiVersion = 1;
