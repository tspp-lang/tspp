/** Static editor metadata. Hosts merge these declarations at package time. */
export interface TSPPEditorContribution {
    /** Word-like lexical tokens shared by lightweight editor hosts such as Monaco. */
    readonly keywords?: readonly string[];
    readonly commands?: readonly { readonly id: string; readonly title: string; }[];
    readonly grammars?: readonly string[];
    readonly snippets?: readonly string[];
    readonly configuration?: Readonly<Record<string, unknown>>;
}
