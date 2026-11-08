import type { TSPPSignatureConstraint, TSPPTypeOperations, TSPPTypeScript } from "@tspp/plugin-sdk/compiler";
import type * as TS from "typescript-upstream";

import type { InherentBlock, TypeclassSyntax } from "./syntax";

export interface FoundBlock {
    readonly companion: TS.InterfaceDeclaration;
    readonly block: InherentBlock;
}

const unusedCodes = new Set([6133, 6138, 6192, 6196, 6198, 6199, 6205]);

/**
 * Whether a diagnostic reports a declaration an inherent block lowers to as unused. Its interface and functions are
 * generated, and its methods are public members of the type, which TypeScript never reports as unused; the fix offered
 * for a generated name would delete text that is not its declaration.
 */
export function isUnusedInherentDiagnostic(ts: TSPPTypeScript, syntax: TypeclassSyntax, diagnostic: TS.Diagnostic): boolean {
    if (!unusedCodes.has(diagnostic.code) || !diagnostic.file) return false;
    const name = /^'([^']+)'/.exec(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))?.[1];
    if (!name?.includes("$")) return false;
    return diagnostic.file.statements.some(statement => {
        if (!syntax.inherent.has(statement) && !syntax.helpers.has(statement)) return false;
        const declared = (statement as TS.DeclarationStatement).name;
        return !!declared && ts.isIdentifier(declared) && ts.idText(declared) === name;
    });
}

