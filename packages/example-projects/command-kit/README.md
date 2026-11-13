# Command Kit

使用 TS++ 独立实现的命令行应用开发工具库，同时提供仓库包清单与依赖查询 CLI。
工具库借鉴 Commander.js 解决的功能需求，
自行设计 API、实现和测试，不复用其源码、类型声明或测试，也不承诺兼容其调用细节。

An independently implemented CLI development library and repository inspection CLI
written in TS++. The library draws on the
functional needs addressed by Commander.js, with its own API, implementation, and tests.
It does not reuse Commander.js source code, type declarations, or tests, and does not
promise compatibility with its API details.

## 构建与验证 / Build and Verification

项目只使用一份 `tsppconfig.json`，统一编译 `src/` 中的工具库和 CLI，产物位于 `dist/`。

The project uses a single `tsppconfig.json` to build both the library and CLI from
`src/` into `dist/`.

在仓库根目录执行，使用仓库规定的 Node.js 22 和 pnpm 12.4.2：

Run from the repository root using the required Node.js 22 and pnpm 12.4.2:

```sh
pnpm install
pnpm build:plugin-sdk
pnpm build:plugins
pnpm build:compiler
pnpm --filter @tspp/command-kit test
```

`test` 会构建项目和实际 CLI，并验证命令解析、参数校验、终端输出和仓库包查询等功能。
根目录的 `build:example-projects`、`test:example-projects` 可统一运行这类项目。

`test` builds the project and its working CLI, then verifies command parsing, argument
validation, terminal output, and repository package queries. The root scripts `build:example-projects` and
`test:example-projects` build and test all projects in this directory.

这里按实际软件项目维护，只测试自身承诺的功能。编译器、插件组合和声明回退的专项回归由对应包负责。

This directory is maintained as a software project, with tests for its own promised
behavior. Compiler, plugin-composition, and declaration-fallback regressions belong to their respective packages.

## 定义一个命令 / Define a Command

```ts
import { Command, option, flag, argument, integer, text } from "@tspp/command-kit";
import { CommandOutput } from "@tspp/command-kit/runtime";
import { runNode } from "@tspp/command-kit/node";

const count = option("count", integer(), {
  short: "n", env: "REPEAT_COUNT", description: "Number of repetitions",
}).withDefault(1);
const loud = flag("loud", { short: "l" });
const message = argument("message", text());

const app = new Command("repeat", "Repeat a message")
  .version("0.1.0")
  .option(count)
  .option(loud)
  .argument(message);

process.exitCode = runNode(app, invocation => {
  const source = invocation.get(message);
  const content = invocation.get(loud) ? source.toUpperCase() : source;
  return new CommandOutput(0, Array.from({ length: invocation.get(count) }, () => content).join("\n"));
});
```

`Invocation.get(handle)` 根据句柄保留返回类型：上面的 `count` 是 `number`，
`loud` 是 `boolean`，`message` 是 `string`。未设默认值的普通选项返回 `T | undefined`。
`.required()` 和 `.withDefault(value)` 返回新的句柄，需要保存并注册返回值。

`Invocation.get(handle)` preserves the return type carried by the handle: `count`
above is a `number`, `loud` is a `boolean`, and `message` is a `string`. Ordinary
options without defaults return `T | undefined`. Both `.required()` and
`.withDefault(value)` return new handles; save and register the returned handle.

## 支持的行为 / Supported Behavior

支持嵌套子命令、继承的全局选项、长短选项、`--name=value`、`-n10`、短旗标组合、
布尔反选 `--no-loud`、负数值、`--` 后的原样参数，以及必填、可选、末尾可变长位置参数。
值来源优先级为命令行、环境变量、默认值。内置文本、严格安全整数、布尔和枚举解码器，
可通过 `customCodec` 扩展。重复选项取最后一次输入的值。

Supports nested subcommands, inherited global options, long and short options,
`--name=value`, `-n10`, grouped short flags, negated boolean flags such as `--no-loud`,
negative values, literal arguments after `--`, and required, optional, and trailing
variadic positional arguments. Values take precedence in this order: command line,
environment variable, then default. Built-in codecs cover text, strict safe integers,
booleans, and choices; `customCodec` supports additional types. For repeated options,
the last command-line value wins.

选项句柄使用独立身份；读取未注册到当前调用的句柄会报错。父命令选项在子命令名前后均可用，
位置参数属于最终选择的命令。一个命令可拥有子命令或位置参数，两者不能混用；
定义阶段同时检查重名、短名冲突、保留名称、命令树循环和参数顺序。

Each option handle has its own identity; reading a handle not registered for the
current invocation throws an error. Parent options work before or after a subcommand
name. Positional arguments belong to the selected command. A command may define
subcommands or positional arguments, but cannot mix them. Definition-time checks also
reject duplicate names, short-option conflicts, reserved names, command-tree cycles,
and invalid argument ordering.

`Command.parse(argv, { env })` 只接受用户参数，不需要 Node 的前两个 argv 项。
它返回 `Parsed`、`HelpRequested`、`VersionRequested` 或 `ParseFailed`，不会打印或退出进程。
帮助与版本请求跳过尚未进行的必填检查；在它们之前已经遇到的错误仍然返回错误。
选项值以 `-` 开头时，可使用 `--name=-value` 明确传入；负数可直接作为下一个参数传入。

