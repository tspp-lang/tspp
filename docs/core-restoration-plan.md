# 核心还原与特性迁出计划

## 目标

1. 每个特性的解析、检查、降级、声明输出、编辑器支持全部在自己的插件包里。
2. 核心包（`packages/compiler`）尽量回到上游 TypeScript 的原文。逻辑相同也要还原成上游写法，让 `git diff` 只剩插槽。
3. 核心只做谨慎、通用、可审查的最小修改：插槽。每个插槽都要能用一句和特性无关的话描述。
4. 插件之间是加法关系：理想情况下每个插件只和 TS（加上 SDK 插槽）耦合。

## 现状基线

- 上游基线：`824eb7234`（TypeScript 6.0.3 LKG）；迁移进 monorepo 后的对照点是 `c631124d2`。下文的"基线"指 `c631124d2` 中的 `packages/compiler/src`。
- 相对基线，核心新增约 7300 行，大头在 `checker.ts`(≈1200)、`program.ts`(≈940)、`plugins/registry.ts`(≈910)、`parser.ts`(≈850)、`emitter.ts`(≈520)、`transformers/ts.ts`(≈380)、`macroWorker.ts`(338)、`services.ts`(≈230)。九个插件的 `src` 合计约 5600 行。
- 特性语义所在位置：

| 插件 | 留在核心的部分 |
|---|---|
| macros | 全部：`macro` 关键字、`MacroInvocationStatement`、`with` 子句、`macroWorker.ts`、`program.ts` 中的多轮展开 |
| operator-sections | 全部：占位符 `_` 改写成箭头函数 |
| static-interface-members | 全部：`static` 成员契约检查 |
| nominal-types | tagged union 构造与降级、`match` 穷尽性和重复分支检查、nominal 类型创建（`compiler/plugins/taggedUnion.ts`、checker、`transformers/ts.ts`、emitter） |
| higher-kinded-types | kind 检查、类型构造器应用、类型宇宙（checker 中 `applyHigherKindedType` 等） |
| type-computation | 类型层 `let`、有序匹配、类型构造器节点（parser 的 `finish*`），且与 HKT 逻辑交叉 |
| modern-syntax | trailing closure、`def` 深只读绑定、completion block 的检查与降级 |
| dependent-types | `reify` 与运行时类型匹配（`createReifiedType`、`checkReifiedTypeMatch`、`createReifiedTypeDescriptor`） |
| formal-verification | 基本在插件内；只与宏共用核心里的 `with` 子句 |

另外还有一层"产品层"改动不属于任何特性：`.tspp`/`.d.tspp` 扩展名、`tsppTypes` 解析、CLI 品牌、从 tsconfig 加载插件、分析器调度、Quick Info 转发。它们保留，但要隔离（见规则 2）。

## 根因

SDK 让编译器 AST 对插件完全不透明（`TSPPSyntaxNode = object`）。插件没有办法自己构造节点、查询类型，每一步操作都只能变成一个 SDK 方法（`finishTaggedUnionDeclaration`、`checkTaggedUnionMatch`、`finishTypeUniverse`……）。方法的实现只能写在核心里，于是特性语义一步步掉回了核心。这些原语几乎都只有一个消费者，说明它们是特性本身，不是插槽。

**决策（已确认）**：放弃"不透明 AST"，改为宿主在激活时把 TS 公共 API（`ts` 命名空间：`SyntaxKind`、`factory`、节点判断函数、`TypeChecker` 公共方法）交给插件；插件以 type-only 方式依赖 TS 的类型声明。这样插件只和 TS 耦合，正好是设计目标；SDK 只描述"插在哪里"，不再描述"怎么做每个特性"。

### SDK 的新定位

放弃不透明 AST 后，SDK 仍然保留，但职责从"替代编译器 API"收缩为"插件契约"：

- **保留**：插件身份与清单（见下文"插件间关系"）、API 版本、`definePlugin`、生命周期与 disposer、各 facet（compiler、languageService、lsp、editor）、程序分析的快照与诊断类型、artifact 类型。
- **保留并改写**：插槽接口。签名直接使用 TS 的节点和类型（如 `ts.Expression`、`ts.TypeChecker`），不再定义一套平行的 `TSPP*` 不透明类型。
- **新增**：清单里的 `syntax`（关键词声明）和 `provides`（对外 API），以及激活上下文里的 `context.provide` 与 `context.dependencies`，见下文"插件间关系"。
- **删除**：不透明节点别名、`*SyntaxKinds` 表、所有特性专用操作（`finish*`、`checkTaggedUnionMatch`、`createNominalType` 等）、清单里的 `conflicts`。

