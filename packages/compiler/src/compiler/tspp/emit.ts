import {
    createPrinter,
    factory,
    idText,
    isFunctionDeclaration,
    isLiteralTypeNode,
    isStringLiteral,
} from "../_namespaces/ts.js";
import type {
    Bundle,
    EmitHost,
    EmitResolver,
    Expression,
    Node,
    Printer,
    PrinterOptions,
    SourceFile,
    TransformationResult,
    TypeNode,
} from "../_namespaces/ts.js";
import { Extension } from "../types.js";
import { getTSPPCompatibilityDeclarationFilePath } from "./files.js";
import {
    getPreprocessedFunctionClause,
    getPreprocessedFunctionPrefix,
} from "./registry.js";

// Declaration output of TS++ files (`TSPP-SLOT(declaration-output)` sites): a `.d.tspp` declaration that keeps plugin
// syntax, and beside it a TypeScript-compatible `.d.ts` printed from the same declaration transform.

/** Whether the compatible `.d.ts` beside a `.d.tspp` declaration file is blocked from being written. @internal */
export function isTSPPCompatibilityDeclarationBlocked(host: EmitHost, declarationFilePath: string): boolean {
    const compatibilityDeclarationFilePath = getTSPPCompatibilityDeclarationFilePath(declarationFilePath);
    return !!compatibilityDeclarationFilePath && !!host.isEmitBlocked(compatibilityDeclarationFilePath);
}

/**
 * Prints the TypeScript-compatible `.d.ts` beside a `.d.tspp` declaration file with `print`, using a printer like the
 * declaration printer but without source maps. Returns the path when the file was written.
 * @internal
 */
export function emitTSPPCompatibilityDeclaration(
    declarationFilePath: string,
    printerOptions: PrinterOptions,
    resolver: EmitResolver,
    declarationTransform: TransformationResult<SourceFile | Bundle>,
    print: (filePath: string, printer: Printer) => boolean,
): string | undefined {
    const compatibilityDeclarationFilePath = getTSPPCompatibilityDeclarationFilePath(declarationFilePath);
    if (!compatibilityDeclarationFilePath) return undefined;
    const compatibilityPrinter = createPrinter(
        { ...printerOptions, sourceMap: false, tsppCompatibilityDeclaration: true },
        {
            hasGlobalName: resolver.hasGlobalName,
            onEmitNode: declarationTransform.emitNodeWithNotification,
            isEmitNotificationEnabled: declarationTransform.isEmitNotificationEnabled,
            substituteNode: declarationTransform.substituteNode,
        },
    );
    return print(compatibilityDeclarationFilePath, compatibilityPrinter) ? compatibilityDeclarationFilePath : undefined;
}

/** In the compatible `.d.ts`, a module specifier naming a `.tspp` file names its emitted `.js` file. @internal */
export function getTSPPCompatibilityModuleSpecifier(moduleSpecifier: Expression, compatibility: boolean): Expression {
    return compatibility && isStringLiteral(moduleSpecifier) && moduleSpecifier.text.endsWith(Extension.Tspp)
        ? factory.createStringLiteral(moduleSpecifier.text.slice(0, -Extension.Tspp.length) + Extension.Js)
        : moduleSpecifier;
}

/** In the compatible `.d.ts`, an `import("...")` type names the emitted `.js` file of a `.tspp` file. @internal */
export function getTSPPCompatibilityImportTypeArgument(argument: TypeNode, compatibility: boolean): TypeNode {
    if (!compatibility || !isLiteralTypeNode(argument) || !isStringLiteral(argument.literal)) return argument;
    const text = argument.literal.text;
    return factory.createLiteralTypeNode(factory.createStringLiteral(text.endsWith(Extension.Tspp) ? text.slice(0, -Extension.Tspp.length) + Extension.Js : text));
}

/**
 * Writes the plugin syntax a source projection removed before a function declaration's `function` keyword. Only
 * declaration surfaces restore it: not JavaScript, and not the compatible `.d.ts` (`erased`).
 * @internal
 */
export function emitTSPPRestoredFunctionPrefix(node: Node, sourceFile: SourceFile | undefined, erased: boolean, write: (text: string) => void, writeSpace: () => void): void {
    if (erased || !isFunctionDeclaration(node) || !node.name || !sourceFile) return;
    const prefix = getPreprocessedFunctionPrefix(sourceFile.fileName, idText(node.name), node.pos);
    if (prefix) {
        write(prefix);
        writeSpace();
    }
}

/**
 * Writes the plugin clause a source projection removed after a function declaration's parameters, such as a contract.
 * Only declaration surfaces restore it: not JavaScript, and not the compatible `.d.ts` (`erased`).
 * @internal
 */
export function emitTSPPRestoredFunctionClause(node: Node, sourceFile: SourceFile | undefined, erased: boolean, write: (text: string) => void, writeSpace: () => void): void {
    if (erased || !isFunctionDeclaration(node) || !node.name || !sourceFile) return;
    const clause = getPreprocessedFunctionClause(sourceFile.fileName, idText(node.name), node.pos);
    if (clause) {
        writeSpace();
        write(clause);
    }
}
