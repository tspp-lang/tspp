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
4. **新 `SyntaxKind` 最少化。** 目标是不加新 `SyntaxKind`：插件脱糖成普通节点（原有的通用信封 `ExtensionExpression` 已在 dependent-types 迁移后删除；类型位置若确需信封，单独评审）。`MacroKeyword`、`MacroInvocationStatement`、`WithClause`、`WithProperty` 全部移除。
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
| macros 与 formal-verification 都使用 `function ... with { ... }` | 关键词冲突 + 隐性干扰（#34） | `with` 归 formal-verification；宏的配置改为 `macro({ timeout: ... }) function`；`isMacroWithClause` 已删除。**已完成** |
| formal-verification 用正则读 nominal-types 的 `data` 并假设 `_tag` | 未建模的单向依赖 | nominal-types 通过 `provides` 发布 `nominal-types/adt`（`@tspp/plugin-nominal-types/api`），formal-verification 经 `optionalDependencies` 取用：没装 nominal-types 时没有 `data` 语法，也就无需建模，所以用可选依赖而不是 `requires`。**已完成** |
| nominal-types 的测试加载 higher-kinded-types（"data 类型构造器作高阶参数"的用例） | 未声明的测试依赖 | 两个跨插件用例移到 `integration/test/cross-plugin.test.cjs`。**已完成** |

## 目标插槽清单

优先策略是**脱糖**：插件在解析阶段直接产出普通 TS 节点，加上旁路元数据，让上游 binder、checker、emitter 原样工作。只有脱糖做不到时才使用检查或降级钩子。

| 插槽 | 位置 | 说明 | 预期消费者 |
|---|---|---|---|
| 源码投影 | 解析前 | 已有，保持长度和换行不变；投影只能改写本插件在清单中声明的语法。`.d.tspp` 输出可通过 `restoreFunctionClause`（参数表之后）与 `restoreFunctionPrefix`（`function` 之前）恢复被投影掉的文本 | dependent-types、formal-verification、macros |
| 语法扩展 | 表达式、主表达式、调用实参、语句、声明、类型、后缀类型、类型参数名之后、类型别名的类型参数表之后等位置的起始 token | 插件拿到解析器游标与 `ts.factory`，返回普通节点。表达式（一元表达式与箭头函数体）、主表达式（`primary-expression`，其后的调用与成员访问、前缀运算符照常作用于结果）、调用实参（`argument`，整个实参）、语句、函数体、声明、类型（`type`）、后缀类型（`postfix-type`，游标带 `precedingType`）十个位置的通用游标（`registerSyntaxExtension`，解析器自己的 factory、`finishNode`、普通解析函数，含 `parseTypeArguments`；`parseErrorAt` 可带插件自己的错误码）**已实现**；两个注解位置（`type-parameter-annotation`、`type-alias-annotation`）的 `parse` 返回一个回调，声明建好后宿主把声明节点交给它，该声明不参与增量复用。插件语法在节点之间留下的名字、字面量与标点都不是解析树节点，检查器不会解析它们；没有源码位置的插件节点由最近的有位置祖先代表（`getErrorSpanForNode` 等四处调用点） | modern-syntax、nominal-types、dependent-types、type-computation、operator-sections |
| 附加诊断 | 源文件的绑定与检查诊断合并处（`program.ts` 一处调用点） | 插件为每个源文件补充语义诊断，`@ts-expect-error` 等注释指令照常生效（`registerDiagnosticProvider`）；`filterDiagnostic` 可以丢弃检查器报告的诊断，也可以返回一个替代诊断（例如把生成节点上的诊断移到它代表的源码上）。`getSemanticDiagnostics` 还拿到该 checker 的 `TSPPTypeOperations`（与类型层扩展宿主共用）：绑定 `this`、匿名对象类型与交叉类型、按检查器的方式得到可赋值性错误及其展开。诊断的错误码与文字都归插件，核心的 `diagnosticMessages.json` 里没有插件消息。**已实现** | modern-syntax、nominal-types、type-computation、static-interface-members |
| 接口成员绑定 | binder 成员归属、名字解析的静态性、修饰符语法检查 | `registerInterfaceMemberBinding({ keywords, isStaticMember })`：插件判定的接口成员是接口的静态成员，允许出现、不进入实例类型、按静态类成员解析名字。经评审认定为通用插槽：公共 API 无法改变绑定与语法检查，源码投影也无法等长改写。调用点都是带标记的一行（`isTSPPStaticInterfaceMember`）。实现方欠下的静态侧由插件的诊断提供者检查（18074 归插件），兼容 `.d.ts` 中省略静态成员由插件的 `restoreCompatibilityDeclaration` 完成 | static-interface-members |
| 声明输出 | `.d.tspp` 与随附的兼容 `.d.ts` 输出（emitter 一处调用点，属"语法扩展"） | 插件为自己拥有的节点提供声明文本：`restoreDeclaration` 给 `.d.tspp`，`restoreCompatibilityDeclaration` 给兼容 `.d.ts`；两者都能处理语句与类型层节点。**已实现** | nominal-types、type-computation |
| 程序重建 | `createProgram` 返回前（`program.ts` 一处调用点），以及 `createProgramAsync` | 插件检查建好的程序，返回按位置匹配的语句替换；宿主从同一源码重新解析这些文件、换入替换语句、重建程序，并可附加或过滤语义诊断、在输出时追加转换器。长期宿主（语言服务）提供 `invalidate`，插件异步完成后请求重建。宏的 worker、超时与展开策略归插件。没有任何替换时宿主不重建，只把诊断、过滤与转换器加到原程序上（实现在 `compiler/tspp/rebuild.ts`，不增加调用点）。**已实现** | macros；dependent-types（`typecase` 只输出被选中的分支） |
| 程序分析 | 已有 | 不可变快照 + 异步诊断 + artifact | dependent-types、formal-verification |
| 类型层扩展 | checker 类型解析、实例化与打印（`checker.ts` 五处带标记的调用点，宿主在 `compiler/tspp/types.ts`） | 插件为类型节点给出类型、实例化并打印自己创建的类型（`registerTypeExtension`）：`resolveTypeNode` 在 `getTypeFromTypeNodeWorker` 开头先问插件；插件用宿主的 `createType` 创建归自己所有的类型，`instantiateTypeWorker` 遇到这些类型时交给插件的 `instantiateType`，节点构造器遇到时交给 `typeToTypeNode`；`isTypeParameterApplicable` 让带类型实参的引用也能指向某个类型参数（决定匿名类型需要带哪些外层类型参数实例化）。宿主（每个 checker 一个）只提供与特性无关的类型操作：解析引用名、取泛型符号的类型参数、实例化泛型别名或类与接口、创建与组合 mapper、按 mapper 实例化、检查类型实参约束、报告错误。**已实现** | type-computation |
| Quick Info | language service | 已有 | 多个插件 |

