# TS++ Playground

浏览器演练场在独立 Web Worker 中运行编译器和选定的特性胶囊。切换胶囊时会重启 Worker，
避免进程级语法注册在不同配置之间泄漏。页面同时展示诊断和供上游工具使用的 TypeScript 投影。

The browser playground runs the compiler and selected feature capsules in a fresh Web Worker.
Changing the capsule selection restarts the worker, so process-global parser registrations never
leak between configurations. It displays both diagnostics and the TypeScript projection used by
upstream tooling.

编译期宏通过编译器宿主在 Worker 内执行。形式验证使用嵌套的浏览器 Z3 Worker，
首次出现证明任务时才加载 Wasm。因此页面需要跨源隔离：开发与预览服务器会发送所需响应头，
生产构建则提供 Service Worker 回退，以支持 GitHub Pages 等静态托管环境。

Compile-time macros execute inside the compiler Web Worker through the compiler host boundary.
Formal verification uses a nested browser Z3 worker and loads its Wasm only after the first proof
obligation. The page therefore needs cross-origin isolation; the development and preview servers
send the required headers, while the production build includes a service-worker fallback for static
hosts such as GitHub Pages.

每个浏览器项目都包含实际的 `tsppconfig.json`。Features 面板用于快捷编辑
`compilerOptions.plugins`，两种编辑方式会同步更新，语言 Worker 会应用编译选项、
包含规则和插件选择。配置冲突会显示为项目诊断。Run 支持 ES 模块及浏览器中的 CommonJS/Node
加载器；不支持的模块格式会显示原因。`noEmit` 仍适用于实际 CLI 构建，用户显式打开 Outputs
或执行 Run 时可以在内存中生成产物，不写入文件。

Each browser project contains its real `tsppconfig.json`. The Features panel is a shortcut editor for
`compilerOptions.plugins`; editing either side updates the other, and compiler options, include
patterns, and plugin selection are applied by the language worker. Configuration incompatibilities
are reported as project diagnostics. Run supports ES modules plus a browser-hosted CommonJS/Node
loader, and blocks unsupported module formats with an explanation instead of silently overriding
them. `noEmit` still applies to the real CLI build, while the explicitly requested Outputs and Run
views may emit in memory without writing files.

```sh
pnpm playground:dev
pnpm build:playground
```

部署站点的根路径会跳转到 `v/<version>/` 下的最新稳定版；首个稳定版发布前则跳转到 `master/`。
版本选择器列出可用版本以及 `master/`、`dev/` 分支预览。站点组装方式见 `docs/releasing.md`。
单独提供服务的构建产物（例如解压后的发布包）不包含版本选择器。

The deployed site's root redirects to the latest stable release under `v/<version>/`, or to `master/`
before the first stable release. The version selector lists available releases and the published
branch previews at `master/` and `dev/`. See `docs/releasing.md` for how the site is assembled.
A build on its own, such as a release's zip served from any directory, has no selector.
