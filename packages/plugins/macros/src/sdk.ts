/** Compatibility version of the feature-owned macro authoring contract. */
export const macroApiVersion = 2 as const;

export interface MacroNode { readonly kind: number; }
export interface MacroStatement extends MacroNode {}
export interface MacroDeclaration extends MacroNode {}
export interface MacroSourceFile extends MacroNode { readonly fileName: string; readonly text: string; }
export interface MacroSymbol { readonly declarations?: readonly MacroDeclaration[]; readonly valueDeclaration?: MacroDeclaration; }

export interface MacroTarget {
  readonly name: string;
  readonly symbol: MacroSymbol;
  readonly node: MacroDeclaration;
  readonly declarations: readonly MacroDeclaration[];
  readonly sourceFile: MacroSourceFile;
}

export interface MacroDiagnostic { readonly message: string; readonly category?: number; }
export interface MacroFailure { readonly kind: "macro-failure"; readonly diagnostics: readonly MacroDiagnostic[]; }
export type MacroResult = void | MacroStatement | readonly MacroStatement[] | MacroFailure;
export type MacroReturn = MacroResult | PromiseLike<MacroResult>;
export type MacroTimeout =
  | { readonly type: "fixed"; readonly value: number; readonly unit: "ms" | "s" }
  | { readonly type: "benchmark"; readonly multiplier: number };

export interface MacroFactory {
  createIdentifier(text: string): MacroNode;
  createStringLiteral(text: string): MacroNode;
  createLiteralTypeNode(literal: MacroNode): MacroNode;
  createModifier(kind: number): MacroNode;
  createVariableDeclaration(name: string, exclamationToken?: MacroNode, type?: MacroNode, initializer?: MacroNode): MacroNode;
  createVariableDeclarationList(declarations: readonly MacroNode[], flags?: number): MacroNode;
  createVariableStatement(modifiers: readonly MacroNode[] | undefined, declarations: MacroNode): MacroStatement;
  createMacroInvocationStatement(macro: MacroNode, targets: readonly MacroNode[]): MacroStatement;
}

export interface MacroContext {
  readonly program: object;
  readonly checker: object;
  readonly factory: MacroFactory;
  readonly typescript: {
    readonly factory: MacroFactory;
    readonly SyntaxKind: Readonly<Record<string, number>>;
    readonly NodeFlags: Readonly<Record<string, number>>;
  };
  readonly sourceFile: MacroSourceFile;
  readonly macroInvocation: MacroNode;
  report(diagnostic: MacroDiagnostic): void;
  fail(message: string): MacroFailure;
}

export type MacroFunction = (targets: readonly MacroTarget[], context: MacroContext) => MacroReturn;

/** The statements generated for one compile-time macro invocation, printed. */
export interface MacroExpansion {
  readonly fileName: string;
  readonly start: number;
  readonly length: number;
  readonly macroName: string;
  readonly text: string;
}
