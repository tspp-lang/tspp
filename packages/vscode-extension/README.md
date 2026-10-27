# TS++ development extension

This repository-local extension powers the TS++ example experience in an Extension Development Host.

The root launch configuration offers two F5 targets:

- `TS++: VS Code Extension` builds the compiler and language server, then opens `packages/examples` in an Extension Development Host;
- `TS++: Playground` starts the playground dev server on the compiler sources and opens it.

The status-bar item opens a quick picker, so users can switch examples without restarting the development host. The extension also verifies that the repository compiler exists and highlights TS++ `=>` kind arrows, `->` dependent-function arrows, and compile-time macro syntax.

Hovering a `macro fn(Target);` statement previews the formatted statements returned by that macro. The preview button in the editor title opens a read-only `*.expanded.tspp` document beside the source, showing the complete file after all macro calls have been replaced. Validation-only macros report that they emit no statements and disappear from the full-file preview.

The extension registers `.tspp` as the independent `tspp` language and starts the
`tspp-language-server` package through its exported entry point, which in turn uses the SDK exported by the
`ts-plus-plus` package. Ordinary `.ts` and
`.tsx` files remain owned by VS Code's built-in TypeScript extension and keep their configured
TypeScript SDK.
