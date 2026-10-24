# 04 — 编译期宏入门

宏是在编译期间执行的函数。它拿到的不是运行时数据，而是编译器已经解析好的声明，
因此可以完成两类工作：

1. **检查 AST**：读取目标代码，不符合规则时产生编译错误；
2. **替换 AST**：返回新的 TypeScript 语句，替换调用宏的位置。

本示例按能力拆成四个互相独立的文件：

- [`01-check.tspp`](./src/01-check.tspp)：检查函数中是否包含 `return`；
- [`02-transform.tspp`](./src/02-transform.tspp)：根据接口名称生成一个常量；
- [`03-async.tspp`](./src/03-async.tspp)：等待 Promise 后返回生成的 AST；
- [`04-security-boundary.tspp`](./src/04-security-boundary.tspp)：展示 Node.js 权限和超时边界。

每个文件都把目标声明、宏实现和宏调用放在一起，可以从上到下直接阅读。实际项目中，
宏当然也可以导出到其他文件，再像普通函数一样 `import` 后使用。

编译器不会为了取得宏函数而执行宏所在文件的全部顶层代码。它会从 `macro function`
出发，按符号引用收集宏实际依赖的本地声明、具名 import 和副作用 import，再生成独立的宏
执行模块。普通应用语句（例如日志、启动服务或写文件）不会仅仅因为同文件定义了宏就在
编译期执行。宏显式导入的 `.ts`/`.tspp` helper 则会通过编译器的内存模块加载器执行，语义
与普通 CommonJS 依赖一致。

## 先看最小用法

宏包含“定义”和“调用”两个部分：

```ts
export macro function check(
  targets: readonly macros.MacroTarget[],
  context: macros.MacroContext,
): macros.MacroReturn {
  // 在编译期检查 targets，或者返回新的 AST
}

macro check(SomeDeclaration);
```

`macro function` 定义宏实现；`macro check(...);` 明确要求编译器执行它。只定义或导入宏
不会触发执行。

宏调用目前是一条独立语句。参数是能解析到声明的名称，例如函数、接口或类，而不是
运行时传给普通函数的值。

## 能力一：检查 AST

[`01-check.tspp`](./src/01-check.tspp) 定义了 `requireReturnStatement`，用来要求目标函数
必须直接包含一条 `return` 语句：

```ts
export function readAnswer(): number {
  return 42;
}

macro requireReturnStatement(readAnswer);
```

宏首先确认调用者只传了一个目标，而且目标确实是函数声明：

```ts
if (targets.length !== 1) {
  return context.fail(`expected 1 target, received ${targets.length}`);
}

const target = targets[0];
if (!macros.isFunctionDeclaration(target.node)) {
  return context.fail(`${target.name} must be a function declaration`);
}
```

然后直接读取函数声明的 AST：

```ts
const hasReturn = target.node.body?.statements.some(macros.isReturnStatement) ?? false;
```

- 检查成功时返回 `undefined`，表示不插入任何代码；
- 检查失败时返回 `context.fail(message)`，错误会出现在宏调用位置。

成功的宏调用只在编译期有意义，不会进入最终 JavaScript。文件末尾提供了一个注释掉的
失败案例，取消注释后运行 `pnpm check` 即可观察诊断。

## 能力二：替换 AST

[`02-transform.tspp`](./src/02-transform.tspp) 中的 `exposeTypeName` 接收一个声明：

```ts
macro exposeTypeName(User);
```

它通过 `context.factory` 创建一条 `VariableStatement`。以上调用在概念上会被替换为：

```ts
export const UserTypeName: "User" = "User";
```

这里返回的是 TypeScript AST，不是拼接出来的源码字符串。创建过程从内到外对应源码的
结构：

```text
字符串字面量 "User"
        ↓
变量声明 UserTypeName: "User" = "User"
        ↓
const 声明列表
        ↓
带 export 的变量语句
```

生成的语句会继续参与同一次编译，所以后面的代码能立即使用它：

```ts
const checkedName: "User" = UserTypeName;
```

它也会正常进入 JavaScript 和 `.d.tspp` 输出，而原来的 `macro exposeTypeName(User);`
不会保留到运行时。

## 在 IDE 中查看展开结果

使用仓库自带的 VS Code development extension 打开 `.tspp` 文件后，可以直接检查
每一条宏调用：

- 将鼠标悬浮在 `macro exposeTypeName(User);` 上，会显示这一条调用格式化后的
  TypeScript 展开结果；
- 点击编辑器右上角的预览按钮，会在旁侧打开只读的 `*.expanded.tspp`，展示当前文件
  完成全部宏替换后的最终源码；
- 对只进行检查、不返回 AST 的宏，悬浮窗会说明它不生成语句；在最终源码预览中，
  这类调用会被擦除。

悬浮窗和只读预览都不会修改源文件。修改编译器或 development extension 后，需要
重新执行 `pnpm build:compiler` 并重载 Extension Development Host。

## 异步宏