TS 的接入约定：

- 运行时的 TS 对象只从 `context.ts` 获取，保证插件和编译器用的是同一份实例（节点身份、`SyntaxKind` 数值一致）。插件不得在运行时 import npm 上的 `typescript`。
- 类型声明以 TSPP 编译器自己产出的 `.d.ts` 为准，由 SDK 统一 re-export，插件只做 type-only 依赖，不直接依赖 `ts-plus-plus` 包。
- SDK 的 API 版本同时绑定 TS 基线版本；升级上游 TS 时，SDK 主版本随之变化。

## 核心修改规则

1. **只允许插槽调用点。** 核心文件中每一处相对上游的改动都必须是插槽调用点，并带标记注释 `// TSPP-SLOT(<插槽名>)`。调用点尽量是一行或几行的转发。
2. **实现放在新文件。** 插槽实现、插件注册表、产品层逻辑都放在新目录 `packages/compiler/src/compiler/tspp/`（以及 `services/tspp/`、`server/tspp/`）。新文件不影响与上游的对比，原有文件里的改动才是成本。
3. **不改上游结构。** 不改上游函数签名（例如还原 `factory.createFunctionDeclaration`），不重命名、不重排、不改格式、不顺手重构。需要附加数据时用 WeakMap 旁路，不给上游节点加字段。
4. **新 `SyntaxKind` 最少化。** 目标只保留一个通用信封（现有的 `ExtensionExpression`，必要时再加一个类型位置的信封，需单独评审）。`MacroKeyword`、`MacroInvocationStatement`、`WithClause`、`WithProperty` 全部移除。
5. **零插件即上游。** 不加载任何插件时，编译器对 `.ts` 的行为必须与上游一致：不出现新关键字，也不出现新语法。
6. **插槽准入。** 新插槽必须同时满足：能用和特性无关的话描述；至少有一个现有插件立即使用；说明为什么无法用已有插槽或"脱糖成普通 TS"实现。合入时在本文档登记。
7. **插件间关系只走清单。** 唯一允许长期存在的关系是单向依赖，由清单声明、经被依赖方的 API 访问。插件不得硬编码其他插件的关键字、语法或降级产物（例如现在 nominal-types 里的 `"mltt"` 排除、formal-verification 用正则读 `data` 并假设 `_tag`）。详见下一节。

## 插件间关系

插件之间可能出现四种关系，只有第一种允许长期存在：

| 关系 | 处理 | 检查手段 |
|---|---|---|
| 单向依赖 | 依赖方在清单 `requires` 中声明；被依赖方在清单 `provides` 中声明 API，激活时 `context.provide(api)`；依赖方用 `context.dependencies.get(id)` 取值，类型只能 `import type` 自被依赖方包的 `./api` 子路径 | 宿主校验依赖存在、按依赖顺序激活；ESLint 禁止从其他插件包导入运行时值 |
| 互相依赖（共用内部模型） | 合并成一个插件 | 依赖图出现环即报错；插件测试加载的插件必须在它声明的依赖闭包内 |
| 关键词冲突 | 换关键词 | 清单 `syntax.keywords` 声明每个关键词及其位置（expression、statement、declaration、type、pattern、function-clause 等），CI 两两比较，同一位置同一词即失败。只信任清单，不扫描代码，也不做运行时断言 |
| 隐性干扰（通过源码文本、全局注册表、产物、运行时表示互相影响） | 明确归属：插件只改写自己拥有的语法 | 每个插件的测试集再在"加载全部插件"的环境下运行一遍（`packages/plugins/integration/`） |

清单示例：

```ts
manifest: {
  id: "formal-verification/z3",
  requires: ["nominal-types"],
  syntax: { keywords: [{ word: "with", position: "function-clause" }, { word: "assert", position: "statement" }] },
}
```

两个插件提供同一个 `provides` API 时宿主报错，这覆盖了原来 `conflicts` 唯一合理的用途（例如两个求解器），所以 `conflicts` 删除。编辑器用的 `editor.keywords` 改为由 `syntax.keywords` 派生。

### 已知违规与处理

