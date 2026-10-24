# 05 — 形式化契约与循环不变式

这个示例按文件分别展示 `formalContracts`、`refinementTypes` 和 `smtLibraries`：

- [`01-function-contracts.tspp`](./src/01-function-contracts.tspp)：`requires`、`ensures`、隐式返回值 `result` 和多返回路径；
- [`02-loop-invariants.tspp`](./src/02-loop-invariants.tspp)：循环不变式的初始化与保持性证明；
- [`03-number-model.tspp`](./src/03-number-model.tspp)：显式选择数学实数模型后验证 `number`；
- [`04-refinement-types.tspp`](./src/04-refinement-types.tspp)：精化类型的引入、控制流证明和谓词传播；
- [`05-refined-newtype.tspp`](./src/05-refined-newtype.tspp)：在 `newtype` 构造入口应用 `with` 谓词约束。
- [`06-sum-types.tspp`](./src/06-sum-types.tspp)：把 `data` 和封闭判别联合降低为 SMT 和类型，并复用 TypeScript 的控制流窄化。
- [`07-recursive-data.tspp`](./src/07-recursive-data.tspp)：递归 `data`、variant 构造器和由 checker 窄化的 `switch`。
- [`09-local-proof-points.tspp`](./src/09-local-proof-points.tspp)：局部 `assert` 证明义务，以及显式可信但不生成证明义务的 `assume`。
- [`10-program-semantics.tspp`](./src/10-program-semantics.tspp)：bigint `/` 与 `%` 的 JavaScript 截断语义、除数非零的定义性证明义务，以及“规格是纯逻辑”的约定。
- [`11-safe-integer-model.tspp`](./src/11-safe-integer-model.tspp)：`numberModel: "safe-integer"` 下的 `number` 循环与取余，以及越界检查。
- [`12-logic-libraries.tspp`](./src/12-logic-libraries.tspp)：用 `ts-plus-plus/smt` 定义逻辑函数（谓词、量词、递归函数），并在契约中调用（需开启 `smtLibraries`）。

`divides(a, b)` 表示 `a` 整除 `b`；`between(value, lower, upper)` 是闭区间判断，即 `lower <= value <= upper`。

## 积类型、和类型与 TypeScript 控制流

验证器直接读取 TypeScript checker 在当前位置已经得到的窄化类型。带唯一字符串 `_tag` 的封闭判别联合和 TS++ `data` 声明会降低为 Verification IR 和类型，再编码为 SMT-LIB datatype；variant 字段只能在 checker 已经确认对应分支后读取。验证层维护的符号状态只记录 SMT 值和证明事实，不重新实现 TypeScript 的结构兼容或控制流窄化。

记录字面量、variant 构造器以及递归代数数据会直接编码成 SMT-LIB datatype 构造项。可选字段、索引签名和开放联合仍会得到明确的 `unknown`，不会通过删除无法编码的部分来伪装成证明成功。`switch (value._tag)` 的分支事实来自 checker 在对应 case 中已经完成的窄化。

## 函数契约

契约写在参数列表之后、返回类型之前：

```ts
function successor(value: bigint) with {
  requires: value >= 0n;
  ensures: result > value;
}: bigint {
  return value + 1n;
}
```

`requires` 是证明函数实现时采用的前提；`ensures` 必须在每一条显式返回路径上成立。
`ensures` 中的 `result` 表示当前路径实际返回的值。能够静态解析到项目函数声明的直接调用也会验证
`requires`，例如 `successor(-5n)` 会在调用位置报告反例 `value = -5`。验证函数内部的调用时，
调用者的 `requires` 和当前符号路径事实也会参与证明。

直接调用的返回值会使用被调函数的 `ensures`：例如 `ensures: result === x * 2n` 的 `double`，
调用 `double(double(x))` 时可以直接证明结果等于 `x * 4n`。这些事实在 SMT-LIB 中标注为 `[summary]`；
被调函数的 `ensures` 会在被调函数自身的证明中单独验证，因此它们不是受信输入。被调函数没有 `ensures`
时，返回值是该类型的任意值；被调函数没有函数体（例如 `declare function`），或者会递归调用回当前
函数时，返回值得到 `unknown`，因为这时使用它的 `ensures` 等于假设正在证明的结论。

