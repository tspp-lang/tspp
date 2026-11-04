import type {
    TSPPSourcePreprocessor,
    TSPPTypeScript,
} from "@tspp/plugin-sdk/compiler";
import type * as TS from "typescript-upstream";

export function createAsyncNewSyntax(ts: TSPPTypeScript): {
    preprocessor: TSPPSourcePreprocessor;
    isAsyncConstructorAt: (pos: number) => boolean;
} {
    const asyncConstructorPositions = new Set<number>();

    const preprocessor: TSPPSourcePreprocessor = {
        id: "async-constructor-preprocessor",
        claims: [],
        preprocess(fileName, sourceText) {
            // Find `async constructor(` inside class bodies
            const pattern = /\b(async)\s+(constructor)\s*\(/g;
            let match: RegExpExecArray | null;
            let result = sourceText;

            while ((match = pattern.exec(sourceText)) !== null) {
                const asyncStart = match.index;
                asyncConstructorPositions.add(asyncStart);
                // Replace 'async ' (6 characters) with 6 spaces so standard TS parser sees normal 'constructor'
                result = result.slice(0, asyncStart) + "      " + result.slice(asyncStart + 6);
            }

            return result;
        },
    };

    return {
        preprocessor,
        isAsyncConstructorAt: pos => asyncConstructorPositions.has(pos),
    };
}