宏函数可以返回 `Promise<MacroResult>`。一次性命令行编译、悬浮预览和只读展开窗口会
等待 Promise 完成：

```ts
export async macro function exposeTypeNameLater(
  [target]: readonly macros.MacroTarget[],
  context: macros.MacroContext,
) with {
  timeout: { type: "benchmark", multiplier: 100 };
}: Promise<macros.MacroResult> {
  await new Promise<void>(resolve => setTimeout(resolve, 10));
  return context.factory.createVariableStatement(/* ... */);
}
```

TypeScript Language Service 会先返回当前同步结果，在 Promise 完成后自动重建 Program 并
请求编辑器刷新诊断。因此生成的声明会在短暂等待后参与补全、悬浮和正式类型检查；扩展
提供的宏悬浮与最终源码预览则会直接等待完整展开结果。

没有显式配置时，每个 Promise 宏最多等待 **10 秒**。宏声明可以通过结构化的
`with { ... }` 块声明预算，所有调用共享该配置：

```ts
macro function fetchSchema(targets, context) with {
  timeout: { type: "fixed", value: 500, unit: "ms" };
}: Promise<macros.MacroResult> {
  // ...
}

macro function generateBindings(targets, context) with {
  timeout: { type: "fixed", value: 2, unit: "s" };
}: Promise<macros.MacroResult> {
  // ...
}

macro function analyzeProject(targets, context) with {
  timeout: { type: "benchmark", multiplier: 100 };
}: Promise<macros.MacroResult> {
  // ...
}

macro analyzeProject(Project);
```

`fixed` 是固定墙钟时间，适合网络协议、外部工具等具有明确时间上限的任务。
`benchmark` 是机器相对预算：编译器首次需要它时运行一次固定的整数运算基准，缓存本机
耗时，再乘以 `multiplier`。这样 CPU 密集型宏在快慢机器上能获得相近的相对工作量。超过
最终预算后，编译器会在对应的 `macro` 调用处报告实际毫秒数和预算来源。

`with` 是函数声明上的通用 AST 语法，也允许写成 `function defaults() with {}: void {}`。
第一版只有宏函数定义了 `timeout` 属性；普通函数暂时没有可用属性。属性名会按照函数
种类检查，不接受未预定义的键。`timeout` 最多声明一次，数值必须是有限正数；固定预算
换算成毫秒后不能超过 `2147483647`。固定预算使用
`{ type: "fixed", value, unit: "ms" | "s" }`，机器相对预算使用
`{ type: "benchmark", multiplier }`。两者组成标准的判别联合，不引入非 TypeScript 的数字
后缀语法，也便于 IDE 根据 `type` 提供属性提示。重复、未知或无效的配置都会在对应属性上
报错，宏不会执行。

声明没有写 `with` 时使用默认配置，编译器不会在 `.d.tspp` 中补出默认值；源声明显式写了
`with` 时则会保留到 `.d.tspp`，让依赖包导出的宏继续携带执行策略。JavaScript 输出
会擦除 `with`，它不会成为运行时代码。

目前 watch、incremental 和 solution build 仍走同步 builder 流程，尚不执行异步宏。

## 权限与安全边界

AST 宏不是权限沙箱。一次性异步编译和 development extension 会在独立 Node.js worker
中重建编译程序并运行宏，所以同步死循环、内存耗尽或 `process.exit()` 不会直接终止编译器
主线程。worker 仍以当前用户身份运行，因此宏
可以执行普通 Node.js 代码，包括：

- 读取和写入当前用户有权访问的文件；
- 读取环境变量、加载本地模块和原生模块；
- 发起网络请求或启动子进程；
- 修改进程级状态，或者让构建结果依赖时间、机器和网络环境。

[`04-security-boundary.tspp`](./src/04-security-boundary.tspp) 安全地读取了示例自己的
`package.json`，再把包名写入生成的 AST。这证明宏拥有真实的 Node.js 模块访问能力，
但示例不会写文件或访问网络。

因此只应执行代码仓库或可信依赖提供的宏。安装一个包含宏的 npm 包，本质上也意味着在
编译时授权它以编译器进程的权限执行代码。CI 中应锁定依赖版本，并尽量让宏保持纯函数：
相同源码和配置始终产生相同结果。为了提供展开预览和宏执行诊断，development extension
会在打开或编辑 `.tspp` 文件时自动求值其中的宏；不要用它打开包含不可信宏实现的项目。

每条宏调用的预算同时约束同步执行和 **Promise 的等待时间**。超过预算后，编译器会先让
worker 内的 Promise 超时逻辑生成精确诊断；对于同步死循环或阻塞 I/O，主线程会强制终止
worker。worker 还设置了旧生代内存上限。不过这只是进程稳定性隔离，并不会阻止宏读写文件、
访问网络或启动子进程，因此仍然只能运行可信宏。

直接调用同步 `createProgram` 以及当前的 watch、incremental、solution build 路径仍在编译器
线程中执行同步宏；这些入口完成异步调度改造前，不具备上述 worker 强制终止能力。

