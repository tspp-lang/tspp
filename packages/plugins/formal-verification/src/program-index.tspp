import type * as TS from "typescript-upstream";
import type { NominalTypesADTAPI } from "@tspp/plugin-nominal-types/api";
import type {
    TSPPAnalysisClassAncestry, TSPPAnalysisDiagnostic, TSPPAnalysisLocation, TSPPAnalysisSourceFile,
} from "@tspp/plugin-sdk/compiler";
import { collectClassModels, lookupMethod, memberName, type ClassModel, type MemberModel } from "./classes";
import { nameText, nodeStart, nodeWidth, ts } from "./host-api";
import { modelSignature, type FunctionModel } from "./models";
import { prepareVerificationSource, type PreparedVerificationSource } from "./source-cache";

/** What a declaration the checker resolved a call to means to proofs. */
export type DeclaredTarget =
    | { readonly kind: "member"; readonly owner: ClassModel; readonly member: MemberModel; }
    | { readonly kind: "function"; readonly model: FunctionModel; };

export interface ModeledFile {
    readonly source: TSPPAnalysisSourceFile;
    readonly prepared: PreparedVerificationSource;
    readonly functions: ReadonlyMap<string, FunctionModel>;
    readonly classes: ReadonlyMap<string, ClassModel>;
    /** The checker's resolution of the file's calls, by the call's range; absent when the host gave none. */
    readonly callTargets: ReadonlyMap<string, readonly TSPPAnalysisLocation[]> | undefined;
    /** The checker's `extends` chain of each class of the file, by the class's range; absent when the host gave none. */
    readonly classAncestry: ReadonlyMap<string, TSPPAnalysisClassAncestry> | undefined;
}

/** The models of every TS++ file of a program, so that a call can be checked against a contract in another file. */
export interface ProgramIndex {
    readonly files: ReadonlyMap<string, ModeledFile>;
    /** Every modeled declaration by `fileName:start`, overload signatures pointing to their implementation. */
    readonly declarations: ReadonlyMap<string, DeclaredTarget>;
}

export const rangeKey = (start: number, end: number) => `${start}:${end}`;
export const declarationKey = (fileName: string, start: number) => `${fileName}:${start}`;

function modelFunctions(prepared: PreparedVerificationSource): Map<string, FunctionModel> {
    const { sourceFile, refinements, records } = prepared;
    const functions = new Map(prepared.functions);
    for (const statement of sourceFile.statements) {
        if (!ts.isFunctionDeclaration(statement) || !statement.name) continue;
        const name = nameText(statement.name);
        functions.set(name, modelSignature(name, statement, functions.get(name), refinements, records,
            statement.body ? nodeStart(statement.body, sourceFile) : statement.end));
    }
    return functions;
}

function indexDeclarations(file: ModeledFile, declarations: Map<string, DeclaredTarget>): void {
    const { sourceFile } = file.prepared;
    const add = (node: TS.Node, target: DeclaredTarget | undefined) => {
        if (target && node.pos >= 0) declarations.set(declarationKey(sourceFile.fileName, nodeStart(node, sourceFile)), target);
    };
    for (const statement of sourceFile.statements) {
        if (ts.isFunctionDeclaration(statement) && statement.name) {
            const model = file.functions.get(nameText(statement.name));
            add(statement, model && { kind: "function", model });
        }
        if (!ts.isClassDeclaration(statement) || !statement.name) continue;
        const owner = file.classes.get(ts.idText(statement.name));
        if (owner?.declaration !== statement) continue;
        // A `new` resolves to the class itself.
        add(statement, { kind: "member", owner, member: owner.constructorMember });
        for (const member of statement.members) {
            if (ts.isConstructorDeclaration(member)) add(member, { kind: "member", owner, member: owner.constructorMember });
            else if (ts.isMethodDeclaration(member)) {
                const name = memberName(member.name);
                const isStatic = !!ts.getModifiers(member)?.some(modifier => modifier.kind === ts.SyntaxKind.StaticKeyword);
                const modeled = name === undefined ? undefined : (isStatic ? owner.staticMethods : owner.methods).get(name);
                add(member, modeled && { kind: "member", owner, member: modeled });
            }
        }
    }
}

