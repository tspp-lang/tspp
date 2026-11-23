import type { TSPPTypeScript } from "@tspp/plugin-sdk/compiler";
import type * as TS from "typescript-upstream";

import {
    DIAGNOSTIC_DUPLICATE_BASE,
    DIAGNOSTIC_INHERITED_MEMBER_CONFLICT,
    DIAGNOSTIC_INVALID_ADDITIONAL_BASE,
    DIAGNOSTIC_UNIMPLEMENTED_ABSTRACT_MEMBER,
    type MultipleInheritance,
} from "./multiple-inheritance";

// The command-line compiler's nodes have no methods, so positions and files are read from their fields.

/** The source file that holds `node`. */
function sourceFileOf(node: TS.Node): TS.SourceFile {
    let current = node;
    while (current.parent) current = current.parent;
    return current as TS.SourceFile;
}

/** Where the first token of `node` starts, after its leading trivia. */
export function tokenStart(ts: TSPPTypeScript, node: TS.Node, sourceFile: TS.SourceFile): number {
    const scanner = ts.createScanner(ts.ScriptTarget.Latest, /*skipTrivia*/ true, ts.LanguageVariant.Standard, sourceFile.text);
    scanner.setTextPos(node.pos);
    scanner.scan();
    return Math.min(scanner.getTokenStart(), node.end);
}

/** What an additional base resolves to. */
export interface ResolvedBase {
    readonly symbol: TS.Symbol | undefined;
    readonly declaration: TS.ClassDeclaration | undefined;
    /** Why the class cannot be used as an additional base, or undefined when it can. */
    readonly problem: string | undefined;
}

/** Why a class cannot become a factory of copies, as an additional base must, or undefined when it can. */
function findAdditionalBaseProblem(ts: TSPPTypeScript, declaration: TS.ClassDeclaration): string | undefined {
    const kinds = ts.SyntaxKind;
    const sourceFile = sourceFileOf(declaration);
    if (sourceFile.isDeclarationFile || !/\.tspp$/i.test(sourceFile.fileName)) return "it must be declared in a .tspp source file of this compilation";
    if (declaration.parent !== sourceFile) return "it must be declared at the top level of its file";
    if (!declaration.name) return "it must have a name";
    if (declaration.heritageClauses?.some(clause => clause.token === kinds.ExtendsKeyword)) return "it extends another class";
    if (ts.getDecorators(declaration)?.length) return "it has decorators";

    const has = (node: TS.Node, kind: TS.SyntaxKind) => !!ts.canHaveModifiers(node) && !!ts.getModifiers(node)?.some(modifier => modifier.kind === kind);
    const isStatic = (node: TS.Node) => has(node, kinds.StaticKeyword);
    // An arrow function reads the `super` around it; any other function or class has its own.
    const usesSuper = (node: TS.Node): boolean => node.kind === kinds.SuperKeyword
        || (ts.isArrowFunction(node) || !ts.isFunctionLike(node) && !ts.isClassLike(node)) && !!ts.forEachChild(node, usesSuper);
    const privateFields = declaration.members.some(member => ts.isPropertyDeclaration(member) && ts.isPrivateIdentifier(member.name) && !isStatic(member));

    for (const member of declaration.members) {
        if (ts.canHaveDecorators(member) && ts.getDecorators(member)?.length) return "it has decorators";
        if (member.name && ts.isComputedPropertyName(member.name)) return "it has a computed member name";
        if (ts.isConstructorDeclaration(member) && member.body) {
            let problem: string | undefined;
            const visit = (node: TS.Node): void => {
                if (node !== member && (ts.isClassLike(node) || ts.isFunctionLike(node) && !ts.isArrowFunction(node))) return;
                if (ts.isIdentifier(node) && ts.idText(node) === "arguments" && !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) && !(ts.isPropertyAssignment(node.parent) && node.parent.name === node)) problem = "its constructor references arguments";
                if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && ts.idText(node.expression) === "eval") problem = "its constructor calls direct eval";
                if (ts.isReturnStatement(node) && node.expression) {
                    let owner: TS.Node | undefined = node.parent;
                    while (owner && !ts.isFunctionLike(owner)) owner = owner.parent;
                    if (owner === member) problem = "its constructor returns a value";
                }
                ts.forEachChild(node, visit);
            };
            visit(member);
            if (problem) return problem;
        }
        if (member.name && ts.isPrivateIdentifier(member.name)) {
            if (isStatic(member)) return "it has a static private member";
            if (ts.isAccessor(member)) return "it has a private accessor";
        }
        if (ts.isPropertyDeclaration(member) && has(member, kinds.AccessorKeyword)) return "it has an auto-accessor";
        if (ts.isPropertyDeclaration(member) && member.name && ts.isComputedPropertyName(member.name)) {
            if (isStatic(member)) return "it has a static field with a computed name";
            if (privateFields) return "it has a field with a computed name beside private fields";
        }
        if (ts.isClassStaticBlockDeclaration(member) && usesSuper(member.body)) return "a static block uses 'super'";
        if (ts.isPropertyDeclaration(member) && isStatic(member) && member.initializer && usesSuper(member.initializer)) return "a static field uses 'super'";
    }

    // Private names this class declares, read where the factory can still reach them.
    const own = new Set(declaration.members.filter(member => member.name && ts.isPrivateIdentifier(member.name)).map(member => ts.idText(member.name as TS.PrivateIdentifier)));
    let problem: string | undefined;
    const isTarget = (node: TS.Node): boolean => {
        const parent = node.parent;
        if (ts.isArrayLiteralExpression(parent) || ts.isSpreadElement(parent) || ts.isShorthandPropertyAssignment(parent) || ts.isSpreadAssignment(parent)) return isTarget(parent);
        if (ts.isPropertyAssignment(parent) && parent.initializer === node) return isTarget(parent.parent);
        if (ts.isObjectLiteralExpression(parent)) return isTarget(parent);
        if (ts.isBinaryExpression(parent) && parent.left === node && parent.operatorToken.kind === kinds.EqualsToken) return ts.isArrayLiteralExpression(node) || ts.isObjectLiteralExpression(node);
        if ((ts.isForOfStatement(parent) || ts.isForInStatement(parent)) && parent.initializer === node) return true;
        return false;
    };
    const visit = (node: TS.Node, names: ReadonlySet<string>): void => {
        if (problem) return;
        if (ts.isClassLike(node) && node !== declaration) {
            const shadowed = node.members.filter(member => member.name && ts.isPrivateIdentifier(member.name)).map(member => ts.idText(member.name as TS.PrivateIdentifier));
            if (shadowed.length) names = new Set([...names].filter(name => !shadowed.includes(name)));
        }
        if (ts.isPropertyAccessExpression(node) && ts.isPrivateIdentifier(node.name) && names.has(ts.idText(node.name))) {
            if (node.questionDotToken || ts.isOptionalChain(node)) problem = "it reads a private member through optional chaining";
            else if (ts.isTaggedTemplateExpression(node.parent) && node.parent.tag === node) problem = "it tags a template with a private member";
            else if (ts.isForOfStatement(node.parent) || ts.isForInStatement(node.parent) || isTarget(node)) problem = "it assigns a private member by destructuring";
        }
        ts.forEachChild(node, child => visit(child, names));
    };
    visit(declaration, own);
    return problem;
}

