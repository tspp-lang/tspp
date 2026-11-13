# TS++ 示例项目 / Example Projects

这里存放使用 TS++ 开发的完整软件。每个项目独立管理实现、测试、使用文档和依赖，
持续解决实际问题，并通过真实开发检验语言特性。

This directory contains complete software built with TS++. Each project independently
maintains its implementation, tests, documentation, and dependencies, solving practical
problems while exercising language features through real development.

简短的语法教学仍放在 [`../examples/`](../examples/README.md)。

Short syntax tutorials remain in [`../examples/`](../examples/README.md).

## 开发原则 / Development Principles

1. **按实际软件维护 / Maintain real software**

   每个项目应有明确用途和可实际使用的功能，按正常软件组织源码、入口、依赖、构建和文档。
   CLI 等功能作为正式组成部分维护，不另设演示版本。默认使用一份 `tsppconfig.json` 统一构建；
   拆分构建应由实际部署或运行需求驱动。

   Each project must have a clear purpose and usable features, with normal software
   structure for source code, entry points, dependencies, builds, and documentation.
   Features such as CLIs are maintained as part of the product, without separate demo
   versions. Use one `tsppconfig.json` by default; separate builds must serve actual
   deployment or runtime needs.

2. **围绕需求独立实现 / Implement independently around requirements**

   可以借鉴知名开源软件解决的问题和功能需求，自行设计 API 与实现。
   功能重写不复制原项目的实现、类型声明或测试，也不默认追求其 API 和细节兼容。

   Projects may draw on the problems and functional needs addressed by established
   open-source software, while designing their own APIs and implementations.
   Functional rewrites do not copy upstream implementations, type declarations, or
   tests, and do not aim for API or behavioral-detail compatibility by default.

3. **在真实开发中使用 TS++ / Use TS++ in real development**

   在适合的业务和架构位置充分使用 TS++ 特性，让语言能力改善实际代码的表达与维护。
   不为凑齐语法展示而引入无用抽象或复杂度。

   Use TS++ features where they fit the domain and architecture, improving how real
   code is expressed and maintained. Avoid abstractions or complexity introduced
   merely to showcase syntax.

4. **查清编译失败的原因 / Investigate compilation failures**

   编译或语言服务出现异常时，保留原始错误并缩小复现，判断是工具链缺陷还是项目写法有误。
   工具链缺陷在对应包修复并添加回归；项目错误在项目内修正。
   不通过关闭检查、滥用类型断言或悄悄改变业务行为来掩盖问题。

   Preserve original errors and reduce failing cases when compilation or language
   services behave unexpectedly. Determine whether the toolchain or project code is
   responsible. Fix toolchain defects and add regressions in the appropriate packages;
   fix project mistakes within the project. Do not hide problems by disabling checks,
   misusing type assertions, or silently changing application behavior.

5. **测试项目承诺的行为 / Test the project's promised behavior**

   测试服务于项目自身的功能、公开 API 和业务逻辑，包括项目承诺的输入校验与错误处理。
   编译器边界、插件组合、类型反例、声明兼容与回退等专项验证放在对应工具链包中，
   不在本目录的项目内建立独立的语言测试体系或专项配置。

   Tests cover the project's features, public API, and business logic, including
   promised input validation and error handling. Compiler boundaries, plugin
   combinations, negative type cases, and declaration compatibility or fallback
   checks belong in the corresponding toolchain packages. Do not create a separate
   language conformance suite or dedicated configurations for those checks here.

6. **同步维护中英文说明 / Maintain Chinese and English documentation**

   所有 README 均提供中文和英文，功能、构建方式和使用命令变化时同步更新两种说明。

   All READMEs must provide both Chinese and English. Update both versions whenever
   features, build instructions, or usage commands change.

## 项目 / Projects

| 项目 / Project | 用途 / Purpose |
| --- | --- |
| [command-kit](./command-kit/README.md) | 命令行开发工具库与仓库查询 CLI / A CLI development library and repository inspection CLI |