代码里的标记名依次是 `source-projection`、`syntax-extension`、`diagnostics`、`interface-member-binding`、`program-rebuild`、`program-analysis`、`type-extension`、`quick-info`。

产品层插槽只归宿主，没有插件注册（规则 2；阶段 3 登记）：

| 插槽 | 标记名 | 实现 | 调用点 |
|---|---|---|---|
| `.tspp` 文件 | `tspp-extension` | `compiler/tspp/files.ts` | `Extension.Tspp` 与 `utilities.ts` 中的扩展名表等，每处一行 |
| 模块解析 | `module-resolution` | `compiler/tspp/files.ts` | `moduleNameResolver.ts`：TS++ 源文件解析 `.tspp`/`.d.tspp`、优先 `tsppTypes`、加 `tspp-types` 条件，并且不与 `.ts` 共用目录缓存 |
| 兼容声明 | `declaration-output` | `compiler/tspp/emit.ts` | `emitter.ts`、`program.ts`：`.d.tspp` 旁输出兼容 `.d.ts` |
| 命令行 | `command-line` | `compiler/tspp/commandLine.ts` | `executeCommandLine.ts`、`tsc.ts`：品牌、从 tsconfig 加载插件、等待程序重建与分析器的一次性编译 |
| 插件宿主 | `plugin-host` | `compiler/tspp/registry.ts`、`server/tspp/project.ts` | 命名空间导出、`PluginImport.tspp`、tsserver 的 `enableProxy` |

各插槽的注册接口与全部调用点见 `docs/plugin-framework.md` 的 "Slot registry"。

只有一个消费者的原语（`finish*`、`checkTaggedUnionMatch`、`createNominalType`、`registerCompileTimeMacros`、`registerPlaceholderExpressionSyntax` 等）已随对应插件迁移从 SDK 删除；`registerInterfaceMemberBinding` 经评审保留为通用插槽。

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

**进度记录（2026-11-01）**