## 公共宏 SDK：`ts-plus-plus/macros`

宏只需要从 `ts-plus-plus/macros` 导入：

```ts
import * as macros from "ts-plus-plus/macros";
```

编译期执行宏时，这个模块由正在运行的编译器自己提供，因此宏总是与加载它的编译器版本一致，
在 Node 和浏览器宿主（Playground）中行为相同。它分为两层：

| 层级 | 内容 | 承诺 |
| --- | --- | --- |
| 稳定 API | `MacroTarget`、`MacroContext`、`MacroResult`、`MacroReturn`、`MacroFailure`、`MacroDiagnostic`、`MacroFunction`、`MacroTimeout`；常用 AST 节点类型与类型守卫（`isFunctionDeclaration`、`isReturnStatement`、`isDataDeclaration` 等）；`SyntaxKind`、`NodeFlags`、`DiagnosticCategory`、`forEachChild`、`idText` | 删除或改变其中任何一项都需要提升 `macroApiVersion`（当前为 `1`） |
| 节点创建 | `context.factory` 是唯一推荐的 AST 创建入口 | 节点形状跟随编译器 AST（与 TypeScript AST 一致） |
| 同版本耦合 | `context.program`、`context.checker`，以及 `import * as ts from "ts-plus-plus"` 暴露的完整编译器 | 只读、能力强，但随编译器内部演进，不做兼容性承诺 |

需要稳定性时只使用前两层；确实需要类型信息时再使用 `context.checker`，并接受它与编译器版本耦合。

## 两个参数分别是什么

### `targets`

`targets` 对应宏调用括号中的声明。每个 `MacroTarget` 常用的属性有：

| 属性 | 含义 |
| --- | --- |
| `name` | 调用处使用的目标名称 |
| `node` | 目标的主要声明节点 |
| `symbol` | checker 中对应的符号 |
| `declarations` | 同一符号关联的全部声明 |
| `sourceFile` | 声明所在的源码文件 |

检查宏通常读取 `node` 或配合 checker 分析类型；生成宏经常使用 `name` 决定新声明的
名称。

### `context`

本示例使用了两个最重要的入口：

| 入口 | 用途 |
| --- | --- |
| `context.fail(message)` | 在宏调用处产生编译错误 |
| `context.factory` | 创建正式的 TypeScript AST 节点 |

需要类型信息时还可以使用 `context.checker`。`context` 也提供当前 `program`、
`sourceFile` 和 `macroInvocation`。

## 宏可以返回什么

| 返回值 | 结果 |
| --- | --- |
| `undefined` | 调用被擦除，不插入代码 |
| `Statement` | 用一条语句替换调用 |
| `Statement[]` | 用多条语句替换调用 |
| `MacroFailure` | 报告编译错误，不生成代码 |
| `Promise<MacroResult>` | 等待完成后按以上规则处理结果 |

## 递归展开

[`05-recursive-expansion.tspp`](./src/05-recursive-expansion.tspp) 展示宏返回另一条宏调用：

```text
beginRecursiveExpansion
  -> continueRecursiveExpansion
  -> finishRecursiveExpansion
  -> export const RecursiveUserExpandedName = "RecursiveUser"
```

一次性异步编译会继续展开返回结果中的顶层宏调用，直到只剩普通语句。为避免宏直接或间接
返回自身造成无限递归，单条展开链最多执行 32 层；超过后会在最初的宏调用位置报告诊断。

## 运行示例

先在仓库根目录构建 compiler：

```powershell
pnpm build:compiler
```

然后进入本目录：

```powershell
cd packages/examples/04-macros
pnpm check
pnpm build
pnpm start
```

`pnpm start` 的预期输出为：

```text
User
AsyncUser
tspp-example-04-macros
RecursiveUser
```

构建后可以对照查看：

- `dist/01-check.js`：保留普通函数，但没有宏调用；
- `dist/02-transform.js`：包含生成的 `UserTypeName`；
- `dist/02-transform.d.tspp`：包含生成的公开声明；
- `dist/03-async.js`：包含 Promise 完成后生成的 `AsyncUserAsyncName`。
- `dist/04-security-boundary.js`：包含从 `package.json` 读取并固化的包名。
- `dist/05-recursive-expansion.js`：三阶段宏调用已经递归展开为最终常量。

## 当前边界

- 宏调用必须是独立语句：`macro fn(Target1, Target2);`；
- 目标必须是可解析为声明的标识符或属性访问；
- 一次性 CLI、Language Service 和 IDE 展开预览支持 Promise；watch、incremental 和
  solution build 暂时仍是同步流程；
- Promise 宏默认等待上限是 10 秒，也可在声明上选择固定时间或本机基准倍率；同步阻塞
  代码无法被同进程超时机制抢占；
- 一次性异步编译会递归展开宏返回的顶层宏调用，最大深度为 32；
- 宏没有沙箱，拥有编译器进程的 Node.js 权限，应只使用可信实现并保持构建结果可重复。