| 违规 | 类型 | 处理 |
|---|---|---|
| higher-kinded-types 与 type-computation 共用 checker 中的类型构造器与 kind 机制；只加载 type-computation 时它的 27 个测试有 8 个失败 | 互相依赖 | 合并：type-computation 吸收 higher-kinded-types。**已完成** |
| nominal-types 的 `match` 与 dependent-types 的 `match mltt` | 关键词冲突 | dependent-types 改用 `typecase`，删除 nominal-types 里的 `"mltt"` 排除。**已完成** |
| macros 与 formal-verification 都使用 `function ... with { ... }` | 关键词冲突 + 隐性干扰（#34） | `with` 归 formal-verification；宏的配置改为 `macro({ timeout: ... }) function`。迁移前 formal-verification 暂时用 `isMacroWithClause` 跳过宏函数，迁移后删除 |
| formal-verification 用正则读 nominal-types 的 `data` 并假设 `_tag` | 未建模的单向依赖 | nominal-types 通过 `provides` 发布 `nominal-types/adt`（`@tspp/plugin-nominal-types/api`），formal-verification 经 `optionalDependencies` 取用：没装 nominal-types 时没有 `data` 语法，也就无需建模，所以用可选依赖而不是 `requires`。**已完成** |
| nominal-types 的测试加载 higher-kinded-types（"data 类型构造器作高阶参数"的用例） | 未声明的测试依赖 | 两个跨插件用例移到 `integration/test/cross-plugin.test.cjs`。**已完成** |

## 目标插槽清单

优先策略是**脱糖**：插件在解析阶段直接产出普通 TS 节点，加上旁路元数据，让上游 binder、checker、emitter 原样工作。只有脱糖做不到时才使用检查或降级钩子。

| 插槽 | 位置 | 说明 | 预期消费者 |
|---|---|---|---|
| 源码投影 | 解析前 | 已有，保持长度和换行不变；投影只能改写本插件在清单中声明的语法 | dependent-types、formal-verification |
| 语法扩展 | 表达式、语句、声明、类型、后缀类型、类成员等位置的起始 token | 插件拿到解析器游标与 `ts.factory`，返回普通节点或 `ExtensionExpression` | 全部语法类插件 |
| 表达式改写 | 括号表达式与调用实参解析完成后（`parseParenthesizedExpression`、`parseArgumentExpression`） | 插件用解析器自己的 factory 把表达式改写成普通 TS 语法；被改名的标识符按新名字输出（emitter 中一处调用点）。**已实现** | operator-sections |
| 扩展节点检查 | checker | 对 `ExtensionExpression` 返回类型，插件可调用公共 checker API | modern-syntax、dependent-types、nominal-types |
| 附加诊断 | checker 结束一个源文件时 | 插件遍历自己拥有的节点并报告诊断（穷尽性、静态成员契约、使用限制等） | nominal-types、static-interface-members |
| 扩展节点降级 | `transformers/ts.ts` 之前 | 把扩展节点变成普通 TS AST | modern-syntax、dependent-types |
| 声明输出 | `.d.tspp` 输出 | 插件为自己拥有的节点提供声明文本 | 有富语法的插件 |
| 程序重建 | `createProgram` 外层 | 插件返回改写后的源码，宿主用新源码重建程序；宏的 worker 与展开策略归插件 | macros |
| 程序分析 | 已有 | 不可变快照 + 异步诊断 + artifact | dependent-types、formal-verification |
| 类型层扩展 | checker 类型解析与实例化 | **待研究**：HKT、类型宇宙、类型构造器无法脱糖成 TS 类型，可能需要一个通用的"扩展类型节点 → 类型 / 实例化回调"插槽 | higher-kinded-types、type-computation |
| Quick Info | language service | 已有 | 多个插件 |

现有的单消费者原语（`finish*`、`checkTaggedUnionMatch`、`createNominalType`、`registerCompileTimeMacros`、`registerPlaceholderExpressionSyntax`、`registerInterfaceMemberContract` 等）在对应插件迁移完成后从 SDK 删除。

## 阶段

### 阶段 0：护栏

