# TS++ for VSCode

This development extension associates `.tspp` files with the `tspp` language
mode and starts `tspp-language-server` against the workspace `ts-plus-plus`
compiler package.

Open the repository root in VSCode and press `F5`. The default launch
configuration runs `scripts/launch-editor.mjs` in the integrated terminal. The
launcher builds the SDK, plugins, compiler, language server, and extension, then
opens a separate Extension Development Host and waits for that window to close.
Closing the development host therefore ends both the launcher and debug session.
The host opens the dedicated `packages/examples` workspace so `code --wait`
never reuses the repository window that launched the debugger.

The same development build can be run from the repository root with:

```sh
pnpm build:vscode:dev
```

The same persistent launcher used by `F5` can also be started directly:

```sh
node scripts/launch-editor.mjs
```

Set `tspp.sdkPath` only when you want the extension to use another TSPP SDK.