- 第 1 步 operator-sections：已完成（见阶段 1 记录）。
- 第 5 步中的改名：`match mltt` → `typecase` 已完成；`reify` 与运行时类型匹配仍在核心。
- 第 7 步中的 ADT 依赖：nominal-types 发布 `nominal-types/adt`，formal-verification 改用它，已完成。
- 第 8 步中的合并：higher-kinded-types 已并入 type-computation；"类型层扩展"插槽尚未设计。
- `core-diff`：40 个上游文件 +4885 −167，核心新增文件只剩 `macroWorker.ts`（338 行），无标记 hunk 422 个。

**进度记录（2026-11-02）**

- 第 6 步 macros：已完成。`macro function`、`macro({ timeout: ... }) function` 与调用 `macro m(T);` 都由插件的源码投影处理（调用投影成等长的 `void [m,T];`）；展开走"程序重建"插槽：调用被换成只在类型层引用宏与目标的语句（保留 hover、跳转、引用与未使用检查，JavaScript 输出前擦除），生成的语句零宽插在其后。worker、超时、宿主求值接口（`evaluateMacroModule`/`resolveMacroModule`）、语言服务里的异步缓存都移入插件；展开结果由插件导出的 `getMacroExpansions(program)` 提供。核心删除 `MacroKeyword`、`WithClause`/`WithProperty`、`MacroInvocationStatement`、`ModifierFlags.Macro`、`FunctionDeclaration.withClause`、宏诊断消息、`macroWorker.ts` 与 `program.ts` 中的展开代码，还原 `createFunctionDeclaration`/`updateFunctionDeclaration` 签名；原编译器单测 `unittests/tspp/macros.ts` 迁成插件测试。
- 第 7 步中的 `with`：只归 formal-verification；删除 `isMacroWithClause` 与 `isMacroFunction`。宏函数此后作为普通函数被验证，暴露出无契约函数返回不可建模的值时误报的问题：现在只有返回值里含除法、带前置条件的调用或对被跟踪数值的算术时才报告。
- 已知违规清空：关键字冲突与 core-parity 的已知违规都为空。
- `core-diff`：31 个上游文件 +3436 −153，`compiler/tspp/` 之外没有新增文件，无标记 hunk 317 个。
- 第 5 步 dependent-types：已完成。`reify T` 与表达式层 `typecase` 改用"语法扩展"插槽在解析时脱糖。`reify T` 变成 `({ kind: "type", text: "T" } as { kind: "type"; text: string; __tspp_reified_type: T })`，静态类型经幻影属性携带 `T`；`typecase d { P => r, ..., _ => r0 }` 变成一个立即调用的箭头函数，各分支是默认参数里的箭头函数 `(s: { __tspp_reified_type: P }) => r`（`infer X` 变成该分支的类型参数，声明保留源码位置），调用 `(a0 as typeof a0 & typeof a1 & ...)(s)` 由 TypeScript 的重载解析选出第一个模式接受描述符类型的分支并推断捕获。选择仍是静态的：插件经"程序重建"插槽（无替换，见上表）加一个输出转换器，按 `getResolvedSignature` 只输出被选中分支的结果，被检查值与其他分支都不运行。与旧实现的差异：匹配从类型同一改为可赋值（与重载一致）；分支结果按函数返回值推断，字面量会拓宽（`"text"` 得到 `string`）；分支结果里不能用 `await`/`yield`。核心删除 `ExtensionExpression`（`SyntaxKind`、factory、visitor、`forEachChild`、binder、utilities）、`checkExtensionExpression`/`createReifiedType`/`checkReifiedTypeMatch`、`transformExtensionExpression`、`createExtensionParser` 与 registry 中的表达式语法表；SDK 删除 `registerExpressionSyntax`、`expressionSyntaxKinds` 及 `TSPPExpressionParser`/`Checker`/`Transformer`/`Syntax`、`TSPPReifiedTypeMatchArm`、`TSPPExtensionExpression`。`transformers/ts.ts`、`nodeFactory.ts`、`visitorPublic.ts`、`utilitiesPublic.ts` 回到基线原文，`SyntaxKind` 与上游一致。
- `core-diff`：27 个上游文件 +1534 −139，无标记 hunk 216 个（第 5 步前为 31 个文件 +1793 −140、244 个）。
- 第 8 步 type-computation（已吸收 higher-kinded-types）：已完成，未使用受控例外。
  - 脱糖：类型层 `let X = A in B` 降级为 `[A] extends [infer X] ? B : never`（`A` 是类型构造器时降级为 redex `(<X: kind> =>> B)<A>`），有序 `match` 降级为嵌套的非分配条件类型（后续分支检查被检查类型的生成副本）。这些 `finish*` 从解析器移到插件，改用"语法扩展"插槽新增的 `type` 位置与游标、`ts.factory` 构造；类型构造器 `<T> =>> B` 与后缀应用 `F<A>`（`postfix-type` 位置）同样在插件里降级为函数类型节点，kind 注解（`F: Type => Type`、`type X: K = ...`）走两个注解位置。宇宙 `Type0`、`Type1`…不再有语法，按无法解析的同名类型引用处理。
  - 无法脱糖的部分（kind、宇宙、类型构造器的应用、类型参数应用的延迟实例化、命名泛型类型作为构造器实参）在插件里基于新的"类型层扩展"插槽实现（见上表）。检查器里只剩五处带标记的调用点：创建宿主、`getTypeFromTypeNodeWorker` 开头、`instantiateTypeWorker` 开头、节点构造器、`isTypeParameterPossiblyReferenced`。实参与别名主体的 kind 检查在插件解析类型节点时完成；实例化时不再报告错误（只在解析节点时报告），因此不会在被实例化的声明处出现连带错误。
  - `.d.tspp` 输出由插件的 `restoreDeclaration` 按源码文本恢复插件类型节点、带 kind 注解的类型参数与类型别名；兼容 `.d.ts` 里无法表达的部分（构造器、应用、宇宙、带 kind 的类型参数引用、裸写的构造器名）由 `restoreCompatibilityDeclaration` 写成 `unknown`，构造器别名得到占位类型参数。`let` 绑定未使用的诊断原来落在零宽的 `infer` 上，现在由插件的诊断过滤器移到绑定名上（不再需要检查器里的改动）；`fixUnusedIdentifier` 改为对插件语法里的类型参数一律不提供删除修复（通用判断 `isTSPPSyntaxNode`）。
  - 核心删除：检查器里的 kind 机制（`applyHigherKindedType`、`getTypeKind`、`checkTypeKind`、`typeUniverses`、`extensionTypeConstructors`、`getMappedHigherKindedTarget` 等，以及 `maybeTypeParameterReference`、`checkUnusedInferTypeParameter` 的改动；`getSymbolAtLocation` 中"`=>` 的父节点不是函数时不声明任何东西"保留为一行带标记的语法扩展调用点，因为 kind 注解把 `=>` 写在类型参数里，编辑器服务会在那里取符号），解析器的 `createExtensionTypeParser`/`createExtensionPostfixTypeParser`/`createExtensionKindAnnotationParser` 与 `finish*`，emitter 的 kind 打印、`getPreservedExtensionTypeRange` 与兼容 `.d.ts` 中的 HKT 规则，registry 的类型语法表与节点标记，诊断 18072、18073（插件改用通用的 `{0}` 诊断报告同样的文字）。SDK 删除 `registerTypeSyntax`、`registerPostfixTypeSyntax`、`registerKindAnnotationSyntax`、`typeSyntaxKinds` 以及 `TSPPTypeSyntax`、`TSPPTypeParser`、`TSPPPostfixTypeSyntax`、`TSPPPostfixTypeParser`、`TSPPKindAnnotationSyntax`、`TSPPKindAnnotationParser`、`TSPPTypeKind`、`TSPPTypeSyntaxKinds`、`TSPPTypeMatchArm` 与不透明节点别名 `TSPPSyntaxNode` 等。
  - 行为差异：kind 错误与"必须应用 N 个类型实参"的错误码从 18072/18073 变为 18086（文字不变）；实例化过程中发现的 kind/约束错误不再报告（只在写出应用的位置报告）；构造器形参约束只在直接应用处检查；`Foo<F>` 这类把构造器传给普通类型参数的写法只在被传入处是类型引用或插件节点时检查；后缀应用节点的范围从目标类型开始（原来从 `<` 开始）。插件单测 `plugin.test.cjs` 原来断言旧注册接口与 `finishTypeUniverse`/`finishTypeApplication` 的调用形状，改为断言新的注册位置与 `parseKind`。