1. 先处理当前未提交的改动：提交或暂存。它们本身就是往核心里加特性逻辑，迁移后会被替换，但在迁移前要作为行为基准。
2. 打标签 `tspp-core-baseline`（指向 `c631124d2`）。
3. 写脚本 `scripts/core-diff.mjs`：
   - 统计 `packages/compiler/src` 中原有文件相对基线的改动行数，按文件输出；
   - 列出没有 `TSPP-SLOT` 标记的 hunk；
   - 输出特性关键词出现次数（macro、taggedUnion、nominal、kind、universe……），作为迁移进度指标。
4. 确认行为基准测试齐全：各插件的端到端测试（`packages/plugins/*/test`）、`test:examples`、language-server 测试。缺覆盖的特性先补测试，尤其是悬停、诊断位置等以前修过的编辑器行为。
5. 增加"零插件"测试：不加载插件时编译一批普通 TS（可从上游测试中挑），确认没有新关键字或新语法生效。
6. 插件间关系检查（见"插件间关系"），这一阶段只记录、不修复：
   - 清单增加 `syntax.keywords`，各插件补全声明，加上两两比较关键词的测试；
   - 依赖环检查，以及"插件测试只加载声明过的依赖"的检查；
   - 每个插件的测试集在"加载全部插件"的环境下再跑一遍；
   - 现有违规写进已知清单（即上文"已知违规与处理"），CI 只拦截新增违规。

完成标准：脚本能输出当前数字，所有测试绿色，CI 跑这个脚本但先不卡门槛；关系检查已在 CI 中拦截新增违规。

**完成记录（2026-11-01）**

- 标签 `tspp-core-baseline` → `c631124d2`。`pnpm core-diff`（`scripts/core-diff.mjs`）输出：40 个上游文件 +4954 −168，核心新增文件 4 个共 1464 行，无 `TSPP-SLOT` 标记的 hunk 427 个；CI 的 "Core drift report" 只报告不拦截。
- 零插件：`packages/core-parity` 用 npm 上的 `typescript@6.0.3` 作对照，比较诊断与输出。不加载插件时只有 `macro` 与 `with` 子句仍是核心语法，记为已知违规，迁移后测试会要求删除对应条目。
- 关系检查：清单新增 `syntax.keywords`，九个插件全部声明；`packages/plugins/integration/test/relations.test.cjs` 检查关键词冲突、依赖环、测试加载未声明插件，现有违规与上表一致。
- 隐性干扰：`pnpm test:plugins:together` 在加载全部插件的环境下运行每个插件自己的测试集。首次运行发现 nominal-types 把 `match = 6`、`match.x` 等普通标识符误解析为 match 表达式（单独加载 nominal-types 时同样存在），已修复。
- 以上都并入 `pnpm test:features`，由 CI 的 "Feature capsules" 运行。

### 阶段 1：插槽地基

1. 新建 `compiler/tspp/` 目录，把 `plugins/registry.ts`、`plugins/analysis.ts` 移进去，作为插槽实现的唯一位置。
2. 实现"宿主把 `ts` 公共 API 交给插件"：SDK 的 compiler facet 增加 `context.ts`，插件以 type-only 方式依赖 TS 的类型声明。
3. 按上表实现通用插槽（不含"类型层扩展"），核心原有文件中只加带标记的调用点。
4. 插件间 API：清单增加 `provides`，激活上下文增加 `context.provide` 与 `context.dependencies`，被依赖方包增加 `./api` 子路径；ESLint 禁止从其他插件包导入运行时值。与 `context.ts` 同属 SDK 的破坏性变更，一次完成、一起升级 API 版本。删除清单里的 `conflicts`。
5. 用一个最简单的插件（operator-sections）走通全链路，验证插槽够用。

完成标准：新插槽可用；旧原语仍在，迁移可以逐个进行。

**完成记录（2026-11-01）**

- `plugins/registry.ts`、`plugins/analysis.ts`（连同 `taggedUnion.ts`）移到 `compiler/tspp/`。
- SDK API 版本升到 2，一次完成的破坏性变更：compiler facet 增加 `context.ts`（宿主编译器的公共 API，类型取自 npm 上的 `typescript@6.0.3`）；清单增加 `provides`，上下文增加 `context.provide` 与 `context.dependencies.get`，宿主拒绝两个插件提供同一 API；删除 `conflicts`；`editor.keywords` 只保留次要词，编辑器关键词由 `getTSPPEditorKeywords` 从 `syntax.keywords` 派生。
- `packages/plugins/eslint.boundaries.mjs`：插件只能 `import type` 其他插件包，不能导入运行时值或进入其他插件的源码。
- 第 3 步改为"随第一个消费者实现插槽"：按规则 6，插槽必须有立即使用它的插件，所以每个插槽在迁移对应插件时实现并登记到上表。
- operator-sections 走通全链路（也即阶段 2 第 1 步）：核心里的占位符收集与脱糖、`tsppHole`/`tsppOperatorParam` 字段删除，换成"表达式改写"插槽；插件用 `context.ts` 自己完成改写。

