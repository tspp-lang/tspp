/** Static editor metadata. Hosts merge these declarations at package time. */
export interface TSPPEditorContribution {
    readonly commands?: readonly { readonly id: string; readonly title: string; }[];
    readonly grammars?: readonly string[];
    readonly snippets?: readonly string[];
    readonly configuration?: Readonly<Record<string, unknown>>;
}
