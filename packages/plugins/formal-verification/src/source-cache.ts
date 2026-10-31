import ts from "typescript";
import type { TSPPAnalysisSourceFile } from "@tspp/plugin-sdk/compiler";
import { maskContractClauses } from "./contracts";
import {
    collectDataTypes, collectRecordTypes, parseFunctionModels, type FunctionModel,
} from "./models";
import { collectRefinements, type RefinementModel } from "./refinements";
import type { Sort } from "./expression";

export interface PreparedVerificationSource {
    readonly sourceFile: ts.SourceFile;
    readonly functions: ReadonlyMap<string, FunctionModel>;
    readonly refinements: ReadonlyMap<string, RefinementModel>;
    readonly records: ReadonlyMap<string, ReadonlyMap<string, Sort>>;
    readonly constructors: ReadonlyMap<string, { readonly tag: string; readonly fields: readonly string[]; }>;
}

interface CacheEntry {
    readonly text: string;
    readonly prepared: PreparedVerificationSource;
}

const preparedSources = new Map<string, CacheEntry>();
const maximumPreparedSources = 64;

/** Reuses parsing and source-level model discovery while a file's contents stay unchanged. */
export function prepareVerificationSource(source: TSPPAnalysisSourceFile): PreparedVerificationSource {
    const cached = preparedSources.get(source.fileName);
    if (cached?.text === source.text) {
        preparedSources.delete(source.fileName);
        preparedSources.set(source.fileName, cached);
        return cached.prepared;
    }

    const masked = maskContractClauses(source.fileName, source.text, false);
    const sourceFile = ts.createSourceFile(source.fileName, masked, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const functions = parseFunctionModels(source.text);
    const refinements = collectRefinements(source.text);
    const records = collectRecordTypes(sourceFile);
    const constructors = collectDataTypes(source.text, records);
    const prepared = { sourceFile, functions, refinements, records, constructors };
    preparedSources.delete(source.fileName);
    preparedSources.set(source.fileName, { text: source.text, prepared });
    if (preparedSources.size > maximumPreparedSources) preparedSources.delete(preparedSources.keys().next().value!);
    return prepared;
}

export function clearPreparedVerificationSources(): void {
    preparedSources.clear();
}