### 阶段 2：逐个迁移插件

顺序从简单到复杂，每个插件独立成一个或几个 commit：

1. **operator-sections**：占位符改写变成插件里的脱糖。删除核心对应代码。
2. **static-interface-members**：用"附加诊断"实现契约检查，必要时配合脱糖。
3. **modern-syntax**：trailing closure、`def`、completion block 改为脱糖加扩展节点检查和降级。
4. **nominal-types**：`newtype` 脱糖成品牌交叉类型加构造函数，`data` 脱糖成判别联合加构造函数，`match` 用扩展节点检查加附加诊断做穷尽性。删除 `compiler/plugins/taggedUnion.ts` 以及 checker、transformer、emitter 中的对应代码。通过 `provides` 发布 ADT 描述；删除 `"mltt"` 排除。
5. **dependent-types**：`reify` 与运行时类型匹配迁到扩展节点检查和降级；`match mltt` 改名为 `typecase`。
6. **macros**：`macro` 改成插件语法，宏不再使用 `with`，配置改为 `macro({ timeout: ... }) function`。展开改用"程序重建"插槽，`macroWorker.ts` 移入插件。还原 `createFunctionDeclaration` 签名，移除四个宏相关 `SyntaxKind`。
7. **formal-verification**：`with` 只归它所有，删除对宏函数的识别（`isMacroWithClause`、`proof-scope.ts` 的 `isMacroFunction`）；声明 `requires: ["nominal-types"]`，改用 nominal-types 的 ADT API，不再用正则读 `data`、不再假设 `_tag`。
8. **type-computation（吸收 higher-kinded-types）**：最难，放最后。两个插件先合并为一个，再单独设计"类型层扩展"插槽并评审；合并后两者的交叉（例如类型层 `let` 绑定类型构造器时使用 kind）是插件内部的事，插槽只需服务这一个插件。

每个插件的迁移流程：

1. 确认该插件的测试和相关示例在迁移前是绿的。
2. 在插件内用新插槽实现。
3. 删除核心中该特性的全部代码；被改过的上游代码按 hunk 还原成基线原文（以 `git show tspp-core-baseline:<file>` 为准，逐字恢复，不保留"逻辑等价"的改写）。
4. 删除 SDK 中只服务这个插件的原语。
5. 跑该插件测试、examples、language-server 测试（按单进程、限制堆内存的方式运行）。
6. 运行 `core-diff`，确认数字下降，并在本文档记录。

### 阶段 3：逐文件还原与收口

1. 对每个改过的上游文件，与基线逐 hunk 对比：剩余 hunk 必须全部是带标记的插槽调用点，其余一律还原原文（包括格式、命名、顺序、注释）。
2. 产品层改动（`.tspp` 扩展名、`tsppTypes`、CLI 品牌、插件加载）的实现移到 `tspp/` 新文件，原有文件里只留调用点。
3. `core-diff` 在 CI 中变成门槛：出现未标记的 hunk 就失败；改动行数设预算（阶段 1 结束后根据实际数字定）。
4. 更新 `docs/plugin-framework.md`：写入本计划的核心修改规则与插槽登记表。

## 风险与待定

- **类型层特性可能无法完全迁出。** HKT、类型宇宙、类型构造器需要介入 checker 的类型解析和实例化。若通用插槽设计不出来，需要明确记录为"受控例外"，并限定在一个文件内。
- **插件开始依赖 TS 公共 API。** 升级上游 TS 时插件可能需要适配；但这本来就是"只和 TS 耦合"的含义，且比现在核心里的改动好升级得多。
- **脱糖可能改变编辑器体验。** 悬停文本、诊断位置、重命名等以前修过不少问题，迁移时必须有 language-server 测试兜底。
- **进程级注册表。** 现在一个 tsserver 进程只能有一套插件。推迟到阶段 3 之后处理，但新插槽的接口不得进一步依赖全局状态。
