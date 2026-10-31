# TS++ for VSCode

This development extension associates `.tspp` files with the `tspp` language
mode and starts `tspp-language-server` against the workspace `ts-plus-plus`
compiler package.

Open the repository root in VSCode and press `F5`. The default launch
configuration builds the SDK, plugins, compiler, language server, and extension,
then keeps the language server bundler in watch mode while a separate Extension
Development Host is open. Closing the development host ends the debug session.

The same development build can be run from the repository root with:

```sh
pnpm build:vscode:dev
```

The persistent development watcher used by `F5` can also be started directly:

```sh
pnpm watch:vscode:dev
```

Set `tspp.sdkPath` only when you want the extension to use another TSPP SDK.