动态调用、复杂参数绑定和无法解析的调用不在当前直接调用子集内；相关值进入证明时会明确得到
`unknown`，不会被当作验证成功。

## 局部 `assert` 与 `assume`

`assert: condition;` 要求求解器根据当前路径事实证明条件；证明成功后，该条件也会成为后续语句的事实。
`assume: condition;` 不要求证明，直接把条件加入当前路径事实。这种 `assert:`/`assume:` 语句形式保留给证明指令，
因此用户自定义的 `assert` 或 `assume` 函数在任何位置都保持普通调用语义。两者都只允许出现在函数内，并从生成的
JavaScript 中擦除：

```ts
function increment(value: bigint): bigint {
  assume: value >= 0n; // 可信输入边界；这里不会产生证明义务
  const next = value + 1n;
  assert: next > 0n;  // 利用前面的假设进行证明
  return next;
}
```

`assume` 可以让错误命题“被证明”，因此应只用于验证器暂时无法建模、但由外部系统保证的事实。
`assume` 是受信输入：在生成的 SMT-LIB 中它会被标注为 `[assumption, trusted]` 并命名；某个证明如果实际用到了它
（依据求解器的 unsat core 判断），该证明的消息和 `trustedInputs` 会列出这条假设。公开 API
通常优先使用 `requires`，因为调用者必须证明前置条件，而 `assume` 不会检查调用者。

## 循环不变式

循环不变式写在条件之后、循环体之前：

```ts
while (current < limit) with {
  invariant: [current >= 0n, current <= limit];
} {
  current += 1n;
}
```

编译器分别生成两类证明义务：

1. **初始化**：第一次进入循环前不变式已经成立；
2. **保持性**：假设不变式和循环条件成立，执行一次循环体后不变式仍然成立。

循环结束后的代码可以继续使用不变式与循环退出条件。所有契约和不变式都会从最终
JavaScript 中擦除。

## 程序语义：`/` 与 `%`

程序运算与 SMT 运算是分开的。bigint 的 `/` 和 `%` 按 JavaScript 语义向零截断，
例如 `-7n / 2n === -3n`、`-7n % 2n === -1n`；SMT 的 `div`/`mod` 则是欧几里得除法，`mod` 结果总是非负。
编译器因此不会直接使用 `mod`，而是在生成的 SMT-LIB 中给出明确的定义：

```smt
; TS++ program semantics: JavaScript integer '%' (sign of the dividend; callers prove b != 0)
(define-fun tspp.js.trunc.rem ((a Int) (b Int)) Int (ite (>= a 0) (mod a (abs b)) (- (mod (- a) (abs b)))))
```

执行代码中的 `/` 和 `%` 在除数为 `0n` 时会抛出 `RangeError`，所以除数不是非零字面量时，
运算位置会生成一个 `program-semantics` 类别的“除数非零”证明义务：

```ts
function average(total: bigint, count: bigint) with {
  requires: count > 0n; // 去掉这一行会得到反例 count = 0
}: bigint {
  return total / count;
}
```

规格（`requires`、`ensures`、不变式、精化谓词、`assert:`/`assume:`）会被擦除、从不执行，
因此它们是纯逻辑公式，其中的运算不产生运行时证明义务。规格中的除数为零时，结果是一个未指定的值
（沿用 SMT `mod`/`div` 对零的处理），不会报错，规格也不做额外的良构性检查；需要排除这种情况时，
在规格里写出条件即可，例如 `requires: b !== 0n && a % b === 0n`。

## `number` 模型

JavaScript `number` 具有 IEEE-754 舍入、`NaN` 和无穷等行为，不能默认等同于数学实数。
因此必须显式选择抽象模型。`"mathematical-real"` 把 `number` 视为数学实数：

