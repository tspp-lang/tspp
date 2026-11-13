# TS++ for VSCode

This development extension associates `.tspp` files with the `tspp` language
mode and starts `tspp-language-server` against the workspace `ts-plus-plus`
compiler package.

这个开发扩展把 `.tspp` 文件关联到 `tspp` 语言，并使用工作区的 `ts-plus-plus`
编译器启动 `tspp-language-server`。

TS++ projects use `tsppconfig.json`; `.tspp` project discovery does not fall back
to `tsconfig.json` or `jsconfig.json`. Opening `tsppconfig.json` or a
`tsppconfig.*.json` variant activates configuration support without opening a
source file. These documents keep the JSONC language and its built-in JSON
completion service. A local schema, generated from the bundled compiler's option
declarations, supplies option names, types, and allowed enum values without a
network request. Plugin objects retain their plugin-specific options.
Configuration text is synchronized separately from source files, so TS++ does
not register another completion or formatting provider for JSON documents.

TS++ 项目使用 `tsppconfig.json`；`.tspp` 项目发现不会回退到 `tsconfig.json`
或 `jsconfig.json`。只打开 `tsppconfig.json` 或 `tsppconfig.*.json` 变体也会启用
配置支持。配置文件保留 JSONC 语言和内置 JSON 补全；本地 schema 从配套编译器的
选项定义生成，提供选项名、类型和枚举值，无需联网。插件对象允许各插件自己的配置项。
配置文本单独同步到服务器，TS++ 不会为 JSON 文件额外注册补全或格式化提供器。

The compiler also validates unsaved configuration text and reports JSON syntax,
invalid compiler options, missing inherited files, and missing inputs through the
`TS++ configuration` diagnostic collection. Changes to inherited JSON and source
file creation/deletion refresh open configurations. The schema describes complex
objects such as plugins and paths structurally; the compiler remains responsible
for cross-option and project validation. Ordinary JSON documents alone do not
start a TSPP language server.

编译器还会检查未保存的配置文本，通过 `TS++ configuration` 诊断集合报告 JSON
语法、非法编译选项、缺失的继承配置和输入文件。继承的 JSON 配置变化以及源码创建、
删除会刷新已打开的配置。Schema 提供 plugins、paths 等复杂对象的结构提示，选项间
约束和项目校验由编译器负责。只打开普通 JSON 文件不会启动 TSPP 语言服务器。

Open the repository root in VSCode and press `F5`. The default launch
configuration runs `scripts/launch-editor.mjs` in the integrated terminal. The
launcher builds the SDK, plugins, compiler, language server, and extension, then
opens a separate Extension Development Host and waits for that window to close.
Closing the development host therefore ends both the launcher and debug session.
The host opens the dedicated `packages/examples` workspace so `code --wait`
never reuses the repository window that launched the debugger.

在 VSCode 打开仓库根目录后按 `F5`，启动配置会在集成终端运行
`scripts/launch-editor.mjs`。它构建 SDK、插件、编译器、语言服务器和扩展，再打开独立
的扩展开发窗口并等待关闭。关闭该窗口会结束启动器和调试会话。开发窗口打开专用的
`packages/examples` 工作区，避免 `code --wait` 复用仓库窗口。

The same development build can be run from the repository root with:

也可以在仓库根目录执行同样的开发构建：

```sh
pnpm build:vscode:dev
```

The same persistent launcher used by `F5` can also be started directly:

`F5` 使用的启动器也能直接运行：

```sh
node scripts/launch-editor.mjs
```

Set `tspp.sdkPath` only when you want the extension to use another TSPP SDK.

需要使用其他 TSPP SDK 时，设置 `tspp.sdkPath`。

The command palette exposes the plugin-owned inspection outputs through generic
analysis artifacts:

命令面板通过通用分析产物展示插件的检查结果：

- **TS++: Show SMT Source** opens replayable SMT-LIB proof obligations;
  打开可重放的 SMT-LIB 证明义务。
- **TS++: Show MLTT Normal Forms** opens each alias's normalized MLTT type and
  beta-normal term;
  打开类型别名归一化后的 MLTT 类型与 β 范式项。
- **TS++: Show Analysis Artifacts** opens every artifact for the active file.
  打开当前文件的所有分析产物。
- **TS++: Show Projected TypeScript** shows the length-preserving source seen by
  the upstream parser after all feature projections.
  展示所有特性投影后，上游解析器收到的等长源码。
- **TS++: Show Active Feature Capsules** reports the active plugin identities,
  versions, and SDK contract versions.
  列出已启用插件的身份、版本和 SDK 契约版本。