- `core-diff`：27 个上游文件 +812 −130，无标记 hunk 159 个（第 8 步前为 +1532 −139、216 个）；特性词 `higherKinded`、`typeConstructor`、`universe`、`typeMatch` 在新增行中归零。

### 阶段 3：逐文件还原与收口

1. 对每个改过的上游文件，与基线逐 hunk 对比：剩余 hunk 必须全部是带标记的插槽调用点，其余一律还原原文（包括格式、命名、顺序、注释）。**已完成**
2. 产品层改动（`.tspp` 扩展名、`tsppTypes`、CLI 品牌、插件加载）的实现移到 `tspp/` 新文件，原有文件里只留调用点。**已完成**
3. `core-diff` 在 CI 中变成门槛：出现未标记的 hunk 就失败；改动行数设预算。**已完成**
4. 更新 `docs/plugin-framework.md`：写入本计划的核心修改规则与插槽登记表。**已完成**

**完成记录（2026-11-02）**

- `core-diff`：26 个上游文件 +369 −47，无标记 hunk 0 个，`tspp/` 目录之外没有新增文件（阶段 3 前为 27 个文件 +812 −130、159 个）。最大的剩余改动是 `parser.ts`（+111，语法扩展的游标与各位置调用点）和 `checker.ts`（+75，类型层扩展与接口成员契约的静态侧类型）。
- 产品层实现移入新文件：`compiler/tspp/commandLine.ts`（CLI 品牌、从 tsconfig 加载插件、一次性编译等待程序重建与分析器，`tsc.ts` 改调 `executeTSPPCommandLine`）、`compiler/tspp/files.ts`（`.tspp`/`.d.tspp` 模块解析与兼容声明路径；`EmitFileNames` 不再带兼容声明字段）、`compiler/tspp/emit.ts`（兼容 `.d.ts` 输出、声明输出中恢复投影掉的文本）、`services/tspp/quickInfo.ts`、`services/tspp/syntax.ts`（插件语法的子节点、格式化、修复）、`server/tspp/project.ts`（tsserver 激活插件与分析诊断）。`executeCommandLine.ts`、`services.ts` 的 Quick Info 与语义分类、`typescript.ts` 回到基线原文（注册表在加载时自行初始化）。产品层插槽登记在上表。
- 门槛：`node scripts/core-diff.mjs --check`（`pnpm core-diff:check`）在出现无标记 hunk、`tspp/` 之外的新文件或超出预算（27 个文件 +385 −55）时失败，CI 的 "Core drift gate" 运行它。`diagnosticMessages.json` 不能写注释，插槽新增的消息用 `"tsppSlot"` 字段携带标记；未被使用的 18071 消息删除（modern-syntax 自带同样的文字）。
- 行为差异：`.ts` 文件里无扩展名的导入回到上游的 `resolvedUsingTsExtension`（`false`，原来是 `undefined`）；`Node.getChildren` 只在 TS++ 文件或含无位置子节点的节点上走插件语法的实现，其余节点回到上游（tabstop 节点里的标识符重新被跳过）；兼容 `.d.ts` 不再为没有 `static` 修饰符的接口成员复制修饰符数组；同步的 `executeCommandLine` 在有分析器时不再返回 Promise。
- 阶段 2 迁移遗留的回归（插件层修复，核心不变）：
  - nominal-types 的诊断过滤器原来丢弃所有零宽的"未使用"诊断，插件注册顺序在 type-computation 之前时，`let` 绑定的诊断到不了把它移到绑定名上的过滤器。现在只丢弃本插件生成的空声明（品牌类的私有成员）上的诊断。宿主仍按注册顺序应用过滤器。
  - newtype 构造器只能直接调用（以及出现在 `typeof`、导入、导出中）：旧核心的 `valueUse: "call-only"` 与诊断 18062 在 nominal-types 脱糖时丢失，现在由插件的诊断提供者报告同样的代码与文字。
  - nominal-types 的品牌类原来叫 `Brand`、名字没有源码位置；检查器按声明的源码文本打印符号名，所以凡是不经别名、从符号重建类型的地方（悬停导入的别名或声明文件里的常量、部分诊断）都显示 `Option.(Missing)`。品牌类现在取声明名及其源码范围（`Option.Option`、`UserId.UserId`），兼容 `.d.ts` 随之一致。
  - `.d.tspp` 中的 kind 注解按旧 emitter 的形式写出：宇宙都带层级（`F: Type => Type` 写成 `F: Type0 => Type0`），单个构造器形参加括号（`(Type0 => Type0) => Type0`）。type-computation 记录注解的源码范围，恢复声明文本时替换。