```ts
function scaledSum(left: number, right: number) with {
  numberModel: "mathematical-real";
  ensures: result === (left + right) * 0.5;
}: number {
  return (left + right) * 0.5;
}
```

这项证明只说明数学实数模型下的结论，不代表对所有 IEEE-754 边界值都成立。因此这个模型
本身是一条受信假设，每个依赖它的证明都会在 `trustedInputs` 中报告它。

`"safe-integer"` 把 `number` 视为 ±`Number.MAX_SAFE_INTEGER` 范围内的整数，在这个范围内
IEEE-754 运算是精确的。执行代码中的每个 `+`、`-`、`*` 都必须可证明不越界，`%` 需要非零除数；
`/`（不是整数除法）和小数字面量不在模型内。只有参数的范围是受信输入：

```ts
function lastDigit(value: number) with {
  numberModel: "safe-integer";
  requires: value >= 0;
  ensures: result >= 0 && result < 10;
}: number {
  return value % 10;
}
```

没有 `numberModel` 时，涉及 `number` 的证明会得到 `unknown`。`numberModel` 按函数、精化类型和循环逐个
声明，不提供文件级或项目级默认值：选择哪种数值语义应当在用到它的地方显式可见。`safe-integer` 只作用于
`number` 类型的变量、参数和返回值；记录或 `data` 中的 `number` 字段不在该模型内，会得到 `unknown`。

## 逻辑库：`ts-plus-plus/smt`

TS++ 不内置任何逻辑谓词（早期内置的 `isEven`、`between` 等已经移除），需要的逻辑由用户自己定义。
逻辑库是普通的 `.tspp`/`.ts` 模块，用 `ts-plus-plus/smt` 的类型化构造器构造 SMT 项：

```ts
import * as smt from "ts-plus-plus/smt";

export const isMultipleOf = smt.definePredicate(
  "isMultipleOf",
  [["value", smt.Int], ["factor", smt.Int]],
  (value, factor) => smt.and(smt.not(smt.eq(factor, 0n)), smt.eq(smt.js.rem(value, factor), 0n)),
);
```

契约像调用普通函数一样调用它：

```ts
import { isMultipleOf } from "./logic"; // 逻辑库通常是独立模块

function roundDown(value: bigint, factor: bigint) with {
  requires: [value >= 0n, factor > 0n];
  ensures: isMultipleOf(result, factor);
}: bigint {
  return value - value % factor;
}
```

工作方式：

- **按类型识别，而不是按名字。** 逻辑函数的类型携带其定义；编译器据此识别调用，并在编译期
  只执行这个声明及其依赖（同文件的其他顶层代码不会执行）。这一步与宏共用同一个执行接缝，
  因此需要开启 `smtLibraries`。
- **不可执行。** 逻辑函数只能出现在规格（`requires`、`ensures`、不变式、谓词、`assert:`/`assume:`）
  中，在其他位置调用会得到编译错误，运行时调用会抛错。
- **可信边界。** `definePredicate`/`defineFunction` 生成非递归 `define-fun`，属于保守扩展，
  不引入受信输入；`defineRecursiveFunction` 生成 `define-fun-rec`，由于不检查终止性，会作为
  受信假设报告；`declareFunction(..., { axioms })` 的公理是受信输入，被证明实际用到时才会报告。
- **重新检查。** 逻辑库是不受信的输入：编译器会重建并校验其中的每个定义，再交给 SMT 后端
  做 sort 检查。定义有误时相关义务得到带原因的 `unknown`，不会导致编译器崩溃。
- **构造器能力。** 支持 Core / Ints / Reals / Strings 的常用运算、`forall`/`exists`（可带
  `patterns`）、`ite`、未解释 sort（`declareSort`）、`smt.js.div`/`smt.js.rem`（JavaScript 语义），
  以及作为逃生口的 `smt.raw(text, sort, functions)`。逻辑库使用理论 sort 与未解释 sort。参数 sort 与
  TypeScript 类型的对应关系是 `Int ↔ bigint`、`Real ↔ number`、`Bool ↔ boolean`、`String ↔ string`；
  `Int` 参数在契约中也接受 `number`，用于 `safe-integer` 模型（此时 `number` 就是 SMT `Int`）。

