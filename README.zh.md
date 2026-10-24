# ts-plus-plus

[English](README.md) | **简体中文**

> [#](https://github.com/tspp-lang/tspp/issues/2) 中的设计提案仅用于演示，并非计划，也不是 TODO，更不构成承诺。可以把它看作一种可能方向的预览，而非路线图。

ts-plus-plus 是一门派生自 TypeScript 的实验性语言。它支持了许多强大的类型特性，扩展了 TypeScript 的类型系统能力边界，同时也在值层设计了现代语言特性。

TS++ 以 [TypeScript 6.0.3 的 `050880ce` 源码快照](https://github.com/microsoft/TypeScript/commit/050880ce59e30b356b686bd3144efe24f875ebc8)为起点。该上游快照在本仓库中保留为根提交 [`824eb723`](https://github.com/tspp-lang/tspp/commit/824eb7234d96fd5c538bdf693789399e6c758235)，并标记为 `v0.0.0`；其后的提交均属于 TS++ 自身的开发历史。

<!-- markdownlint-disable -->

<div align="center">
<img width="180px" src="./packages/vscode-extension/tspp.svg" />
</div>

<!-- markdownlint-enable -->

所有扩展都需要在 `tsppconfig.json` 中逐项手工开启。没有 `tsppconfig.json` 时，全部 TS++ 特性关闭，编译器行为与 TypeScript 一致；`.tspp` 和 `.d.tspp` 文件也不会参与项目发现或模块解析。

## Monorepo 结构

仓库根目录负责统一编排 monorepo，各产品包均位于 `packages/`：

- `compiler`：`ts-plus-plus` 编译器、语言服务、构建系统和测试套件；
- `language-server`：TS++ 的 Language Server Protocol 实现；
- `vscode-extension`：仓库内使用的 VS Code 开发扩展；
- `examples`：编译器和编辑器示例；
- `playground`：浏览器游乐场及其 TypeScript Playground 上游基线。

在根目录运行 `npm ci` 可安装编译器和 npm workspaces 的依赖。语言服务器保留上游的 pnpm 锁文件，`npm run build:language-server` 会负责调用它；游乐场保留自己的应用锁文件，可用 `npm --prefix packages/playground ci` 安装。运行 `npm run build:all` 可构建编译器、语言服务器、测试和游乐场。

## 贡献者

<!-- markdownlint-disable -->

<a href="https://github.com/tspp-lang/tspp/graphs/contributors">
  <img src="assets/contributors.svg" alt="Contributors" />
</a>

<!-- markdownlint-enable -->

## 初始化项目

```sh
tspp --init
```

如果当前目录没有 `tsconfig.json`，命令会先生成一份；随后生成以 `"extends": "./tsconfig.json"` 继承它的 `tsppconfig.json`，且不会修改已有的 TypeScript 配置。生成文件的注释头会记录编译器提交哈希，并动态列出当前版本的全部特性，默认全部关闭。

特性需要手工开启：

```jsonc
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "tsppFeatures": [
      "higherKindedTypes",
      "nominalTypes",
      "macros",
      "formalContracts",
      "refinementTypes",
      "typeUniverses"
    ]
  }
}
```

依赖项也必须显式列出。未知特性、重复特性或缺少依赖都会成为配置错误：编译器拒绝启动编译，不修改配置，也不会容错降级运行。源码使用了尚未开启的特性时，编辑器可以通过快速修复把该特性及其完整依赖链加入 `tsppconfig.json`。

## TypeScript 互操作

TS++ 把 TypeScript 作为稳定的兼容层与 FFI 边界：

- TS++ 编译器可以编译 `.ts`、`.js` 和 `.tspp`。`.tspp` 源文件可以引用 TypeScript/JavaScript 源码，也可以在明确增强边界值类型时使用普通 TypeScript 类型断言。
- `.ts` 或 `.js` 源文件不能引用 `.tspp` 或 `.d.tspp` 源文件，但仍可通过编译后的 JavaScript 和 `.d.ts` 兼容面使用 TS++ 包。
- `.ts` 的声明输出仍为 `.d.ts`；`.tspp` 会同时输出完整的 `.d.tspp` 和供 TypeScript 使用的 `.d.ts` 兼容投影。
- TS++ 包消费者优先读取 `package.json#tsppTypes` 和 `exports` 中的 `tspp-types` 条件；TypeScript 消费者继续读取标准的 `types` 字段和 `types` 条件。

条件导出键的顺序会影响匹配结果，因此应当像下面这样把 `tspp-types` 放在 `types` 之前。

```json
{
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "tsppTypes": "./dist/index.d.tspp",
  "exports": {
    ".": {
      "tspp-types": "./dist/index.d.tspp",
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  }
}
```

兼容声明是保守投影，而不是简单改扩展名：`newtype` 会变成底层 TypeScript 类型与构造函数签名，`data` 会变成可辨识联合及变体声明，契约和仅供宏系统使用的声明会被省略；依赖函数保留可调用参数域但将结果降级为 `unknown`，TypeScript 无法表达的类型计算和高阶类型操作也会降级为 `unknown`。生成的 `.d.ts` 必须形成封闭依赖图，绝不能引用 `.d.tspp`。

混合源码库和原生 TypeScript 消费者示例见 [`packages/examples/07-typescript-interop`](./packages/examples/07-typescript-interop)。

## 特性可能带来的影响

每项特性只按两个彼此独立的维度评估：

- **是否保持 TypeScript 超集**：已有 TypeScript 的语法、类型检查和运行时行为保持兼容。
- **是否保持透明擦除**：只需删除类型语法，不生成或改变 JavaScript 运行时代码。

只有全部已开启特性都保持第一项时，当前配置下的语言才保持 TypeScript 超集；只有全部已开启特性都保持第二项时，才保持透明擦除。我们不再把声明文件保持情况单独作为一个维度记录。

当前特性如下：

| 特性 | 获得 | 必须显式开启的依赖 | TS 超集 | 透明擦除 |
| --- | --- | --- | --- | --- |
| `higherKindedTypes` | 高阶类型参数和一等类型构造器；种类注解（如 `F: Type => Type`）需要额外开启 `typeUniverses` | 无 | 是 | 是 |
| `nominalTypes` | `newtype` 名义类型声明、`data` ADT 可辨识联合、变体构造器与穷尽值层 `match` | 无 | 是 | 否（生成运行时变体值、构造器与匹配分派） |
| `macros` | `macro function` 声明与编译期 `macro f(Target);` 语句展开 | 无 | 是 | 否（宏调用可以替换生成的语句） |
| `formalContracts` | 由 SMT 求解器验证的 `requires`、`ensures` 和 `while` 循环不变式（输出标准 SMT-LIB 2.6，不依赖特定求解器） | 无 | 是 | 是 |
| `standardLibraryPredicates` | 标准库数值谓词 `isEven`、`isOdd`、`isPositive`、`isNegative`、`isNonNegative`、`isZero`、`divides`、`between`；`number` 需设置 `numberModel`（`"mathematical-real"` 或 `"safe-integer"`） | `formalContracts` | 是 | 是 |
| `refinementTypes` | 由 SMT 求解器验证结构类型别名引入点的谓词 | `formalContracts` | 是 | 是 |
| `typeComputation` | 类型层局部绑定 `let X = T in U`、模式匹配 `match T { ... }` 与类型 lambda `<T> =>> Body` | 无 | 是 | 是 |
| `modernSyntax` | 值层 `let ... in ...` 表达式、`do { ... }` 语句块表达式、`do` 函数/方法隐式返回，以及 `use pattern <- expr` 尾随回调解糖 | 无 | 是 | 否（生成运行时 IIFE、尾随闭包回调与显式 return） |
| `typeUniverses` | `Type0`、`Type1` 等类型宇宙与 kind 分层 | `higherKindedTypes` | 是 | 是 |
| `dependentFunctionTypes` | Pi 类型，以及显式的 `Lam`/`Ann` MLTT 项 | `typeUniverses` | 是 | 是 |
| `dependentFunctionInterop` | Pi 类型与 TypeScript 泛型函数之间的赋值和调用 | `dependentFunctionTypes` | 是 | 是 |
| `typeMatching` | 精确 `IfType`、有序 `TypeMatch`，以及按构造器身份解构泛型类型的分支局部 `infer` 捕获 | `dependentFunctionTypes` | 是 | 是 |
| `naturalNumbers` | `Nat`、`Zero`、`Succ` 类型级自然数 | `dependentFunctionTypes` | 是 | 是 |
| `naturalNumberAddition` | 可归约的 `NatAdd` 类型级加法 | `naturalNumbers` | 是 | 是 |
| `naturalNumberElimination` | `NatElim` 依赖消去器 | `naturalNumbers` | 是 | 是 |
| `booleans` | `Bool`、`True`、`False` 类型级布尔值 | `dependentFunctionTypes` | 是 | 是 |
| `booleanElimination` | `BoolElim` 依赖消去器与 `If` 依值分支 | `booleans` | 是 | 是 |
| `identityTypes` | `Eq`、`Refl`，以及 `J` 路径归纳 | `dependentFunctionTypes` | 是 | 是 |
| `sigmaTypes` | `Sigma`、`Pair`、`First`、`Second` 依赖对及投影 | `dependentFunctionTypes` | 是 | 是 |

自动生成的配置是与编译器版本对应的权威特性说明。本项目仍处于实验阶段；表中的结论描述当前实现，不是对未来新增特性的永久承诺。

## 验证架构

验证分为以下几层（设计讨论见 [issue #27](https://github.com/tspp-lang/tspp/issues/27)）：

1. **SMT IR**：与求解器无关的 SMT-LIB 2.6 模型，包括 sort（基本类型、datatype、未解释 sort）、开放的符号应用、带 pattern 的量词、`let`、声明与定义的函数，以及原始 SMT-LIB 逃生口。每个应用都会按标准理论签名（Core、Ints、Reals、Reals_Ints、Strings、Datatypes）或已声明函数做 sort 检查，不再维护封闭的运算符枚举。
2. **程序语义**：TypeScript/JavaScript 运算如何映射到 IR。每个运算降低为逻辑项**以及**其运行时行为所需的定义性证明义务：bigint `%` 是 JavaScript 的截断余数（`-3n % 2n === -1n`，在输出中是一个 `define-fun`，而不是 SMT 的 `mod`），并要求除数可证明非零。规格（`requires`、`ensures`、不变式、谓词、`assert:`/`assume:`）会被擦除、从不执行，因此它们是纯逻辑，不产生运行时义务。
3. **证明上下文**：每条断言都记录来源以及是否受信。`assume:`、公理和数值模型假设属于受信输入；`requires`、不变式和精化事实会在别处被证明。受信断言会被命名，证明成功时会根据求解器的 unsat core 报告该证明实际依赖的受信输入。
4. **后端**：生成的脚本只包含标准命令和理论符号，`set-logic` 根据实际使用的理论计算（`QF_LIA`、`QF_NIA`、`UFDTLIA` 等，否则为 `ALL`）。求解过程是纯 SMT-LIB 协议（`check-sat`、`get-value`、`get-unsat-core`、`get-info :reason-unknown`）；超时等求解器选项属于后端适配器，不会出现在脚本中。内置后端为 Z3，宿主可以接入任意 SMT-LIB 2.6 求解器。

TypeScript 自身的控制流分析仍作为事实来源被复用，而不是被替换。宏与验证共享有界分析 worker 队列，能够传播取消和超时结果，并在增量 Program 之间复用按完整义务内容寻址的成功结果。

MLTT Core 继续保留自己的项、归约和定义相等性。将来若加入 MLTT 精化，应只通过适配器把其中可判定的算术/相等片段降低到 Verification IR，而不把 MLTT Core 与 SMT 表示合并。

## 形式化契约

开启 `formalContracts` 后，可以给函数附加契约，并给 `while` 附加循环不变式：

```ts
function sumTo(n: bigint) with {
  requires: n >= 0n;
  ensures: result === n;
}: bigint {
  let current = 0n;
  while (current < n) with {
    invariant: [current >= 0n, current <= n];
  } {
    current += 1n;
  }
  return current;
}
```

每个 `with` 属性名只能出现一次；`requires`、`ensures` 或 `invariant` 包含多个条件时使用数组。

当前子集支持 `boolean`、`bigint`、`string`、局部变量、赋值、分支、`switch`、多返回路径、带不变式的循环，以及对能够静态解析到项目函数声明的直接调用检查 `requires`。记录与记录字面量、带唯一字符串 `_tag` 的封闭判别联合、TS++ `data` 构造器和递归代数数据会通过 TypeScript checker 已经计算出的类型与控制流窄化降低为 Verification IR 的积类型/和类型，再编码为 SMT-LIB datatype；验证器不会并行实现另一套 TypeScript 类型窄化。可选字段、索引签名和开放联合目前会明确得到 `unknown`。验证函数内部调用时，调用者前提与当前符号路径事实也会参与证明。支持的算术为 `+`、`-`、`*`，以及 `bigint` 上按 JavaScript 截断语义的 `/` 和 `%`。只有在契约中选择 `numberModel` 后才支持 `number`：

- `"mathematical-real"`：把 `number` 抽象成数学实数，不建模舍入、溢出、NaN、Infinity 与 -0，因此它是一条受信假设，所有依赖它的证明都会报告这一点。
- `"safe-integer"`：把 `number` 建模为 ±`Number.MAX_SAFE_INTEGER` 范围内的整数，此时 IEEE-754 运算是精确的。执行代码中的每个 `+`、`-`、`*` 都必须可证明不越界，number `%` 需要非零除数；`/`（不是整数除法）与小数字面量不在模型内。只有参数的范围是受信输入。

每个证明义务都会得到 `proved`、`failed`、`unknown` 或 `error` 状态，任务结果还会区分取消与超时。不支持的语法以及求解器不可用都会产生 `unknown` 编译错误，绝不会伪装成证明成功。`Program.getVerificationArtifacts()` 会公开实际求解器输入、可重放的 SMT-LIB、状态、解码后的源码级反例、原始模型、证明所依赖的受信输入和源码位置。SMT-LIB 中每条断言都带有标注其类别与来源的注释，库定义也会注明出处。开发扩展中的 **TS++: Show Verification SMT-LIB** 命令会在源码旁一次打开当前文件的全部输入，按源码位置排序并标注对应行号。

可以在被验证函数中使用 `assert: condition;` 创建局部证明义务。`assume: condition;` 则不进行证明，直接把可信条件加入后续路径事实；它适合验证器无法建模的外部边界，但错误假设会使证明失去意义。依赖了假设的证明会在消息和 `trustedInputs` 中说明这一点。`assert:`/`assume:` 语句形式保留给证明指令，因此用户自定义的 `assert` 或 `assume` 函数在任何位置都保持普通调用语义。两者都会从 JavaScript 输出中擦除。在开发扩展中悬停于证明义务上，可以直接看到状态与源码级反例。

## 穷尽值匹配

`nominalTypes` 同时启用针对 `data` 值及兼容的封闭 `_tag` 联合的表达式级匹配：

```ts
data Result<T> = Ok(value: T) | Err(error: string);
declare const result: Result<string>;

const text = match result {
  Ok(value) if value.length > 0 => `value: ${value}`,
  Ok(_) => "empty",
  Err(error) => error,
};
```

构造器字段按位置绑定。分支可以在模式后添加 `if` guard；带 guard 的分支不会单独形成穷尽覆盖，因此后续分支仍可处理该变体的剩余取值。重复、未知、不可达以及缺失的变体都会产生诊断；最终分支可以使用 `_` 兜底。被匹配表达式只会求值一次，编辑器还能通过快速修复补齐全部缺失变体。

无字段变体可以通过 or-pattern 共用分支，例如 `Idle | Loading => wait()`。构造器模式支持嵌套，例如 `Wrapped(Ok(value)) => value`；嵌套绑定会保留准确的字段类型，嵌套分支会参与穷尽性检查，而 guard 仍需无 guard 的后备分支。嵌套的无字段构造器写作带括号的形式（`Wrapped(None())`），以便与字段绑定区分。

## 类型层计算：let-in、match 与类型 lambda

开启 `typeComputation` 后，可以使用局部类型绑定、模式匹配与匿名类型层函数：

```typescript
// 1. 局部 let-in 作用域绑定
type UserResponse<T> = let Payload = { data: T; timestamp: number } in {
  response: Payload;
  backup: Payload;
};

// 2. 类型层 match 模式匹配（支持结构解构 infer、ADT 构造器、基元与字面量）
type Classify<T> = match T {
  [infer Head, ...infer Tail]: { head: Head; tail: Tail },
  Array<infer U>: [U, "array"],
  1: "one",
  string: "is-string",
  _: "other"
};

// 3. 匿名类型 lambda（<T> =>> Body）
type Id = <T> =>> T;
type Swap = <A, B> =>> [B, A];

type Swapped = Swap<string, number>; // [number, string]
```

类型 lambda 与高阶类型参数互通。`<T> =>> Body` 的 kind 为 `Type => Type`，可以传递给任何接受类型构造器的位置：

```typescript
// 需要同时开启 typeComputation + higherKindedTypes。
type Apply<F: Type => Type, X> = F<X>;

type Doubled = Apply<<T> =>> [T, T], boolean>; // [boolean, boolean]
```

lambda 体可以引用任何在作用域内的类型。所有类型计算语法本身会像其他所有 TS++ 类型语法一样被擦除，不产生任何 JavaScript 输出。

在类型别名或类型表达式上悬停，会直接显示归约后的正规形与 kind。

## 现代值层语法：let-in、do 表达式与 do 函数

开启 `modernSyntax` 后，可以使用现代值层函数式表达式与隐式返回函数：

```typescript
// 1. 值层 let-in 局部变量绑定表达式
const sum = let x = 10, y = 20 in x + y;

// 2. do { ... } 语句块表达式（尾部表达式隐式返回为完成值）
const user = do {
  const firstName = "Alan";
  const lastName = "Turing";
  `${firstName} ${lastName}`;
};

// 3. do 函数与 do 类方法隐式返回
function computeDiscount(price: number, isVip: boolean): number do {
  const rate = isVip ? 0.8 : 0.95;
  price * rate;
}

class Calculator {
  public total(price: number): number do {
    computeDiscount(price, true) + 15;
  }
}

// 4. do 块与 do 函数内的 use pattern <- expr 尾随闭包解糖
function runPipeline(): string do {
  use token <- withAuth("admin");
  use [code, status] <- withPair();
  use res <- withResource();
  `${res.name}: [${code}] ${status} for ${token}`;
}

// 5. 普通 TS 函数保持 100% 行为隔离
function standard(): void {
  42; // 纯表达式语句，绝不会隐式返回
}
```

值层 `let-in` 和 `do` 表达式会被降级为自执行箭头函数（`(() => { ... })()`），`do` 函数/方法体内的末尾表达式自动转换为 `return expr;`，`use pattern <- f(args); rest...` 会被脱糖转换为尾随闭包调用 `f(args, (pattern) => { rest... })`。

## 协议

Apache 许可证 2.0。ts-plus-plus 派生自 Microsoft 的 TypeScript；原始许可证、版权声明和 NOTICE 保持不变，修改过的文件将被标记为已修改。“TypeScript”是 Microsoft Corporation 的商标。
