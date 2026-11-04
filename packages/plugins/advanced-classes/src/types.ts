import type * as TS from "typescript-upstream";

export interface ClassMetadata {
    isFinal?: boolean;
    isSealed?: boolean;
    isData?: boolean;
    hasAsyncConstructor?: boolean;
    declaringFile: string;
    className: string;
    subclasses?: string[];
    finalMembers?: Set<string>;
    dataProperties?: { name: string; typeText?: string }[];
}

export interface AccessorFieldContext {
    accessorName: string;
    isGetter: boolean;
    isSetter: boolean;
    className?: string;
}