原来的内置谓词可以这样定义（`number` 版本在 `safe-integer` 模型下可直接复用这些 `Int` 定义）：

```ts
export const isEven = smt.definePredicate("isEven", [["value", smt.Int]], value => smt.eq(smt.mod(value, 2n), 0n));
export const between = smt.definePredicate(
  "between",
  [["value", smt.Int], ["lower", smt.Int], ["upper", smt.Int]],
  (value, lower, upper) => smt.and(smt.le(lower, value), smt.le(value, upper)),
);
```

`ts-plus-plus/smt` 是一个不依赖编译器的独立小模块；编译期执行逻辑库时，编译器提供自己
内置的同一份实现，因此生成的 IR 总是与当前编译器版本一致。

## 精化类型与传播

精化直接写在普通结构类型别名上，不依赖 `newtype`：

```ts
type Positive = bigint with { predicate: value > 0n; };
type NonNegative = bigint with { predicate: value >= 0n; };

const age: Positive = 18n;

function widen(value: Positive): NonNegative {
  return value;
}
```

`value` 表示正在引入精化类型的值。函数参数的精化谓词会作为函数体内的已知事实，因此求解器可以证明 `value > 0n` 蕴含 `value >= 0n`。精化类型在 JavaScript 中完全擦除，不生成构造器。

## 带约束的 `newtype`

`with` 谓词也可以附加到 `newtype`。此时每次显式调用构造器都会生成证明义务：

```ts
newtype Port = bigint with {
  predicate: value > 0n && value <= 65535n;
};

const http = Port(80n); // proved
```

它与结构精化类型的区别是：`newtype` 仍保持名义边界并生成原有的轻量构造器；谓词本身仍只在编译期存在，不进入 JavaScript。

## 查看 SMT-LIB

在仓库的 Extension Development Host 中打开这些文件，然后运行：

```text
TS++: Show Verification SMT-LIB
```

命令会在侧栏一次打开当前文件的全部证明义务，按源码位置排序，并为每段
SMT-LIB 标注对应的源码行号、状态和说明。编译器 API 也可以通过
`program.getVerificationArtifacts()` 读取相同产物，包括反例和证明依赖的受信输入。

生成的 SMT-LIB 只使用标准命令和标准理论符号，可以交给任意 SMT-LIB 2.6 求解器重放：

- `set-logic` 按实际用到的理论计算（例如 `QF_LIA`、`QF_NIA`、`UFDTLIA`），无法归类时才使用 `ALL`；
- 超时等求解器选项不写入脚本，由后端负责；
- 每条断言前都有注释说明其类别（`path`、`precondition`、`invariant`、`assumption` 等）和源码位置，
  受信断言额外标注 `trusted`；逻辑库和程序语义的定义以 `define-fun` 给出并注明出处。

证明结果分为 `proved`、`failed`、`unknown` 和 `error`。不支持的表达式、控制流或运行环境
会得到带原因的 `unknown` 编译错误。

## 运行示例

先在仓库根目录构建编译器：

```powershell
pnpm build:compiler
```

然后运行：

```powershell
cd packages/examples/05-formal-contracts
pnpm check
pnpm build
pnpm start
```

预期输出：

```text
absolute(-5) = 5
successor(5) = 6
countTo(4) = 4
scaledSum(2, 6) = 4
halveTowardZero(-7) = -3
remainder(-7, 2) = -1
average(10, 4) = 2
keepsMultiple(12, 3) = 12
triangle(10) = 45
lastDigit(1234) = 4
roundDown(17, 5) = 15
sumTo(10) = 55
```

可以在 `dist` 中确认生成的 JavaScript 不包含 `with`、`requires`、`ensures` 或 `invariant`。