/** Models every TS++ file once; diagnostics about the models themselves are reported here. */
export function indexProgram(
    sources: readonly TSPPAnalysisSourceFile[], nominalTypes: NominalTypesADTAPI | undefined, diagnostics: TSPPAnalysisDiagnostic[],
): ProgramIndex {
    const files = new Map<string, ModeledFile>();
    const declarations = new Map<string, DeclaredTarget>();
    for (const source of sources) {
        if (!source.fileName.endsWith(".tspp")) continue;
        const prepared = prepareVerificationSource(source, nominalTypes);
        const { sourceFile, refinements, records } = prepared;
        const file: ModeledFile = {
            source, prepared, functions: modelFunctions(prepared),
            classes: collectClassModels(sourceFile, source.text, refinements, records, diagnostics),
            callTargets: source.callTargets && new Map(source.callTargets.map(target => [rangeKey(target.start, target.end), target.declarations])),
            classAncestry: source.classAncestry && new Map(source.classAncestry.map(entry => [rangeKey(entry.start, entry.end), entry])),
        };
        files.set(source.fileName, file);
        indexDeclarations(file, declarations);
    }
    const index = { files, declarations };
    reportOverrides(index, diagnostics);
    return index;
}

const hasContract = (member: MemberModel | undefined) => !!member && (member.model.requires.length > 0 || member.model.ensures.length > 0);

/**
 * Calls through a base class's type rely on its contracts, which an override is not checked against, so overriding a
 * method that has one is refused. With the checker's ancestry this covers every class of every file, nested classes and
 * class expressions included; without it, top-level classes whose base is declared in the same file.
 */
function reportOverrides(index: ProgramIndex, diagnostics: TSPPAnalysisDiagnostic[]): void {
    const contractNames = new Set([...index.files.values()].flatMap(file => [...file.classes.values()])
        .flatMap(owner => [...owner.methods].filter(([, member]) => hasContract(member)).map(([name]) => name)));
    for (const file of index.files.values()) {
        const { sourceFile } = file.prepared;
        const report = (node: TS.Node, message: string) => diagnostics.push({
            fileName: sourceFile.fileName, start: nodeStart(node, sourceFile), length: nodeWidth(node, sourceFile),
            code: 19006, category: "error", source: "TS++ verification", message,
        });
        const refuse = (node: TS.Node, overridden: MemberModel) =>
            report(node, `Overriding '${overridden.model.name}', which has a contract, is not supported yet: callers rely on that contract, and the override is not checked against it.`);
        if (!file.classAncestry) {
            for (const model of file.classes.values()) {
                const base = model.base ? file.classes.get(model.base) : undefined;
                for (const [name, member] of base ? model.methods : []) {
                    const overridden = lookupMethod(base!, name, file.classes)?.member;
                    if (hasContract(overridden) && member.declaration) refuse(member.declaration.name ?? member.declaration, overridden!);
                }
            }
            continue;
        }
        const visit = (node: TS.Node): void => {
            const entry = ts.isClassLike(node) && node.pos >= 0 ? file.classAncestry!.get(rangeKey(nodeStart(node, sourceFile), node.end)) : undefined;
            if (entry && ts.isClassLike(node)) {
                const ancestors = entry.ancestors.flatMap(location => {
                    const target = index.declarations.get(declarationKey(location.fileName, location.start));
                    return target?.kind === "member" ? [target.owner] : [];
                });
                for (const member of node.members) {
                    const name = memberName(member.name);
                    if (name === undefined || ts.isConstructorDeclaration(member) || (ts.canHaveModifiers(member) && ts.getModifiers(member)?.some(modifier => modifier.kind === ts.SyntaxKind.StaticKeyword))) continue;
                    const overridden = ancestors.map(ancestor => ancestor.methods.get(name)).find(hasContract);
                    if (overridden) refuse(member.name!, overridden);
                    // Above a base the checker could not follow, any class may declare this method with a contract.
                    else if (!entry.complete && contractNames.has(name)) {
                        report(member.name!, `'${name}' may override a method with a contract in a class 'extends' reaches through an expression the verifier cannot follow, so it is refused.`);
                    }
                }
            }
            ts.forEachChild(node, visit);
        };
        visit(sourceFile);
    }
}