**进度记录（2026-11-02，核心继续收缩）**

- `core-diff`：24 个上游文件 +294 −44，无标记 hunk 0 个（之前为 26 个文件 +369 −47）；预算降为 25 个文件 +305 −48。`checker.ts` 从 +75 −5 降到 +20 −4，只剩类型层扩展（导入、宿主创建、`getTypeFromTypeNodeWorker`、`instantiateTypeWorker`、节点构造器、`isTypeParameterPossiblyReferenced`）、`.tspp` 扩展名一处，以及接口成员契约的两处一行调用点（`getSymbolsInScope` 的静态性、修饰符语法检查）；不再含 `staticInterface` 等特性词。`diagnosticMessages.json` 回到上游原文。
- 接口成员契约：`getStaticInterfaceType` 与 `implements` 的静态侧检查移入 static-interface-members 的诊断提供者，消息 18074 归插件，文字、展开与位置不变（包括实例成员与静态契约成员同名时报在实例成员上的 2416）。诊断提供者新增第三个参数 `TSPPTypeOperations`（类型层扩展宿主也实现它）：`getTypeWithThisArgument`、`createObjectType`、`getIntersectionType`、`getAssignabilityError`，以及原有的 mapper 操作；宿主按 `TypeCheckerHost`（即程序）查到对应 checker 的操作，`program.ts` 的调用点改传程序。契约简化为 `{ modifier: "static" }`，binder、名字解析与语法检查的调用点改名为 `isTSPPStaticContractMember`。兼容 `.d.ts` 中省略静态成员改由插件的 `restoreCompatibilityDeclaration` 完成，emitter 的两处调用点删除。插件改为同时注册契约、诊断提供者与一个只做声明恢复的语法扩展。
- 表达式改写插槽删除（核心、注册表、SDK 的 `registerExpressionRewriter`、`TSPPExpressionRewriter`、`TSPPExpressionRewriteContext`、文档）。operator-sections 改用语法扩展新增的两个位置：`primary-expression`（`parsePrimaryExpression` 开头，所以 `(_ + 1)(2)`、`-(_ + 1)` 仍按原样解析）与 `argument`（`parseArgumentExpression` 内的整个实参，一行改动）。是否构成 section 先由 token 预筛（含 `_`、正则或模板时才继续），再在前瞻中解析判断，前瞻期间嵌套的括号与实参按原样解析，嵌套深度只带来线性开销。参数与替换占位符的引用都是带占位符源码位置的生成名（`getGeneratedNameForNode`），JavaScript 输出 `__p_0` 等名字，因而 emitter 中打印改名标识符的调用点删除。`inferFromUsage.ts` 中 JSDoc 目标的守卫还原；参数守卫保留并改标为 `syntax-extension`：section 的参数与它的引用共用源码位置，代码修复在该位置拿到的是引用。
- `getSymbolAtLocation` 中"`=>` 的父节点不是函数时不返回符号"的检查器调用点还原。改为 `services/tspp/syntax.ts` 把插件语法节点之间的所有标点与关键字也标为 Synthesized（名字与字面量原来就是），公共检查器 API 不再把 kind 注解里的 `=>` 当作函数箭头。逐个 token 对比全部示例的悬停、高亮、定义、引用与重命名，只有类型构造器 `<T> =>> T` 的 `=>` 上不再出现空悬停与跳到构造器开头的定义。
- 诊断 18086 删除：解析器游标的 `parseErrorAt`、类型层扩展宿主的 `error` 与插件解析抛错时的语法错误改用 `compiler/tspp/registry.ts` 的 `createTSPPDiagnosticMessage(code)` 构造消息；插件不给错误码时仍是 18086，现有错误码不变。type-computation 的 kind 错误恢复原来的错误码：18072（kind 不符）、18073（构造器实参个数不对）、2315（"不是泛型"，TypeScript 自己的错误码），撤销上文第 8 步记录的错误码差异。
- 无源码位置的回退：`transformers/declarations.ts` 的守卫还原（重建宿主已把替换语句标为解析树节点，所有示例的声明输出照常）。`getErrorSpanForNode`、`createTextSpanFromNode`、`findAllReferences` 的 `getTextSpan` 与文档高亮四处保留并改标为 `syntax-extension`：nominal-types、dependent-types、formal-verification、type-computation 与宏的降级都会构造不对应源码文本的辅助节点（标签名、辅助字面量、描述符、被检查类型的副本、生成的语句），服务把它们当作合成子节点；给它们源码范围会与用户指向的 token 重叠。删掉这些回退后，02、03、04、05、09、10 六个示例与插件错误夹具上的诊断、定义、引用、高亮与导航树都会崩溃。
- 行为差异：spread 实参 `f(..._)` 不再被改写（原来输出无效的 JavaScript），`_` 按普通名字解析；section 括号前的 JSDoc 不再附到生成的括号上；section 的参数在 JavaScript 中叫 `__p_0`（原来 `__p0`）；只请求区域诊断（`nodesToCheck`）时不运行诊断提供者，静态侧错误在完整诊断中出现。
- 顺带修复：type-computation 的 `restoreCompatibilityDeclaration` 在声明输出把推断类型写成类型引用（如 `export const user = new User()`）时会因为找不到源文件而崩溃。

