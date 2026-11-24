import {
    createPrinter,
    factory,
    fileExtensionIs,
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
    TextRange,
    TransformationResult,
    TypeNode,
} from "../_namespaces/ts.js";
import { Extension } from "../types.js";
import { getTSPPCompatibilityDeclarationFilePath } from "./files.js";
import {
    getActiveTSPPPlugins,
    getPreprocessedFunctionClause,
    getPreprocessedFunctionPrefix,
    getTSPPRestoredFunctionClause,
    isTSPPFileName,
    startRecordingRestoringPlugins,
    stopRecordingRestoringPlugins,
    tsppDeclarationPluginsHeader,
} from "./registry.js";

// Declaration output of TS++ files (`TSPP-SLOT(declaration-output)` sites): a `.d.tspp` declaration that keeps plugin
// syntax, and beside it a TypeScript-compatible `.d.ts` printed from the same declaration transform.

function formatDeclarationHeader(plugins: readonly string[]): string {
    return plugins.length ? `${tsppDeclarationPluginsHeader} ${plugins.join(",")}` : tsppDeclarationPluginsHeader;
}

/**
 * The provisional header of a `.d.tspp` file, naming every active plugin, or undefined for any other file. The header
 * is written before the file prints, and `finishTSPPDeclarationHeader` narrows it to the plugins whose syntax it holds.
 * @internal
 */
export function startTSPPDeclarationHeader(filePath: string): string | undefined {
    const plugins = getActiveTSPPPlugins().map(plugin => plugin.manifest.id).sort();
    if (!fileExtensionIs(filePath, ".d.tspp") || !plugins.length) return undefined;
    startRecordingRestoringPlugins();
    return formatDeclarationHeader(plugins);
}

/**
 * The printed `.d.tspp` text with its first line, the provisional `header`, naming only the plugins that restored syntax
 * in it, and how far that moved later text. A file that needs no plugin keeps the line, so line-based maps stay valid.
 * @internal
 */
export function finishTSPPDeclarationHeader(text: string, header: string): { readonly text: string; readonly shift: number; } {
    const narrowed = formatDeclarationHeader(stopRecordingRestoringPlugins());
    if (!text.startsWith(header)) return { text, shift: 0 };
    return { text: narrowed + text.slice(header.length), shift: narrowed.length - header.length };
}

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

/**
 * Whether the printer, writing a node of a TS++ file whose innermost positioned container ends at `containerEnd`, would
 * read comments at `pos` beyond it. Source comments of a node lie before its end; what plugins lower to sits at the end
 * of the syntax it replaces (see `nestSyntaxRanges` in registry.ts), and its tokens are not in the source, so a read there would take the
 * comments of the next statement. @internal
 */
export function isTSPPCommentOutsideContainer(sourceFile: SourceFile | undefined, pos: number, containerEnd: number): boolean {
    return !!sourceFile && containerEnd >= 0 && pos >= containerEnd && isTSPPFileName(sourceFile.fileName);
}

/**
 * Whether `range` of a TS++ file is what plugin syntax lowered to, which the printer treats as synthesized. It has no width
 * where `nestSyntaxRanges` in registry.ts placed it, at the end of the syntax it replaces: it has no comments of its own
 * there, and the source lines there say nothing about where it breaks. @internal
 */
export function isTSPPGeneratedForPrinting(sourceFile: SourceFile | undefined, range: TextRange): boolean {
    return range.pos >= 0 && range.pos === range.end && !!sourceFile && isTSPPFileName(sourceFile.fileName);
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
    if (erased) return;
    const parsedClause = getTSPPRestoredFunctionClause(node);
    if (parsedClause) {
        writeSpace();
        write(parsedClause);
    }
    if (!isFunctionDeclaration(node) || !node.name || !sourceFile) return;
    const clause = getPreprocessedFunctionClause(sourceFile.fileName, idText(node.name), node.pos);
    if (clause) {
        writeSpace();
        write(clause);
    }
}
