# Command Kit

[中文](#中文) | [English](#english)

## 中文

**Command Kit**（`@tspp/command-kit`）是一个面向开发者的**类型安全命令行（CLI）开发库**。

你只需要声明命令、参数和选项，它会自动帮你完成：
- 解析命令行输入与环境变量
- 校验参数类型与必填项
- 自动生成 `--help` 帮助信息和 `--version` 版本信息
- 把类型推导好的参数直接交给你的业务逻辑执行

> 想看一个基于它做出来的完整实用工具？可以直接参考旁边的 [local-ip](../local-ip/README.md) 示例项目（TS++ 插件配置也可参考 [local-ip/tsppconfig.json](../local-ip/tsppconfig.json)）。

### 1. 安装与构建

准备好[仓库开发环境](../../../README.zh-CN.md#开发指南)后，在仓库根目录构建本库：

```sh
pnpm --filter @tspp/command-kit build
```

在需要使用它的项目 `package.json` 中添加工作区依赖：

```json
{
  "dependencies": {
    "@tspp/command-kit": "workspace:*"
  }
}
```

### 2. 快速上手：写一个问候命令

下面用 15 行代码定义一个支持位置参数和开关选项的 `greet` 命令：

```ts
import { Command, argument, flag, text } from "@tspp/command-kit";
import { CommandOutput } from "@tspp/command-kit/runtime";
import { runNode } from "@tspp/command-kit/node";

// 1. 定义参数与选项
const name = argument("name", text(), { description: "Who to greet" });
const loud = flag("loud", { short: "l", description: "Use uppercase" });

// 2. 组装命令
const app = new Command("greet", "Greet someone")
  .argument(name)
  .option(loud);

// 3. 运行并自动推导类型：invocation.get(name) 为 string，invocation.get(loud) 为 boolean
process.exitCode = runNode(app, invocation => {
  const message = `Hello, ${invocation.get(name)}!`;
  return new CommandOutput(0, invocation.get(loud) ? message.toUpperCase() : message);
});
```

编译为 `greet.js` 后即可运行：

```sh
node greet.js Ada --loud
# HELLO, ADA!

node greet.js --help
```

### 3. 核心 API 速查

| API | 用途 |
| --- | --- |
| `new Command(name, description)` | 创建命令，通过 `.command(child)` 注册子命令 |
| `flag(name, settings)` | 定义布尔开关（如 `--loud` / `-l`） |
| `option(name, codec, settings)` | 定义带值选项，可配置短名和关联的环境变量 |
| `argument` / `optionalArgument` / `variadicArgument` | 依次用于定义**必填**、**可选**、**末尾可变长**位置参数 |
| `text()` / `integer()` / `boolean()` / `choice(values)` | 内置值解析器；如需自定义类型可使用 `customCodec` |

### 4. 使用规则与常见细节

写命令时记住下面这几条即可避免踩坑：

- **链式修饰会返回新句柄**：对选项调用 `.required()` 或 `.withDefault(value)` 时，会返回一个**新的**选项句柄，必须保存返回值并把它注册到 `Command` 上（原句柄不会被修改）。
- **取值优先级**：`命令行输入` > `环境变量` > `默认值`。如果命令行重复传入同一个选项，以最后一次为准。
- **子命令与位置参数二选一**：同一个命令不能同时定义子命令和位置参数；父命令的选项可以放在子命令名的前面或后面。
- **命令行写法支持**：
  - 支持 `--name=value`、`-n10`、组合短开关（如 `-ab`）、`--no-flag` 取反，以及 `--` 结束选项解析。
  - 如果文本值以 `-` 开头，请使用 `--name=-value` 传入；负数可以直接作为下一个参数传入。

### 5. 执行方式与退出码

- **托管执行（推荐）**：使用 `runNode(app, handler)` 同步执行业务逻辑、打印 `CommandOutput` 并返回退出码（由应用赋给 `process.exitCode`）。
  - 请求帮助或版本信息时返回 `0`
  - 命令行参数校验失败时返回 `2`
  - 正常业务逻辑的退出码由你返回的 `CommandOutput` 决定
- **手动接管解析**：如果需要自己控制打印和退出流程，可调用 `Command.parse(argv, { env })`。它不会主动打印或退出进程，而是返回 `Parsed`、`HelpRequested`、`VersionRequested` 或 `ParseFailed`。注意传入的 `argv` **只包含用户参数**（不含 Node 默认的前两项）。

### 6. 开发与测试

```sh
pnpm --filter @tspp/command-kit check
pnpm --filter @tspp/command-kit test
```

---

## English

**Command Kit** (`@tspp/command-kit`) is a **type-safe CLI development library** for TypeScript/TS++ developers.

Declare your commands, arguments, and options, and the library handles:
- Parsing CLI arguments and environment variables
- Validating input types and required values
- Generating `--help` and `--version` output
- Passing strongly typed parsed values directly to your application logic

> For a complete standalone application built with this library, see [local-ip](../local-ip/README.md) (and [local-ip/tsppconfig.json](../local-ip/tsppconfig.json) for TS++ plugin configuration).

### 1. Build and Install

After setting up the [repository development environment](../../../README.md#development), build the library from the repository root:

```sh
pnpm --filter @tspp/command-kit build
```

Declare it as a workspace dependency in your project's `package.json`:

```json
{
  "dependencies": {
    "@tspp/command-kit": "workspace:*"
  }
}
```

### 2. Quick Start: A Greeting Command

Define a `greet` command with one positional argument and one flag:

```ts
import { Command, argument, flag, text } from "@tspp/command-kit";
import { CommandOutput } from "@tspp/command-kit/runtime";
import { runNode } from "@tspp/command-kit/node";

// 1. Define argument and option
const name = argument("name", text(), { description: "Who to greet" });
const loud = flag("loud", { short: "l", description: "Use uppercase" });

// 2. Assemble the command
const app = new Command("greet", "Greet someone")
  .argument(name)
  .option(loud);

// 3. Run with inferred types: invocation.get(name) is string, invocation.get(loud) is boolean
process.exitCode = runNode(app, invocation => {
  const message = `Hello, ${invocation.get(name)}!`;
  return new CommandOutput(0, invocation.get(loud) ? message.toUpperCase() : message);
});
```

Compile it as `greet.js` and run:

```sh
node greet.js Ada --loud
# HELLO, ADA!

node greet.js --help
```

### 3. API Quick Reference

| API | Purpose |
| --- | --- |
| `new Command(name, description)` | Create a command; register subcommands with `.command(child)` |
| `flag(name, settings)` | Define a boolean flag (e.g. `--loud` / `-l`) |
| `option(name, codec, settings)` | Define a value option with an optional short name and environment variable |
| `argument` / `optionalArgument` / `variadicArgument` | Define **required**, **optional**, and **trailing variadic** positional arguments |
| `text()` / `integer()` / `boolean()` / `choice(values)` | Built-in decoders; use `customCodec` for custom types |

### 4. Rules and Parsing Details

- **Immutability on `.required()` and `.withDefault(value)`**: Both return a **new** option handle. Save and register the returned handle rather than the original one.
- **Value precedence**: `command line` > `environment variable` > `default`. Repeated CLI options use the last value.
- **Subcommands vs. positional arguments**: A command can define either subcommands or positional arguments, not both. Parent options can appear before or after a subcommand name.
- **Supported CLI syntax**:
  - Supports `--name=value`, `-n10`, grouped short flags, `--no-flag`, and `--` to end option parsing.
  - Pass text values starting with `-` as `--name=-value`; negative numbers can be passed as the next argument.

### 5. Execution and Exit Codes

- **Managed execution (recommended)**: `runNode(app, handler)` runs synchronous actions, prints `CommandOutput`, and returns an exit code for `process.exitCode`:
  - `0` for help or version requests
  - `2` for invalid command arguments
  - Custom exit codes returned by your `CommandOutput`
- **Manual parsing**: Call `Command.parse(argv, { env })` to get `Parsed`, `HelpRequested`, `VersionRequested`, or `ParseFailed` without printing or exiting. Pass **user arguments only** (excluding Node's first two `argv` entries).

### 6. Development

```sh
pnpm --filter @tspp/command-kit check
pnpm --filter @tspp/command-kit test
```