**进度记录（2026-11-02，插件之间的加法关系）**

架构评估发现几处插件之间仍是乘法关系，都已处理，并由 `integration/test/composition.test.cjs` 守住（两两组合，且断言错误确实报出；另有一个用例在不同加载顺序下比较诊断、输出与悬停）：

- **语法只在 `.tspp` 中存在**（规则 5 由"零插件"收紧为"`.ts` 即上游"）。语法扩展、投影、接口成员绑定、类型层扩展、诊断提供者和 Quick Info 都在宿主判断文件名；`parser.ts` 的调用点多传一个 `fileName`。
- **`type X: T` 的归属冲突**：dependent-types 用正则抢先处理 `type X: ...`，于是 type-computation 的 `type T: Type = { a: number }` 被投影成 `any`，类型错误消失。按"关键词冲突就换关键词"，依赖类型别名改写成 `type X :: T = ...`（**语言面的破坏性变更**），`:` 归 type-computation。右侧是 MLTT 语法，不是 TS 节点，所以别名仍走投影，没有改走注解插槽。
- **FV 不再自带 TypeScript**：删除对 `typescript` 5.9.3 的运行时依赖，经 `context.ts` 用宿主的解析器解析文件（文件名带 `.verification.tspp` 后缀以保留 `assert`/`assume` 标签语句），于是看到的是所有插件脱糖后的 TS。证明器新增立即调用函数、条件表达式、按标签测试读取位置字段（nominal-types API 新增 `valuesProperty`），`let`、`do`、`match` 可以被验证；带泛型或 kind 参数的函数可以写契约。分析器输入删除 `root` 与 `syntaxKinds`。ESLint 禁止插件在运行时导入 TypeScript 包。
- **投影不再串行、不再读字符串**：每个预处理器都拿到原文，宿主合并；两个插件对同一段文本改写不同时，按插件 id 取第一个并报诊断。SDK 新增 `maskNonCode`，插件在抹掉字符串、注释和正则之后的文本上搜索。
- **宿主按归属分发**：宿主记录每个语法节点由哪个插件解析、每段投影文本由哪个插件改写（`getTSPPSyntaxOwners`）。`filterDiagnostic` 只收到本插件语法内的诊断；`restoreDeclaration` 只回答本插件的节点，其他节点至多一个插件回答，否则报错；Quick Info 先问所有者，再按插件 id 问其余插件，并告知 `owned`；同一 token 两个 `isStart` 同时成立时报语法错误。预处理器、诊断提供者、重建器、分析器都按插件 id 排序。
- **冲突检查看真实注册**：语法扩展声明 `keywords`、预处理器声明 `claims`，宿主在激活时拒绝第二个认领者；`relations.test.cjs` 比较清单与实际注册，两者必须一致。清单位置改用插槽名。
- **插槽形状**：`registerInterfaceMemberContract({ modifier: "static" })` 改为 `registerInterfaceMemberBinding({ keywords, isStaticMember })`，判断逻辑回到插件；`restoreFunctionWithClause` 改名 `restoreFunctionClause`；`TSPPPreprocessedTypeAlias.annotation` 包含自己的分隔符。SDK API 版本升到 3。
- **门槛**：`core-diff --check` 新增单个 hunk 超过 15 行即失败，只有解析器游标是登记过的例外。
- 顺带修复：kind 注解里的名字（`Kind: Type1`）上做引用查找会触发 `getMeaningFromLocation` 的断言；此前全插件环境下 dependent-types 把这些别名抢走了，所以没有暴露。

