# TS++ for VSCode

This development extension associates `.tspp` files with the `tspp` language
mode and starts `tspp-language-server` against the workspace `ts-plus-plus`
compiler package.

Open the repository root in VSCode and press `F5`. The default launch
configuration builds the SDK, plugins, compiler, language server, and extension,
then opens an Extension Development Host with this extension loaded.

The same development build can be run from the repository root with:

```sh
pnpm build:vscode:dev
```

Set `tspp.sdkPath` only when you want the extension to use another TSPP SDK.
