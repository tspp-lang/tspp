import {
  FunctionDeclaration,
  NewtypeDeclaration,
  SourceFile,
  TypeAliasDeclaration,
  TypeChecker,
  VariableDeclaration,
} from "./types.js";
import {
  verificationConstant,
  VerificationFunction,
  VerificationSort,
  VerificationTerm,
} from "./verificationIR.js";
import { LogicFunctionDefinitions } from "./verificationLogicLibrary.js";
import { VerificationNumberModel } from "./verificationProgramSemantics.js";
import { PendingVerificationTask } from "./verificationTasks.js";

/** Reads logic functions defined with `ts-plus-plus/smt`, evaluating their modules at most once. @internal */
export interface LogicFunctionResolver {
  resolve(declaration: VariableDeclaration): LogicFunctionDefinitions | string;
}

/** Mutable state shared while lowering one declaration into proof obligations. @internal */
export interface VerificationContext {
  readonly checker: TypeChecker;
  readonly sourceFile: SourceFile;
  readonly declaration: FunctionDeclaration | NewtypeDeclaration | TypeAliasDeclaration;
  readonly declarations: Map<string, VerificationSort>;
  readonly symbolNames: Map<string, string>;
  readonly pending: PendingVerificationTask[];
  readonly numberModel: VerificationNumberModel | undefined;
  /** Library definitions referenced so far; queries print the reachable ones. */
  readonly functions: Map<string, VerificationFunction>;
  /** How often each program-semantics obligation name was used, to keep task ids unique. */
  readonly obligationNames: Map<string, number>;
  readonly logicFunctions: LogicFunctionResolver;
  /** Set while translating a specification, whose operations never execute. */
  readonly specification?: boolean;
  freshIndex: number;
}

/** @internal */
export function createVerificationContext(
  checker: TypeChecker,
  sourceFile: SourceFile,
  declaration: FunctionDeclaration | NewtypeDeclaration | TypeAliasDeclaration,
  pending: PendingVerificationTask[],
  numberModel: VerificationNumberModel | undefined,
  logicFunctions: LogicFunctionResolver,
): VerificationContext {
  return {
    checker,
    sourceFile,
    declaration,
    declarations: new Map(),
    symbolNames: new Map(),
    pending,
    numberModel,
    functions: new Map(),
    obligationNames: new Map(),
    logicFunctions,
    freshIndex: 0,
  };
}

/** @internal */
export function createVerificationConstant(context: VerificationContext, sourceName: string, sort: VerificationSort): VerificationTerm {
  let smtName: string;
  do smtName = `v${context.freshIndex++}`;
  while (context.declarations.has(smtName));
  context.declarations.set(smtName, sort);
  context.symbolNames.set(smtName, sourceName);
  return { expression: verificationConstant(smtName, sort), sort };
}