`Command.parse(argv, { env })` accepts user arguments only, without Node's first two
argv entries. It returns `Parsed`, `HelpRequested`, `VersionRequested`, or
`ParseFailed`, without printing or exiting the process. Help and version requests
skip required-value checks that have not yet run; errors encountered earlier are
still returned. Use `--name=-value` to pass an option value starting with `-`;
negative numbers can also be passed as the next argument.

`run` 通过 `Terminal` 效应输出，`runNode` 为该效应提供 Node 处理器并返回退出码。
正常帮助与版本返回 0，参数错误返回 2，应用动作自行返回业务退出码。
应用异常会继续抛出，应用可在自己的边界处理。当前动作执行器是同步的，
尚未提供异步生命周期钩子、补全、外部可执行子命令或 Commander.js 兼容层。

`run` writes through the `Terminal` effect. `runNode` supplies a Node handler for that
effect and returns an exit code. Help and version requests return 0, usage errors
return 2, and application actions choose their own exit codes. Application exceptions
propagate so applications can handle them at their own boundary. The action runner is
currently synchronous; asynchronous lifecycle hooks, completion, external executable
subcommands, and a Commander.js compatibility layer are not provided.

## 仓库查询命令行 / Workspace CLI

`src/cli.tspp` 是正式命令行入口，`src/workspace/catalog.tspp` 负责包清单读取和依赖信息整理。
构建后可从仓库根目录运行：

`src/cli.tspp` is the command-line entry point. `src/workspace/catalog.tspp` reads
package manifests and collects dependency information. After building, run it from
the repository root:

```sh
pnpm --filter @tspp/command-kit build
node packages/example-projects/command-kit/dist/cli.js --help
node packages/example-projects/command-kit/dist/cli.js list . --scope @tspp/ --limit 5
node packages/example-projects/command-kit/dist/cli.js --json deps ts-plus-plus .
```

包声明了 `command-kit` 可执行入口。在包目录内也可以通过 `pnpm run cli --help` 启动；
运行参数中的目录路径相对于当前工作目录。

The package declares a `command-kit` executable. From the package directory, you can
also start it with `pnpm run cli --help`. Directory arguments are relative to the
current working directory.

它读取根目录与 `packages/` 下的包清单，遇到包即停止向包内部递归，跳过隐藏目录、
`node_modules` 和目录符号链接。它按当前仓库的目录约定扫描，不解析任意 workspace glob。
`--json` 输出结构化数据；`COMMAND_KIT_LIMIT` 可设置列表数量；`--scope` 按名称前缀筛选。
依赖查询包含 dependencies、devDependencies、peerDependencies 和 optionalDependencies 中的本地包。

It reads package manifests at the root and under `packages/`, stopping recursion
inside each package and skipping hidden directories, `node_modules`, and directory
symlinks. It follows this repository's directory conventions rather than interpreting
arbitrary workspace globs. `--json` produces structured output, `COMMAND_KIT_LIMIT`
sets the listing limit, and `--scope` filters package names by prefix. Dependency
queries include local packages listed in dependencies, devDependencies,
peerDependencies, and optionalDependencies.

## TS++ 特性的实际用途 / Practical Uses of TS++ Features

| 特性 / Feature | 实现中的用途 / Use in the Implementation |
| --- | --- |
| `data` / `match` | 参数 token、解码结果和解析结果的封闭分支与穷尽处理 / Closed variants and exhaustive handling of argument tokens, decoding results, and parsing results |
| `newtype` | 区分选项名和位置参数名 / Distinct types for option names and positional argument names |
| `typeclass` / `impl` / `where` | 为基础值提供解码能力，再封装成可组合的 Codec / Decoding capabilities for primitive values, wrapped as composable codecs |
| `data class` | 诊断信息和动作输出的数据模型 / Data models for diagnostics and action output |
| `def` / `do` | 只读定义与有返回值的多步解析分支 / Read-only definitions and value-producing, multi-step parsing branches |
| `effect` / `perform` / `handle` | 执行器与实际终端输出解耦 / Separation of command execution from terminal output |

运行时 JavaScript 完全由本项目的 `.tspp` 源码生成。构建同时生成供标准 TS 使用的 `.d.ts`
和保留语言特性的 `.d.tspp`；没有对上游 Commander.js 运行库的依赖。

Runtime JavaScript is generated entirely from this project's `.tspp` sources. Builds
produce both `.d.ts` declarations for standard TypeScript and `.d.tspp` declarations
that preserve TS++ features. There is no dependency on the upstream Commander.js runtime.

TS++ 消费者要直接使用原生 ADT 模式匹配，需要启用声明头列出的五个插件：
`nominal-types`、`advanced-classes`、`modern-syntax`、`typeclasses` 和 `algebraic-effects`。

To use native ADT pattern matching directly, TS++ consumers must enable all five
plugins listed in the declaration header: `nominal-types`, `advanced-classes`,
`modern-syntax`, `typeclasses`, and `algebraic-effects`.