/** Resolves an additional base and checks that it can be one. */
export function resolveAdditionalBase(ts: TSPPTypeScript, expression: TS.Expression, checker: TS.TypeChecker): ResolvedBase {
    let symbol = checker.getSymbolAtLocation(ts.isPropertyAccessExpression(expression) ? expression.name : expression);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    if (!symbol) return { symbol, declaration: undefined, problem: undefined };
    const declaration = symbol.declarations?.find(ts.isClassDeclaration);
    if (!declaration || !(symbol.flags & ts.SymbolFlags.Class)) return { symbol, declaration: undefined, problem: "it is not a class" };
    if (symbol.declarations!.filter(ts.isClassDeclaration).length > 1) return { symbol, declaration, problem: "it has more than one declaration" };
    return { symbol, declaration, problem: findAdditionalBaseProblem(ts, declaration) };
}

/** Every class of `program` written with more than one base. */
function collectMultipleBaseClasses(ts: TSPPTypeScript, multiple: MultipleInheritance, program: TS.Program): TS.ClassDeclaration[] {
    const classes: TS.ClassDeclaration[] = [];
    const visit = (node: TS.Node): void => {
        if (ts.isClassDeclaration(node) && multiple.getMultipleBases(node)) classes.push(node);
        ts.forEachChild(node, visit);
    };
    for (const sourceFile of program.getSourceFiles()) {
        if (/\.tspp$/i.test(sourceFile.fileName)) visit(sourceFile);
    }
    return classes;
}

/**
 * The classes of `program` some class uses as an additional base, and that can be one, by their parsed declarations; and
 * the files of the classes that use them.
 */
export function findAdditionalBases(ts: TSPPTypeScript, multiple: MultipleInheritance, program: TS.Program): { targets: Set<TS.Node>; users: Set<string>; } {
    const checker = program.getTypeChecker();
    const targets = new Set<TS.Node>();
    const users = new Set<string>();
    for (const declaration of collectMultipleBaseClasses(ts, multiple, program)) {
        users.add(sourceFileOf(declaration).fileName);
        for (const base of multiple.getMultipleBases(declaration)!.bases.slice(multiple.getMultipleBases(declaration)!.mapped ? 0 : 1)) {
            const resolved = resolveAdditionalBase(ts, base, checker);
            if (resolved.declaration && !resolved.problem) targets.add(ts.getOriginalNode(resolved.declaration));
        }
    }
    return { targets, users };
}

