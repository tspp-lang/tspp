# TS++ 示例项目 / Example Projects

[中文](#中文) | [English](#english)

## 中文

这里存放使用 TS++ 开发的完整软件。每个项目独立管理实现、测试、文档和依赖，
持续解决实际问题，并通过真实开发检验语言特性。简短的语法教学放在
[examples](../examples/README.md)。

### 开发原则

1. **按实际软件维护。** 项目应有明确用途和可实际使用的功能，按正常软件组织源码、入口、依赖、
   构建和文档。通用库与用途独立的应用分别成项目，通过工作区依赖组合，不把无关业务塞进库。
   每个项目默认使用一份 `tsppconfig.json`；拆分构建应由实际部署或运行需求驱动，不另设演示版本。
2. **围绕需求独立实现。** 可以借鉴开源软件解决的问题和功能需求，自行设计 API 与实现。
   功能重写不复制原项目的实现、类型声明或测试，也不默认追求其 API 和细节兼容。
3. **在真实开发中使用 TS++。** 在适合的业务和架构位置充分使用语言特性，改善代码表达与维护；
   不为凑齐语法展示而引入无用抽象或复杂度。
4. **查清编译失败的原因。** 保留原始错误并缩小复现，判断是工具链缺陷还是项目写法有误。
   工具链缺陷在对应包修复并添加回归，项目错误在项目内修正；不通过关闭检查、滥用类型断言或
   悄悄改变业务行为来掩盖问题。
5. **测试项目承诺的行为。** 测试服务于项目功能、公开 API 和业务逻辑，包括承诺的输入校验与
   错误处理。编译器边界、插件组合、类型反例、声明兼容与回退等专项验证放在对应工具链包中，
   不在这里建立独立的语言测试体系或专项配置。
6. **同步维护中英文说明。** 所有 README 均提供完整中文和完整英文分块；功能、构建方式和
   使用命令变化时同步更新。

### 项目

| 项目 | 用途 |
| --- | --- |
| [command-kit](./command-kit/README.md) | 帮助开发者编写命令行应用的工具库 |
| [local-ip](./local-ip/README.md) | 查看本机网卡与 IP 地址，支持筛选和 JSON 输出 |

---

## English

This directory contains complete software built with TS++. Each project independently
maintains its implementation, tests, documentation, and dependencies, solving practical
problems while exercising language features through real development. Short syntax
tutorials live in [examples](../examples/README.md).

### Development Principles

1. **Maintain real software.** Each project must have a clear purpose and usable
   features, with normal source, entry points, dependencies, builds, and documentation.
   General-purpose libraries and applications with independent purposes are separate
   projects connected through workspace dependencies. Keep unrelated business logic
   out of libraries. Use one `tsppconfig.json` per project by default; separate builds
   must serve actual deployment or runtime needs, without separate demo versions.
2. **Implement independently around requirements.** Projects may draw on the problems
   and functional needs addressed by open-source software, while designing their own
   APIs and implementations. Functional rewrites do not copy upstream implementations,
   type declarations, or tests, and do not aim for API or behavioral-detail compatibility
   by default.
3. **Use TS++ in real development.** Apply language features where they fit the domain
   and architecture, improving code expression and maintenance. Avoid abstractions or
   complexity introduced merely to showcase syntax.
4. **Investigate compilation failures.** Preserve original errors and reduce failing
   cases to determine whether the toolchain or project code is responsible. Fix
   toolchain defects and add regressions in the appropriate packages; fix project
   mistakes within the project. Do not hide problems by disabling checks, misusing
   type assertions, or silently changing application behavior.
5. **Test the project's promised behavior.** Tests cover features, public APIs, and
   business logic, including promised input validation and error handling. Compiler
   boundaries, plugin combinations, negative type cases, and declaration compatibility
   or fallback checks belong in the corresponding toolchain packages. Do not create
   a separate language conformance suite or dedicated configurations for them here.
6. **Maintain Chinese and English documentation.** All READMEs must provide complete
   Chinese and English blocks. Update both whenever features, build instructions, or
   usage commands change.

### Projects

| Project | Purpose |
| --- | --- |
| [command-kit](./command-kit/README.md) | A library for developers building command-line applications |
| [local-ip](./local-ip/README.md) | Inspect local interfaces and IP addresses with filtering and JSON output |