**进度记录（2026-11-02，类型层统一）**

dependent-types 并入 type-computation（"互相依赖就合并"，HKT 是先例）：写法统一成 `type X: K = ...`，撤销 `::`；类型层 `typecase` 并入 `match`，表达式层的 `typecase` 只留给运行时 `reify`。

- MLTT 核心（`core/`）一行没改，也不依赖 TS；依赖方向是新增的翻译层依赖它。
- 项在解析时由语法扩展读出（`TermParser` 同时接受文本和解析器游标），`lower.ts` 用节点把它们交给 TS。不再有文本投影，也就不再有放不下时退回 `any` 的路径（`typecase number {...}` 变成 `any` 的 bug 即此）。
- `match` 无论在项内外都降级为条件类型，由 TS 按可赋值性判断，不再有两种语义。
- kind 相等由内核的定义相等判断，kind 可以是项：`Vec: Nat => Type`，`Vec<string>` 报 kind 错误。字面量类型代表它写出的值（`2` 的 kind 是 `Nat`）。
- 内核的错误经诊断提供者报告，和检查器错误一样；分析器只产出规范形。项里写错的名字报 `Cannot find name`。
- 文件自己声明或导入的同名类型优先于内置项（`type Pair<L, R>` 不受影响）。

随后补上的部分（核心第一次改动，两处，都在 `core/`）：