/** The checks of classes written with more than one base. */
export function checkMultipleBases(
    ts: TSPPTypeScript,
    multiple: MultipleInheritance,
    declaration: TS.ClassDeclaration,
    checker: TS.TypeChecker,
    report: (node: TS.Node, code: number, message: string) => void,
): void {
    const info = multiple.getMultipleBases(declaration);
    if (!info) return;
    const kinds = ts.SyntaxKind;

    const resolveValue = (expression: TS.Expression) => {
        let symbol = checker.getSymbolAtLocation(ts.isPropertyAccessExpression(expression) ? expression.name : expression);
        if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
        return symbol;
    };
    const isPrivateName = (symbol: TS.Symbol) => {
        const name = symbol.valueDeclaration && (symbol.valueDeclaration as TS.NamedDeclaration).name;
        return !!name && ts.isPrivateIdentifier(name) || String(symbol.escapedName).startsWith("__#");
    };
    const names = (type: TS.Type | undefined, skip?: string) =>
        new Set(type ? checker.getPropertiesOfType(type).map(property => [property, ts.symbolName(property)] as const).filter(([property, name]) => !isPrivateName(property) && name !== skip).map(([, name]) => name) : []);

    const symbols = info.bases.map(resolveValue);
    const valid = info.bases.map(() => true);

    // Each additional base: once, a class, and one the emitted program can copy.
    info.bases.forEach((base, index) => {
        const text = multiple.entityText(base);
        const symbol = symbols[index];
        if (symbol && symbols.slice(0, index).includes(symbol)) {
            report(base, DIAGNOSTIC_DUPLICATE_BASE, `'${text}' is listed as a base more than once.`);
            valid[index] = false;
            return;
        }
        if (index === 0 && !info.mapped || !symbol) {
            if (!symbol) valid[index] = false;
            return;
        }
        const resolved = resolveAdditionalBase(ts, base, checker);
        if (resolved.problem) {
            report(base, DIAGNOSTIC_INVALID_ADDITIONAL_BASE, `'${text}' cannot be ${info.mapped ? 'a mapped base' : 'an additional base'}: ${resolved.problem}.`);
            valid[index] = false;
        }
    });

    if (!info.mapped) {
        info.bases.slice(1).forEach(base => {
            const signatures = checker.getSignaturesOfType(checker.getTypeAtLocation(base), ts.SignatureKind.Construct);
            if (signatures.length && signatures.every(signature => (signature as TS.Signature & { minArgumentCount: number }).minArgumentCount > 0)) {
                report(base, DIAGNOSTIC_INVALID_ADDITIONAL_BASE, `Base '${multiple.entityText(base)}' requires constructor arguments; add a constructor with 'super({ Base: [...] })'.`);
            }
        });
    }

    // The same member from two bases is an error, even where this class declares it too.
    const ownType = checker.getDeclaredTypeOfSymbol(checker.getSymbolAtLocation(declaration.name!) ?? symbols[0]!);
    const baseTypes = ownType.flags & ts.TypeFlags.Object ? checker.getBaseTypes(ownType as TS.InterfaceType) : [];
    const instanceNames = info.bases.map((_, index) => {
        if (!valid[index]) return new Set<string>();
        if (index === 0) return names(baseTypes[0]);
        return names(checker.getDeclaredTypeOfSymbol(symbols[index]!));
    });
    const staticNames = info.bases.map((base, index) => valid[index] ? names(checker.getTypeOfSymbolAtLocation(symbols[index]!, base), "prototype") : new Set<string>());
    const conflict = (sets: readonly Set<string>[], kind: string) => {
        sets.forEach((set, index) => {
            for (const name of set) {
                const earlier = sets.findIndex((other, otherIndex) => otherIndex < index && other.has(name));
                if (earlier >= 0) {
                    report(info.bases[index], DIAGNOSTIC_INHERITED_MEMBER_CONFLICT, `${kind} '${name}' is inherited from both '${multiple.entityText(info.bases[earlier])}' and '${multiple.entityText(info.bases[index])}'.`);
                }
            }
        });
    };
    conflict(instanceNames, "Member");
    conflict(staticNames, "Static member");

    // Abstract members of an additional base, which the merged interface claims as present.
    if (!info.isAbstract) {
        const own = new Set(declaration.members.map(memberName));
        info.bases.forEach((base, index) => {
            const resolved = index > 0 && valid[index] ? symbols[index]!.declarations?.find(ts.isClassDeclaration) : undefined;
            if (!resolved) return;
            for (const member of resolved.members) {
                if (!ts.canHaveModifiers(member) || !ts.getModifiers(member)?.some(modifier => modifier.kind === kinds.AbstractKeyword)) continue;
                const name = memberName(member);
                if (name && !own.has(name)) {
                    report(declaration.name ?? declaration, DIAGNOSTIC_UNIMPLEMENTED_ABSTRACT_MEMBER, `Non-abstract class '${info.name}' does not implement abstract member '${name}' inherited from '${multiple.entityText(base)}'.`);
                }
            }
        });
    }

    function memberName(member: TS.ClassElement): string | undefined {
        const name = member.name;
        if (!name) return undefined;
        if (ts.isIdentifier(name)) return ts.idText(name);
        if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
        return undefined;
    }
}
