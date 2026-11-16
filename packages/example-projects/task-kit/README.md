# task-kit

[中文](#中文) | [English](#english)

## 中文

随着项目规模增长，传统的 `package.json` `scripts` 或零散的 Shell 脚本往往难以维护：任务数量一多就容易遗忘名称，串行与并行依赖不易编排，环境变量与加密配置的加载逻辑分散，交互式参数收集往往需要额外的包装脚本，而在任务失败或被中断时也难以彻底清理子进程。

`@tspp/task-kit`（基于 TS++ 与 `@tspp/command-kit` 构建）提供了一套结构化的任务执行方案，将项目中的各类命令统一为**可校验、可搜索、可预测**的任务图：

- **交互式任务检索**：无参数启动即可通过模糊搜索选择任务，并自动置顶上次执行的记录。
- **可靠的依赖编排**：支持串行与并行依赖，在执行前提前校验缺失依赖、循环引用与环境冲突；相同环境下的共享依赖在单次执行中仅运行一次。
- **可控的环境与准备流程**：内置 dotenv 解析（支持 `${NAME}` 插值）与自定义解密钩子，支持在命令启动前通过 `prepare` 收集参数，并提供 `--dry-run` 与 `--prepare-only` 用于预览完整执行计划。
- **完整的进程树清理**：当发生取消操作或并行任务失败时，能够安全终止该次执行所启动的整个子进程树（兼容 POSIX 与 Windows）。

该库不绑定任何固定的项目目录，调用时只需传入 `rootDir` 即可在任意项目中使用。

---

### 快速开始

在项目中新建一个入口文件（例如 `task.tspp`）：

```ts
import { command, defineTasks, runTaskCli } from "@tspp/task-kit";

const tasks = defineTasks({
  check: {
    description: "Check the project",
    dependencies: ["check:type", "check:test"],
    dependencyMode: "parallel",
  },
  "check:type": {
    description: "Check TypeScript types",
    run: command("tsc", "--noEmit"),
    public: false,
  },
  "check:test": {
    description: "Run tests",
    run: command("node", "--test"),
    forwardArgs: true,
  },
});

runTaskCli(tasks, { rootDir: process.cwd() }).then(code => {
  process.exitCode = code;
});
```

使用项目中的运行器启动即可，例如：

```bash
tspp task.tspp                         # 打开交互式界面搜索并选择公开任务
tspp task.tspp --list                  # 列出所有公开任务
tspp task.tspp --list-all              # 列出所有任务（含内部任务）
tspp task.tspp check --dry-run         # 仅预览静态执行计划（不读取 env 文件，也不运行 prepare）
tspp task.tspp check --prepare-only    # 完成所有准备阶段，只打印最终将执行的命令
tspp task.tspp check --env .env.local  # 指定全局环境变量文件
tspp task.tspp check:test -- --watch   # 将 `--` 后的参数透传给目标任务
```

---

### 交互式任务选择

不传任务名直接运行 CLI 时，会进入交互式选择器：

- **快捷操作**：支持输入即时筛选、上下方向键移动、翻页、查看任务详情、`Enter` 确认执行、`Esc` / `Ctrl-C` 取消。
- **智能匹配**：支持按完整名称、前缀、连续片段、忽略标点、分段首字母、子序列、任务说明以及多关键词搜索，并优先展示上次选中的任务。
- **历史缓存**：默认保存在 `<rootDir>/node_modules/.cache/task-kit/selection.json`，可通过 `cacheFile` 覆盖。即使缓存文件不可读、损坏或写入失败，也不会影响任务正常执行。
- **非交互与自定义**：在非交互式终端中必须显式传入任务名；如果需要接入自定义界面，可通过 `selectTask` 注入自己的选择器实现。

---

### 任务定义

`defineTasks` 中的每个任务支持以下属性：

| 属性 | 说明 |
| --- | --- |
| `description`, `details` | 任务简介，以及在交互式选择界面中展示的完整说明 |
| `dependencies`, `dependencyMode` | 依赖任务名称列表；执行模式支持 `serial`（默认，串行）或 `parallel`（并行） |
| `run` | `command(program, ...args)` 或命令数组；同一任务内的多条命令始终串行执行 |
| `envFile`, `env` | 环境变量文件路径和额外覆盖变量，会自动传递给下游依赖 |
| `cwd` | 相对于 `rootDir` 的工作目录，默认为 `.` |
| `forwardArgs` | 是否允许根任务接收命令行 `--` 之后透传的参数 |
| `prepare` | 命令执行前收集参数的钩子函数，返回 `{ args }` |
| `inheritStdin` | 正式执行命令时是否继承终端输入，默认关闭 |
| `requireEnvFile` | 正式执行或准备阶段要求当前任务、祖先任务或显式选项必须提供环境文件 |
| `public` | 设为 `false` 可在列表和交互搜索中隐藏该任务（仍可显式执行或作为依赖引用） |

#### 参数准备（`prepare`）与参数透传

- `prepare(context)` 可以是同步或异步函数，接收只读上下文 `{ taskName, isRoot, args, env, cwd, signal }`。
- 准备阶段从根任务开始，按声明顺序深度优先遍历所有依赖；被多个任务共享的依赖只会准备一次。
- 在任何 `prepare` 运行之前，系统会先校验整张任务表是否存在未知依赖或循环依赖，以及可达任务之间是否存在环境配置冲突。准备阶段一旦失败，不会启动任何命令。
- 当根任务开启 `forwardArgs` 时，命令行传入的额外参数只会附加到**根任务的最后一条命令**上。依赖任务不会收到根参数，但它们各自的 `prepare` 返回的 `args` 同样会附加到该依赖的最后一条命令上。

---

### 编程式调用与执行计划

除了通过 CLI 启动，也可以直接在代码中调用：

- **一步执行**：调用 `runTasks(tasks, name, options)`，执行完成后返回只读的 `TaskPlan`。
- **先审核再执行**：先调用 `prepareTasks(tasks, name, options)` 生成计划，通过 `formatPlan(plan)` 打印或检查内容，确认后再调用 `executePlan(plan, options)`。

执行计划会完整复制并冻结命令、参数、依赖关系和解析后的环境变量，实际执行时不会重新读取任务定义或环境文件。因此，同一份已准备好的计划可以安全地多次重复执行。

- **共享依赖去重**：在相同环境下，被多个分支依赖的同一个任务在单次执行中只会运行一次；如果不同祖先向同一个共享依赖传递了互相冲突的环境配置，会在准备阶段提前报错。
- **静态预览（`dryRun`）**：`dryRun: true` 会生成 `prepared: false` 的静态计划，仅供查看，不能交给 `executePlan` 执行。

#### `TaskOptions` 常用选项

- `rootDir`（必填）：项目根目录。
- `envFile`、`env`：显式指定环境文件，或传入基础环境变量对象（替代默认的 `process.env`）。
- `args`：传递给根任务的额外参数。
- `dryRun`、`prepareOnly`：控制仅生成静态计划，或仅运行准备阶段而不执行命令。
- `signal`：传入 `AbortSignal` 以支持外部取消。
- `logger`：自定义日志输出。
- `gracefulTimeoutMs`：取消或终止进程树时的优雅退出等待时间，默认 `10000` 毫秒。

---

### 环境变量与自定义加载器

#### 覆盖优先级与解析规则

1. 显式传入的 `options.envFile` 会替换任务链中各任务自己声明的 `envFile`。
2. 从环境文件读取到的变量会覆盖继承自 `options.env` / `process.env` 的同名变量。
3. 任务自身配置的 `env` 拥有最高优先级，在最后进行覆盖。
4. 加载环境文件后，会自动注入 `ENV_FILE_PATH` 和 `PROJECT_ROOT_DIR`。

内置的 dotenv 解析器支持空值、引号、多行文本、注释以及递归的 `${NAME}` 变量插值；遇到未定义变量引用或循环引用时会立即报错。

#### 加密环境文件示例

如果项目中的环境文件是加密的，可以通过 `loadEnvFile` 接入自定义解密逻辑，返回 dotenv 明文字符串或键值对对象即可：

```ts
runTasks(tasks, "check", {
  rootDir: process.cwd(),
  envFile: ".env.encrypted",
  loadEnvFile: async ({ rootDir, filePath, env, signal }) => {
    // 在这里调用项目自己的解密实现，返回 dotenv 明文或字符串变量表
    return { API_URL: "https://example.test", MODE: "check" };
  },
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
```

---

### 进程管理与退出码

- **隔离的进程树清理**：每次任务执行都会独立追踪自己启动的子进程，互不干扰。遇到外部取消或并行依赖失败时，会立即阻止启动新命令、清理当前执行对应的整个进程树，并等待已启动的任务收尾后返回。
  - **POSIX**：通过独立进程组管理并终止。
  - **Windows**：使用 `cross-spawn` 处理 `PATH`、命令垫片与参数转义；清理时结合 `taskkill /T` 与 CIM 查询，确保即使父进程已提前退出，其残留后代也能被一并清理。超过 `gracefulTimeoutMs` 后强制结束。Windows 下具体进程对终端信号及温和 `taskkill` 的响应取决于目标程序自身与系统行为。
- **CLI 信号处理**：CLI 会监听 `SIGINT` 和 `SIGTERM`，收到第二次信号时立即强制结束；执行结束后会移除自身注册的信号监听器，且不会直接调用 `process.exit`。

| 退出码 | 含义 |
| --- | --- |
| `0` | 执行成功、打印帮助/列表，或交互式取消选择 |
| `1` | 任务执行失败 |
| `2` | 命令行参数错误 |
| `130` | 收到 `SIGINT` 中断 |
| `143` | 收到 `SIGTERM` 终止 |

---

### 实现特点（TS++）

- 使用 `newtype EnvironmentId` 严格隔离环境标识。
- 使用 `data class` 表达准备完成后的不可变值对象。
- 使用 `data RunMode` 与穷尽 `match` 表达不同执行模式。
- 通过 `PlanOutput` 代数效应向调用方请求计划输出能力。
- 运行时状态与不可变计划完全分离，确保同一计划可独立重复执行。

---

### 本地开发

在本包目录下运行：

```bash
pnpm build       # 编译为 CommonJS，并生成 .d.ts / .d.tspp 类型声明
pnpm check       # 仅做类型与源码检查，不输出构建产物
pnpm test        # 先构建，再运行 node:test 行为测试
pnpm test:run    # 直接使用当前已有构建运行测试
```

---

## English

As a project grows, managing tasks through `package.json` `scripts` or ad-hoc shell scripts becomes error-prone: task names are difficult to remember, serial and parallel dependencies are cumbersome to compose, environment loading and decryption logic end up duplicated, pre-run prompts require custom wrapper scripts, and interrupting a run can leave orphaned child processes behind.

`@tspp/task-kit` (built with TS++ and `@tspp/command-kit`) consolidates project commands into a **validated, searchable, and predictable** task runner:

- **Interactive Task Discovery**: Launch without arguments to filter tasks with fuzzy search, prioritizing your most recent selection.
- **Validated Dependency Graphs**: Compose serial or parallel dependencies with upfront checks for missing tasks, cycles, and environment conflicts; shared dependencies under matching environments run once per execution.
- **Prepared Environments & Arguments**: Includes built-in dotenv parsing (with `${NAME}` interpolation), custom decryption hooks (`loadEnvFile`), pre-execution `prepare` hooks, and `--dry-run` / `--prepare-only` modes to inspect the plan beforehand.
- **Isolated Process-Tree Cleanup**: On cancellation or parallel failure, cleanly terminates the entire child process tree spawned by that execution across both POSIX and Windows.

No runtime path is tied to the package installation directory—every caller simply supplies `rootDir`.

---

### Quick Start

Create an entry file in your project (for example, `task.tspp`):

```ts
import { command, defineTasks, runTaskCli } from "@tspp/task-kit";

const tasks = defineTasks({
  check: {
    description: "Check the project",
    dependencies: ["check:type", "check:test"],
    dependencyMode: "parallel",
  },
  "check:type": {
    description: "Check TypeScript types",
    run: command("tsc", "--noEmit"),
    public: false,
  },
  "check:test": {
    description: "Run tests",
    run: command("node", "--test"),
    forwardArgs: true,
  },
});

runTaskCli(tasks, { rootDir: process.cwd() }).then(code => {
  process.exitCode = code;
});
```

Launch it with your project's runtime, such as `tspp task.tspp`:

```bash
tspp task.tspp                         # Search and pick public tasks interactively
tspp task.tspp --list                  # List public tasks
tspp task.tspp --list-all              # List all tasks, including internal ones
tspp task.tspp check --dry-run         # Static preview (no env loading or preparation)
tspp task.tspp check --prepare-only    # Run preparation and print final commands without executing
tspp task.tspp check --env .env.local  # Override the env file for this run
tspp task.tspp check:test -- --watch   # Forward arguments after `--` to the root task
```

---

### Interactive Task Selector

Running the CLI without a task name opens an interactive selector:

- **Navigation**: Filter as you type, move with arrow/page keys, view task details, confirm with `Enter`, and cancel with `Esc` or `Ctrl-C`.
- **Smart Search**: Matches and ranks exact names, prefixes, substrings, punctuation-free names, segment initials, subsequences, descriptions, and multi-keyword queries. The most recently selected task is prioritized.
- **Selection Cache**: Defaults to `<rootDir>/node_modules/.cache/task-kit/selection.json` (override with `cacheFile`). Missing, corrupt, or unwritable cache files never block execution.
- **Non-interactive & Custom UI**: Non-interactive sessions require an explicit task name. Pass `selectTask` to plug in your own selector UI.

---

### Defining Tasks

Each task in `defineTasks` accepts the following fields:

| Field | Purpose |
| --- | --- |
| `description`, `details` | Short summary and full description shown in the interactive selector |
| `dependencies`, `dependencyMode` | Dependency names and execution mode: `serial` (default) or `parallel` |
| `run` | `command(program, ...args)` or an array of commands; commands within one task always run serially |
| `envFile`, `env` | Environment file path and variable overrides, inherited by dependencies |
| `cwd` | Working directory relative to `rootDir` (defaults to `.`) |
| `forwardArgs` | Allow the root task to receive arguments passed after `--` |
| `prepare` | Sync or async hook run before any command starts; returns `{ args }` |
| `inheritStdin` | Inherit terminal stdin during command execution (disabled by default) |
| `requireEnvFile` | Require an env file from the task, an ancestor, or explicit options during actual preparation/execution |
| `public` | Set to `false` to hide the task from lists and search (still runnable explicitly or as a dependency) |

#### Preparation (`prepare`) & Argument Forwarding

- `prepare(context)` may be synchronous or asynchronous and receives frozen `{ taskName, isRoot, args, env, cwd, signal }`.
- Preparation visits the root task first, then traverses dependencies in declaration/depth-first order, running once per shared task.
- Missing dependencies and cycles anywhere in the task table—as well as environment conflicts in the reachable graph—fail before any preparer runs. If preparation fails, no commands are started.
- When `forwardArgs` is enabled on the root task, forwarded CLI arguments are appended only to the **root task's last command**. Dependency preparers do not receive root arguments, though their own `prepare` hooks can return `args` that append to that dependency's last command.

---

### Programmatic API & Execution Plans

You can also drive tasks directly from code:

- **One-step execution**: `runTasks(tasks, name, options)` prepares and runs the task graph, returning a frozen `TaskPlan`.
- **Inspect then execute**: Call `prepareTasks(tasks, name, options)`, inspect the output of `formatPlan(plan)`, and then run `executePlan(plan, options)`.

Plans copy and freeze commands, arguments, dependencies, and resolved environments. Execution never reloads task definitions or files, keeping execution state separate so a prepared plan can be run repeatedly.

- **Shared Dependency Deduplication**: A dependency shared across branches runs once per execution when inherited environments match; conflicting environments fail early before preparation.
- **Static Preview (`dryRun`)**: Setting `dryRun: true` produces a static plan with `prepared: false`, which `executePlan` rejects.

#### Common `TaskOptions`

- `rootDir` (required): Project root directory.
- `envFile`, `env`: Explicit env file path, or base environment object replacing inherited `process.env`.
- `args`: Arguments forwarded to the root task.
- `dryRun`, `prepareOnly`: Preview static plan or stop after preparation.
- `signal`: `AbortSignal` for external cancellation.
- `logger`: Custom logger implementation.
- `gracefulTimeoutMs`: Grace period before force-killing child processes (defaults to `10000`).

---

### Environment Files & Custom Loaders

#### Precedence & Dotenv Features

1. An explicit `options.envFile` replaces per-task `envFile` settings across the graph.
2. Values loaded from an env file override inherited `options.env` / `process.env` values.
3. Per-task `env` overrides apply last.
4. Loading an env file also sets `ENV_FILE_PATH` and `PROJECT_ROOT_DIR`.

The default dotenv reader supports empty values, quotes, multiline strings, comments, and recursive `${NAME}` interpolation. Undefined references and cycles fail immediately.

#### Encrypted Environment Files

Provide a custom `loadEnvFile` loader to decrypt project-specific files into dotenv plaintext or a string map:

```ts
runTasks(tasks, "check", {
  rootDir: process.cwd(),
  envFile: ".env.encrypted",
  loadEnvFile: async ({ rootDir, filePath, env, signal }) => {
    // Call your project's decryptor; return dotenv plaintext or a string-variable map.
    return { API_URL: "https://example.test", MODE: "check" };
  },
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
```

---

### Process Lifecycle & Exit Codes

- **Isolated Process-Tree Cleanup**: Each execution tracks its own child processes independently. On cancellation or parallel dependency failure, it stops launching new commands, terminates its process tree, and settles started tasks before returning.
  - **POSIX**: Uses separate process groups.
  - **Windows**: Uses `cross-spawn` for `PATH`, command shims, and quoting, plus `taskkill /T` and a CIM query to catch descendants whose parents have already exited. Remaining processes are force-killed after `gracefulTimeoutMs`. Terminal signal behavior and graceful `taskkill` termination on Windows depend on the target program and Windows itself.
- **CLI Signal Handling**: The CLI handles `SIGINT` and `SIGTERM`, escalating immediately on a second signal. It removes its own signal listeners upon completion and never calls `process.exit`.

| Exit Code | Meaning |
| --- | --- |
| `0` | Success, help/list output, or interactive selection cancelled |
| `1` | Task execution failure |
| `2` | Invalid CLI arguments |
| `130` | Terminated by `SIGINT` |
| `143` | Terminated by `SIGTERM` |

---

### Implementation Notes (TS++)

- Nominal `EnvironmentId` (`newtype`) isolates environment identities.
- `data class` represents immutable prepared value objects.
- Algebraic `RunMode` with exhaustive `match` models execution modes.
- `PlanOutput` algebraic effect requests output capabilities from callers.
- Mutable runtime state is kept separate from immutable plans for repeatable executions.

---

### Development

Run inside this package directory:

```bash
pnpm build       # Compile CommonJS output and .d.ts / .d.tspp declarations
pnpm check       # Type-check sources without emitting files
pnpm test        # Build and run node:test behavior tests
pnpm test:run    # Run tests against the current build
```