- 外部类型不再被判定为"不相等"：没有宿主比较器时，内容不同的外部类型比较结果是"卡住"。`match` 只在类型相同时由内核化简，内核不会得出和 TS 按可赋值性判断相反的结论；代价是一些证明走不通。带参数注解的 lambda 现在可以推断类型。
- `Lam` 删除，统一成 `<x: K> =>> body`，`If`、`BoolElim` 的 motive 不再需要 `Ann`。参数都是值（kind 为项）时是内核计算的函数（`Inc<Two>` 得 `3`），否则是 TS 实例化的类型构造器。
- 绑定类型构造器的 binder（`P: Nat => Type0`）降级成带 kind 的类型参数，`P<n>` 是普通的高阶应用。TS 仍表达不了的部分是 `unknown`，分析器报警告 19103。
- 跨文件：诊断和类型解析都通过 checker 查名字（`resolveTermNames`），项能看到其他文件和同文件后面的别名、类型参数的 kind；结果是自然数或布尔值时在检查阶段算出字面量。

已知限制：导入的函数别名（`Inc`）不能在别的文件里应用，因为应用是解析时算的；计算结果不是自然数或布尔值时，导入别名只作为 TS 类型参与；全局声明的同名类型仍被内置项盖住（文件内声明和导入的不会）。

**进度记录（2026-11-02，加法关系的第二轮评估）**

用真实 CLI 跑组合，发现进程内测试看不到的问题，都已修复：

- **宏 worker 只加载宏插件。** worker 从原文重新解析项目，却读不懂其他插件的语法：宏作用在 `data`/`newtype` 上报 `Target could not be resolved`，宏函数体里写 `let`、`match` 报语法错误。进程内测试不走 worker，所以一直是绿的。程序重建请求新增 `pluginModulePaths`（宿主从已加载模块里找到激活插件的路径），worker 先加载它们；找不到路径时在当前线程展开。
- **形式验证把 `as never` 都当作不可达。** 这本来是为 `match` 的降级准备的，但用户写的 `v > 3n ? 10n : (0n as never)` 也能"证明"错误的后置条件。nominal-types API 新增 `isMatchEnd`，只有 `match` 生成的结尾才算不可达；用户写的断言现在报不支持。
- **`match` 的对象是属性访问时必定误报。** `match v.a { A(x) => x, B => 0 }` 报 `Pattern 'A' does not belong`，与其他插件无关。诊断用的引用取自最后一个分支，已被前面的分支收窄，属性名上也取不到符号。现在取第一个分支测试里的引用，并按对象类型查属性。
- **type-computation 写死 `data|newtype`。** 改用 SDK 新增的 `getSyntaxKeywords("declaration")`。
- **编辑器知道具体插件。** `editor` facet 的 `commands` 换成 `artifactViews` 与 `overlayViews`；VS Code 与 playground 由它们生成命令、输出标签和悬停，`getMacroExpansions` 不再被宿主直接调用。产物类型 `dependent-types/normal-form` 改为 `type-computation/normal-form`。playground 的插件列表来自 `package.json`。
- **加载顺序。** 声明恢复和类型扩展也按插件 id 排序。

新增护栏见 `docs/plugin-framework.md` 的 "What keeps plugins additive"；CI 新增 TS++ 编译器单测、编译器 lint、ESLint 规则测试和 knip。

已知限制：形式验证读作者原文，看不到宏生成的代码，引用宏生成的变量时报 `Unknown proof variable`（不会证明出错误结论）。

## 风险与待定

- **类型层特性可能无法完全迁出。** HKT、类型宇宙、类型构造器需要介入 checker 的类型解析和实例化。若通用插槽设计不出来，需要明确记录为"受控例外"，并限定在一个文件内。结果：第 8 步用通用的"类型层扩展"插槽完成，没有使用受控例外（见进度记录）。
- **插件开始依赖 TS 公共 API。** 升级上游 TS 时插件可能需要适配；但这本来就是"只和 TS 耦合"的含义，且比现在核心里的改动好升级得多。
- **脱糖可能改变编辑器体验。** 悬停文本、诊断位置、重命名等以前修过不少问题，迁移时必须有 language-server 测试兜底。
- **进程级注册表。** 现在一个 tsserver 进程只能有一套插件。推迟到阶段 3 之后处理，但新插槽的接口不得进一步依赖全局状态。
