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

/** A binding of an import that `MacroFactory.createImportStatement` generates: `name`, or `name as alias`. */
export interface MacroImportBinding { readonly name: string; readonly alias?: string; }

export interface MacroFactory {
  createIdentifier(text: string): MacroNode;
  createStringLiteral(text: string): MacroNode;
  /** Creates a numeric literal; a negative value becomes a negation of its magnitude. */
  createNumericLiteral(value: number): MacroNode;
  createTrue(): MacroNode;
  createFalse(): MacroNode;
  createNull(): MacroNode;
  createArrayLiteralExpression(elements?: readonly MacroNode[], multiLine?: boolean): MacroNode;
  createObjectLiteralExpression(properties?: readonly MacroNode[], multiLine?: boolean): MacroNode;
  /** Creates `name: initializer`; names that are not identifiers are quoted. */
  createPropertyAssignment(name: string, initializer: MacroNode): MacroNode;
  createPropertyAccessExpression(expression: MacroNode, name: string): MacroNode;
  createCallExpression(expression: MacroNode, typeArguments: readonly MacroNode[] | undefined, argumentsArray: readonly MacroNode[] | undefined): MacroNode;
  /** Creates a type reference such as `Schema<User>`; a dotted name becomes a qualified name. */
  createTypeReferenceNode(name: string, typeArguments?: readonly MacroNode[]): MacroNode;
  /**
   * Creates `import { name as alias } from "moduleSpecifier";`. An invocation at the top level of a module may
   * return it so that the statements it generates can name a library without relying on the caller's imports.
   */
  createImportStatement(moduleSpecifier: string, bindings: readonly MacroImportBinding[]): MacroStatement;
  /** Creates a type annotation such as `string` from `context.typescript.SyntaxKind.StringKeyword`. */
  createKeywordTypeNode(kind: number): MacroNode;
  createLiteralTypeNode(literal: MacroNode): MacroNode;
  createModifier(kind: number): MacroNode;
  createVariableDeclaration(name: string, exclamationToken?: MacroNode, type?: MacroNode, initializer?: MacroNode): MacroNode;
  createVariableDeclarationList(declarations: readonly MacroNode[], flags?: number): MacroNode;
  createVariableStatement(modifiers: readonly MacroNode[] | undefined, declarations: MacroNode): MacroStatement;
  createMacroInvocationStatement(macro: MacroNode, targets: readonly MacroNode[]): MacroStatement;
}

/** A keyword type as written in a type annotation. */
export type MacroKeywordType = "any" | "bigint" | "boolean" | "never" | "number" | "object" | "string" | "symbol" | "undefined" | "unknown" | "void";

/**
 * A type annotation as written, read without the checker except for resolving the declarations a reference names.
 * Parentheses are removed; every form keeps its source `text`, and forms without a description are `unsupported`.
 */
export type MacroTypeSyntax =
  | { readonly kind: "keyword"; readonly keyword: MacroKeywordType; readonly text: string; }
  | { readonly kind: "literal"; readonly value: string | number | boolean | null; readonly text: string; }
  /** `name` is the written, possibly dotted, name; `target` is what it resolves to, when it resolves. */
  | { readonly kind: "reference"; readonly name: string; readonly arguments: readonly MacroTypeSyntax[]; readonly target: MacroTarget | undefined; readonly text: string; }
  /** `T[]` or `readonly T[]`; `Array<T>` is a reference. */
  | { readonly kind: "array"; readonly element: MacroTypeSyntax; readonly readonly: boolean; readonly text: string; }
  | { readonly kind: "union"; readonly types: readonly MacroTypeSyntax[]; readonly text: string; }
  | ({ readonly kind: "object"; readonly text: string; } & MacroMembersSyntax)
  | { readonly kind: "unsupported"; readonly text: string; };

/** A property of an interface or object type, with the text of its leading JSDoc comment. */
export interface MacroPropertySyntax {
  readonly name: string;
  readonly optional: boolean;
  readonly readonly: boolean;
  readonly type: MacroTypeSyntax;
  readonly documentation: string | undefined;
}

/** The properties of an object type; `unsupportedMembers` holds the text of every other member. */
export interface MacroMembersSyntax {
  readonly members: readonly MacroPropertySyntax[];
  readonly unsupportedMembers: readonly string[];
}

/** What every declaration description reads: its name, its type parameter names, and whether it has `export`. */
export interface MacroNamedDeclarationSyntax {
  readonly name: string;
  readonly typeParameters: readonly string[];
  readonly exported: boolean;
}

/** The parts of a declaration that `MacroContext.describe` reads; other declarations have no description. */
export type MacroDeclarationSyntax =
  | ({ readonly kind: "interface"; readonly heritage: readonly MacroTypeSyntax[]; } & MacroNamedDeclarationSyntax & MacroMembersSyntax)
  | ({ readonly kind: "type-alias"; readonly type: MacroTypeSyntax; } & MacroNamedDeclarationSyntax)
  | ({ readonly kind: "class"; } & MacroNamedDeclarationSyntax);

export interface MacroContext {
  readonly program: object;
  readonly checker: object;
  readonly factory: MacroFactory;
  readonly typescript: {
    readonly factory: MacroFactory;
    /**
     * Every `SyntaxKind` of the compiler API by name, for macros that read the syntax of their targets; the kinds
     * listed here are the ones the factories take.
     */
    readonly SyntaxKind: Readonly<Record<string, number> & {
      FunctionDeclaration: number;
      ExportKeyword: number;
      AnyKeyword: number;
      BigIntKeyword: number;
      BooleanKeyword: number;
      IntrinsicKeyword: number;
      NeverKeyword: number;
      NumberKeyword: number;
      ObjectKeyword: number;
      StringKeyword: number;
      SymbolKeyword: number;
      UndefinedKeyword: number;
      UnknownKeyword: number;
      VoidKeyword: number;
    }>;
    /** Every `NodeFlags` member of the compiler API by name, such as `Const` and `Let` for variable declaration lists. */
    readonly NodeFlags: Readonly<Record<string, number>>;
  };
  readonly sourceFile: MacroSourceFile;
  readonly macroInvocation: MacroNode;
  /** Describes an interface, type alias, or class declaration, such as the `node` of a target. */
  describe(declaration: MacroDeclaration): MacroDeclarationSyntax | undefined;
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