/** Inherent methods are not on the value or in its type: a member lookup that finds nothing else finds them here. */
export function createInherentLookup(ts: TSPPTypeScript, syntax: TypeclassSyntax) {
    const sourceFileOf = (node: TS.Node) => {
        let current = node;
        while (current.parent) current = current.parent;
        return current as TS.SourceFile;
    };

    /** The type an inherent implementation can extend: only the module declaring it may, so only there is looked at. */
    const blocksOfTarget = (target: TS.Symbol): readonly FoundBlock[] => {
        const declaration = target.declarations?.[0];
        if (!declaration) return [];
        const found: FoundBlock[] = [];
        for (const statement of sourceFileOf(declaration).statements) {
            const block = ts.isInterfaceDeclaration(statement) ? syntax.inherent.get(statement) : undefined;
            if (block) found.push({ companion: statement as TS.InterfaceDeclaration, block });
        }
        return found;
    };

    const targetOf = (checker: TS.TypeChecker, head: TS.TypeNode) => {
        const type = checker.getTypeFromTypeNode(head);
        return type.aliasSymbol ?? type.symbol as TS.Symbol | undefined;
    };

    /** The method's interface with the target's type parameters bound by the receiver, when the block applies to it. */
    const memberOf = (
        checker: TS.TypeChecker,
        types: TSPPTypeOperations,
        unify: (pattern: TS.Type, actual: TS.Type, parameters: readonly TS.Type[], bound: Map<TS.Type, TS.Type>) => boolean,
        receiver: TS.Type,
        name: string,
    ): TS.Symbol | undefined => {
        const target = receiver.aliasSymbol ?? receiver.symbol as TS.Symbol | undefined;
        if (!target) return undefined;
        for (const { companion, block } of blocksOfTarget(target)) {
            if (!block.helpers.has(name)) continue;
            const declared = checker.getDeclaredTypeOfSymbol(checker.getSymbolAtLocation(companion.name)!) as TS.InterfaceType;
            const parameters = declared.typeParameters ?? [];
            const bound = new Map<TS.Type, TS.Type>();
            if (!unify(checker.getTypeFromTypeNode(block.head), receiver, parameters, bound)) continue;
            if (parameters.some(parameter => !bound.has(parameter))) continue;
            const instance = parameters.length ? types.instantiate(declared, types.createMapper(parameters, parameters.map(parameter => bound.get(parameter)!))) : declared;
            return checker.getPropertyOfType(instance, name);
        }
        return undefined;
    };

    /** `Option.isSome(option)`: the method's function, by the name of the type's value. */
    const qualifiedHelper = (checker: TS.TypeChecker, node: TS.PropertyAccessExpression, name: string): TS.Symbol | undefined => {
        if (!ts.isIdentifier(node.expression)) return undefined;
        const located = checker.getSymbolAtLocation(node.expression);
        const target = located && (located.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(located) : located);
        if (!target) return undefined;
        for (const { block } of blocksOfTarget(target)) {
            const helper = block.helpers.get(name);
            if (helper?.name) return checker.getSymbolAtLocation(helper.name);
        }
        return undefined;
    };

    const getMember = (unify: (checker: TS.TypeChecker, types: TSPPTypeOperations) => (pattern: TS.Type, actual: TS.Type, parameters: readonly TS.Type[], bound: Map<TS.Type, TS.Type>) => boolean): TSPPSignatureConstraint["getMember"] => request => {
        if (!syntax.used() || !ts.isPropertyAccessExpression(request.node)) return undefined;
        const match = unify(request.checker, request.types);
        return memberOf(request.checker, request.types, match, request.leftType, request.name)
            ?? (request.apparentType !== request.leftType ? memberOf(request.checker, request.types, match, request.apparentType, request.name) : undefined)
            ?? qualifiedHelper(request.checker, request.node, request.name);
    };

    /** What is wrong with a block: its target, or a name already taken. Also keeps the block in declaration output. */
    const problemsOfBlock = (checker: TS.TypeChecker, sourceFile: TS.SourceFile, companion: TS.InterfaceDeclaration, placed: InherentBlock, types: TSPPTypeOperations): readonly string[] => {
        const type = checker.getTypeFromTypeNode(placed.head);
        const target = type.aliasSymbol ?? type.symbol as TS.Symbol | undefined;
        const declaration = target?.declarations?.find(candidate => ts.isClassLike(candidate) || ts.isTypeAliasDeclaration(candidate));
        // The nominal types of TS++ lower to a type alias with a companion namespace, which a plain alias does not have.
        if (!target || !declaration || ts.isTypeAliasDeclaration(declaration) && !(target.flags & ts.SymbolFlags.Module)) {
            return ["An inherent implementation must name a class or a nominal type."];
        }
        const name = ts.symbolName(target);
        if (sourceFileOf(declaration) !== sourceFile) return [`Only the module that declares '${name}' may give it inherent methods.`];
        const problems: string[] = [];
        for (const { block } of blocksOfTarget(target)) {
            if (block.start >= placed.start) continue;
            for (const method of placed.helpers.keys()) {
                if (block.helpers.has(method)) problems.push(`'${name}' already has an inherent method '${method}'.`);
            }
        }
        if (ts.isClassLike(declaration)) {
            const declared = checker.getDeclaredTypeOfSymbol(target);
            for (const method of placed.helpers.keys()) {
                if (checker.getPropertyOfType(declared, method)) problems.push(`'${name}' already has a member '${method}'.`);
            }
        }
        // Whoever reads the type's declarations needs its inherent methods too.
        const module = checker.getSymbolAtLocation(sourceFile);
        const exported = module && checker.getExportsOfModule(module).some(symbol => (symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol) === target);
        const own = (companion as { symbol?: TS.Symbol; }).symbol;
        if (exported && own) types.markAliasVisibleInDeclarations(own);
        return problems;
    };

    const getMembers = (unify: (checker: TS.TypeChecker, types: TSPPTypeOperations) => (pattern: TS.Type, actual: TS.Type, parameters: readonly TS.Type[], bound: Map<TS.Type, TS.Type>) => boolean): TSPPSignatureConstraint["getMembers"] => ({ type, checker, types }) => {
        if (!syntax.used()) return [];
        const target = type.aliasSymbol ?? type.symbol as TS.Symbol | undefined;
        if (!target) return [];
        const match = unify(checker, types);
        return blocksOfTarget(target).flatMap(({ block }) => [...block.helpers.keys()].flatMap(name => memberOf(checker, types, match, type, name) ?? []));
    };

    return { blocksOfTarget, targetOf, getMember, getMembers, sourceFileOf, problemsOfBlock };
}
