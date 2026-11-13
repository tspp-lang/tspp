# TS++

[English](README.md) | 简体中文

TS++（`ts-plus-plus`，简称 TSPP）是一门衍生自 TypeScript 的实验性编程语言与编译器。本仓库基于 TypeScript 6.0.3 源码树构建，在将 TypeScript 作为兼容性边界保留的同时，把 TS++ 作为独立产品进行开发。

本项目通过相互隔离的“特性胶囊（feature capsules）”进行演进。每个特性独立拥有自身的语法、语义分析、语言服务扩展以及编辑器元数据；共享包仅提供加载机制与精简的 SDK 契约，从而避免在衍生自 TypeScript 的核心代码中堆积大量的特性分支。

👉 **想要了解现有特性？** 请查阅 [**TS++ 特性与插件目录**](docs/features.md)，全面了解当前 8 个活跃特性胶囊的概览、语法规范与开发状态。

## 仓库结构

```text
.
└─ packages/
   ├─ compiler/          # 衍生自 TypeScript 的 TS++ 编译器与 tsserver
   ├─ example-projects/  # 用 TS++ 开发的完整软件，独立实现、测试与维护
   ├─ examples/          # 按插件集划分、各自独立配置的示例项目
   ├─ language-server/   # 围绕 TSPP 服务器协议封装的 LSP 适配器
   ├─ playground/        # 基于 Worker 隔离特性胶囊集的浏览器端编译器与演练场
   ├─ plugin-sdk/        # 供各独立插件包共享的公共契约（SDK）
   ├─ plugins/           # 每个完整特性胶囊对应一个独立包
   └─ vscode-extension/  # TSPP 语言服务器的 VS Code 客户端扩展
```

完整软件项目见 [示例项目目录](packages/example-projects/README.md)，简短的语法教学仍位于 `packages/examples/`。

## 开发指南

请使用 Node.js 22 和 pnpm 12.4.2。

```sh
corepack enable
pnpm install
pnpm build
pnpm lint
pnpm test
pnpm playground:dev
```

## 命令与架构说明

`compiler` 包暴露了两个命令：

- `tspp` — TS++ 命令行编译器；
- `tsppserver` — 采用上游 `tsserver` 协议的 TSPP 编译器服务。

独立的 LSP 包暴露了 `tspp-language-server` 命令，用于将该协议适配为标准 LSP 协议。VS Code 扩展会使用工作区中的 `ts-plus-plus` SDK 启动该 LSP，并将 `.tspp` 文件关联到 `tspp` 语言模式。

编译器扩展统一使用 `@tspp/plugin-sdk`。目前该 SDK 涵盖了表达式、语句、声明与类型语法扩展、源码投影（source projection）、异步程序分析与产物生成、编译期宏、语义悬停提示（Quick Info）、激活依赖管理以及静态编辑器贡献点。只有当真实特性明确验证了所需的边界时，才会向 SDK 中添加新的扩展端口。

各个特性项目通过 `compilerOptions.plugins` 选择需要启用的特性胶囊。宿主环境会校验必需依赖与可选依赖关系，拒绝声明了冲突语法的插件，按依赖拓扑顺序激活胶囊，并确保具体特性的代码不会侵入 LSP 和 VS Code 客户端。

在仓库开发过程中，请先构建编译器，再调用其生成的产物。根目录下的脚本会自动代理至 `ts-plus-plus` 工作区执行。

## TypeScript 兼容性边界

TS++ 项目使用 `tsppconfig.json`，普通 TypeScript 项目继续使用 `tsconfig.json`。

TS++ 有意保留了上游的内部命名，例如 `ts` 命名空间、`typescript.js` 以及 `tsserver` 协议。这些名称描述的是 TypeScript API 及兼容性表面，而非 TS++ 的公开产品名称。保持这一边界的稳定，也使得未来与上游源码进行比对与合并更加可控。

## 许可证与上游声明

TS++ 基于 Apache License 2.0 许可证分发。`compiler` 包保留了上游 TypeScript 的许可证、安全策略及第三方声明。

