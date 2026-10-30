# TS++ for VSCode

This development extension associates `.tspp` files with the `tspp` language
mode and starts `tspp-language-server` against the workspace `ts-plus-plus`
compiler package.

Build the compiler and language server from the repository root before starting
an Extension Development Host:

```sh
pnpm build
```

Set `tspp.sdkPath` only when you want the extension to use another TSPP SDK.
