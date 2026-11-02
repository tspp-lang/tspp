import type * as TS from "typescript-upstream";
import { ts } from "./host-api";
import type { NominalTypesADTAPI } from "@tspp/plugin-nominal-types/api";
import type { TSPPAnalysisSourceFile } from "@tspp/plugin-sdk/compiler";
import { verificationFileName } from "./contracts";
import {
    collectDataTypes, collectRecordTypes, parseFunctionModels, type DataConstructor, type FunctionModel,
} from "./models";
import { collectRefinements, type RefinementModel } from "./refinements";
import type { Sort } from "./expression";

export interface PreparedVerificationSource {
    readonly sourceFile: TS.SourceFile;
    readonly functions: ReadonlyMap<string, FunctionModel>;
    readonly refinements: ReadonlyMap<string, RefinementModel>;
    readonly records: ReadonlyMap<string, ReadonlyMap<string, Sort>>;
    readonly constructors: ReadonlyMap<string, DataConstructor>;
}

interface CacheEntry {
    readonly text: string;
    readonly nominalTypes: NominalTypesADTAPI | undefined;
    readonly prepared: PreparedVerificationSource;
}

const preparedSources = new Map<string, CacheEntry>();
const maximumPreparedSources = 64;

/** Reuses parsing and source-level model discovery while a file's contents stay unchanged. */
export function prepareVerificationSource(
    source: TSPPAnalysisSourceFile, nominalTypes: NominalTypesADTAPI | undefined,
): PreparedVerificationSource {
    const cached = preparedSources.get(source.fileName);
    if (cached?.text === source.text && cached.nominalTypes === nominalTypes) {
        preparedSources.delete(source.fileName);
        preparedSources.set(source.fileName, cached);
        return cached.prepared;
    }

    // The host's parser, so that every active plugin's syntax is parsed and lowered as in the program; the proofs read
    // ordinary TypeScript and depend on no plugin. Only the proof directives stay, under a name of their own.
    const sourceFile = ts.createSourceFile(verificationFileName(source.fileName), source.text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const functions = parseFunctionModels(source.text);
    const refinements = collectRefinements(source.text);
    const records = collectRecordTypes(sourceFile);
    const constructors = collectDataTypes(nominalTypes, source.text, records);
    const prepared = { sourceFile, functions, refinements, records, constructors };
    preparedSources.delete(source.fileName);
    preparedSources.set(source.fileName, { text: source.text, nominalTypes, prepared });
    if (preparedSources.size > maximumPreparedSources) preparedSources.delete(preparedSources.keys().next().value!);
    return prepared;
}

export function clearPreparedVerificationSources(): void {
    preparedSources.clear();
}
