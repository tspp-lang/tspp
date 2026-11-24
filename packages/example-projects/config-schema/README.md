# Config Schema / 配置模式

[中文](#中文) | [English](#english)

## 中文

**Config Schema**（`@tspp/config-schema`）是一个用 TS++ 编写的**类型安全配置加载库**。它把默认值、JSON 文件和环境变量按层合并，再用模式（schema）校验，一次性报告所有问题，并指出每个问题出在哪个键、来自哪个文件或环境变量：

```text
Invalid configuration:
  server.port: expected a port from 0 to 65535, got "eighty" (from config.json)
  server.hots: unknown key; did you mean "host"? (from config.json)
  log.level: expected one of "debug", "info", got "verbose" (from APP_LOG__LEVEL)
  database: missing required key
```

也可以直接写 interface，让编译期宏 `deriveSchema` 生成对应的模式。

### 1. 安装与构建

准备好[仓库开发环境](../../../README.zh-CN.md)后，在仓库根目录构建本库：

```sh
pnpm --filter @tspp/config-schema build
```

在需要使用它的项目 `package.json` 中添加工作区依赖：

```json
{
  "dependencies": {
    "@tspp/config-schema": "workspace:*"
  }
}
```

普通 TypeScript 项目通过 `.d.ts` 使用本库的全部运行时 API。要调用宏 `deriveSchema`，TS++ 项目只需在 `tsppconfig.json` 里启用 `ts-plus-plus/plugins/macros`：每个 `.d.tspp` 文件只要求它自己用到的插件，宏所在的文件只用到宏插件。

### 2. 快速上手

```ts
import { deriveSchema, Duration, Port, layer, loadConfigOrThrow, environmentLayer } from "@tspp/config-schema";
import { jsonFileLayer } from "@tspp/config-schema/node";

export interface AppConfig {
  server: {
    host: string;
    port: Port;
  };
  /** How long a request may take. */
  timeout?: Duration;
  log: { level: "debug" | "info" | "warn" };
  allowedOrigins: readonly string[];
}

// 编译期生成 `export const AppConfigSchema: Schema<AppConfig>`
macro deriveSchema(AppConfig);

export const config = loadConfigOrThrow(AppConfigSchema, [
  layer("defaults", { server: { host: "127.0.0.1", port: 8080 }, log: { level: "info" }, allowedOrigins: [] }),
  jsonFileLayer("config.json", { optional: true }),
  environmentLayer(AppConfigSchema, process.env, { prefix: "APP_" }),
]);
```

`APP_SERVER__PORT=9000` 会覆盖 `server.port`，`APP_TIMEOUT=30s` 会设置 `timeout`。

### 3. API 速查

| 类别 | API |
| --- | --- |
| 基本模式 | `string()`、`number()`、`integer()`、`boolean()`、`unknown()`、`literal(v)`、`oneOf(...values)` |
| 组合模式 | `object(shape, { unknownKeys })`、`array(item)`、`record(value)`、`optional(schema)`、`union(...schemas)` |
| 模式方法 | `decode(input)` 返回 `Valid(value)` 或 `Invalid(issues)`；`parse(input)` 失败时抛出 `ConfigError`；`refine(check, message)`；`describe(text)` |
| 值类型 | `of(Duration)`（`500ms`、`1h30m`）、`of(ByteSize)`（`512KB`、`10MiB`）、`of(Port)`（0–65535） |
| 分层加载 | `layer(name, values)`、`environmentLayer(schema, env, options)`、`jsonFileLayer(path)`（`/node`）、`loadConfig`、`loadConfigOrThrow` |
| 文档 | `explain(schema)` 列出所有设置项，`formatSettings` 排成对齐的表格 |
| 宏 | `macro deriveSchema(Interface)` 生成 `<Interface>Schema` |

`Infer<typeof schema>` 是模式解码出的类型。

### 4. 规则与细节

- **对象**：默认拒绝未声明的键，键名相近时给出“did you mean”建议；传 `{ unknownKeys: "ignore" }` 可以忽略未声明的键。解码得到的对象和数组都会冻结，可选键缺失时结果里也没有这个键。
- **分层**：普通对象逐键合并，数组和其他值整体替换。值被拒绝时，问题会带上提供该值的层或环境变量名。缺失的键没有来源，所以不标注。
- **环境变量**：去掉前缀后按分隔符（默认 `__`）切分，每一段按字母和数字（不区分大小写）匹配模式里的键，如 `MAX_CONNECTIONS` 匹配 `maxConnections`。文本按该路径上的模式转换：数字、`true`/`false`/`1`/`0`、JSON 数组和对象。转换不了就保留原文本，由模式报告错误。匹配不到的段会变成驼峰键，再作为未知键报告，因此拼错的变量名也会被发现。
- **值类型**：`Duration` 是非负整数毫秒，支持 `ms s m h d` 和组合写法；`ByteSize` 区分十进制（`KB` = 1000）与二进制（`KiB` = 1024）单位，结果必须是整数字节；`Port` 接受 0–65535，环境变量里的数字文本也接受。它们都按精确算术换算，`1.1MB` 就是 1100000 字节。
- **`deriveSchema`**：属性变成键，JSDoc 注释变成描述，`?` 表示可选键，字面量联合变成 `oneOf`，`readonly T[]`/`ReadonlyArray<T>` 变成 `array`，`Record<string, T>` 变成 `record`，嵌套的 interface 和类型别名就地展开，`Duration` 这样的类变成 `of(Duration)`。目标导出时，生成的常量也会导出。以下写法宏会拒绝并说明原因：方法、泛型、递归类型、可变数组（解码结果是冻结的）、没有 `?` 的 `T | undefined`（JSON 里没有 undefined）。生成的常量带有 `Schema<Interface>` 类型标注，所以模式解码结果与 interface 是否一致由类型检查器确认。类要在调用宏的文件里可见。

### 5. TS++ 的实际用途

- **类型计算**（type-computation）：`ObjectOf` 用类型级 `let` 和 `match` 从对象形状算出输出类型，可选模式对应的键在输出里也是可选的。
- **接口静态成员**（static-interface-members）：`ConfigValue` 要求值类同时提供 `static label` 和 `static decode(input): Decoded<this>`，`Duration`、`ByteSize`、`Port` 都由 `implements` 检查。
- **编译期宏**（macros）：`deriveSchema` 读取 interface 的声明，生成模式和它需要的导入。生成代码通过自己的别名导入引用本库，不依赖调用方的导入。
- **名义类型与代数数据类型**（nominal-types）：`Decoded` 和模式结构 `Structure` 用 `data` 声明，并用穷尽的 `match` 处理；`Issue` 是 `data class`（advanced-classes）。值类是 `final class`，许多函数用 `do` 函数体（modern-syntax）。

### 6. 开发与测试

```sh
pnpm --filter @tspp/config-schema check
pnpm --filter @tspp/config-schema test
```

`test/fixture` 是一个按包名导入本库、只启用宏插件的使用方项目。宏测试会编译它，然后用生成的模式解码数据。

---

## English

**Config Schema** (`@tspp/config-schema`) is a **typed configuration loader** written in TS++. It merges defaults, JSON files, and environment variables as layers, validates the result against a schema, and reports every issue at once, naming the key and the file or variable each rejected value came from:

```text
Invalid configuration:
  server.port: expected a port from 0 to 65535, got "eighty" (from config.json)
  server.hots: unknown key; did you mean "host"? (from config.json)
  log.level: expected one of "debug", "info", got "verbose" (from APP_LOG__LEVEL)
  database: missing required key
```

You can also write an interface and let the compile-time macro `deriveSchema` generate the matching schema.

### 1. Build and Install

After preparing the [repository development environment](../../../README.md), build the library from the repository root:

```sh
pnpm --filter @tspp/config-schema build
```

Add a workspace dependency to the `package.json` of the project that uses it:

```json
{
  "dependencies": {
    "@tspp/config-schema": "workspace:*"
  }
}
```

Plain TypeScript projects use the whole runtime API through `.d.ts` files. To invoke the `deriveSchema` macro, a TS++ project only needs `ts-plus-plus/plugins/macros` in its `tsppconfig.json`: each `.d.tspp` file requires only the plugins it uses itself, and the macro's file uses only the macros plugin.

### 2. Quick Start

```ts
import { deriveSchema, Duration, Port, layer, loadConfigOrThrow, environmentLayer } from "@tspp/config-schema";
import { jsonFileLayer } from "@tspp/config-schema/node";

export interface AppConfig {
  server: {
    host: string;
    port: Port;
  };
  /** How long a request may take. */
  timeout?: Duration;
  log: { level: "debug" | "info" | "warn" };
  allowedOrigins: readonly string[];
}

// Generates `export const AppConfigSchema: Schema<AppConfig>` at compile time
macro deriveSchema(AppConfig);

export const config = loadConfigOrThrow(AppConfigSchema, [
  layer("defaults", { server: { host: "127.0.0.1", port: 8080 }, log: { level: "info" }, allowedOrigins: [] }),
  jsonFileLayer("config.json", { optional: true }),
  environmentLayer(AppConfigSchema, process.env, { prefix: "APP_" }),
]);
```

`APP_SERVER__PORT=9000` overrides `server.port`, and `APP_TIMEOUT=30s` sets `timeout`.

### 3. API Quick Reference

| Category | API |
| --- | --- |
| Basic schemas | `string()`, `number()`, `integer()`, `boolean()`, `unknown()`, `literal(v)`, `oneOf(...values)` |
| Composite schemas | `object(shape, { unknownKeys })`, `array(item)`, `record(value)`, `optional(schema)`, `union(...schemas)` |
| Schema methods | `decode(input)` returns `Valid(value)` or `Invalid(issues)`; `parse(input)` throws a `ConfigError`; `refine(check, message)`; `describe(text)` |
| Value types | `of(Duration)` (`500ms`, `1h30m`), `of(ByteSize)` (`512KB`, `10MiB`), `of(Port)` (0–65535) |
| Layered loading | `layer(name, values)`, `environmentLayer(schema, env, options)`, `jsonFileLayer(path)` (`/node`), `loadConfig`, `loadConfigOrThrow` |
| Documentation | `explain(schema)` lists every setting; `formatSettings` aligns them as a table |
| Macro | `macro deriveSchema(Interface)` generates `<Interface>Schema` |

`Infer<typeof schema>` is the type a schema decodes to.

### 4. Rules and Details

- **Objects**: keys the schema does not declare are rejected by default, with a "did you mean" suggestion for near misses. Pass `{ unknownKeys: "ignore" }` to ignore them. Decoded objects and arrays are frozen, and a missing optional key stays absent from the result.
- **Layers**: plain objects merge key by key; arrays and other values replace earlier ones whole. Each rejected value names the layer or environment variable that provided it. Missing keys have no origin, so they are not attributed.
- **Environment variables**: after the prefix is removed, a name is split at the separator (`__` by default). Each part selects the schema key whose letters and digits match it regardless of case, so `MAX_CONNECTIONS` selects `maxConnections`. The schema at that path converts the text: numbers, `true`/`false`/`1`/`0`, and JSON arrays and objects. Text it cannot convert is kept for the schema to report. Parts that match no key become camel-case keys, which are reported as unknown keys, so misspelled variable names are caught too.
- **Value types**: `Duration` is a non-negative whole number of milliseconds written with `ms s m h d`, alone or combined. `ByteSize` distinguishes decimal (`KB` = 1000) from binary (`KiB` = 1024) units and must come to a whole number of bytes. `Port` accepts 0–65535, including digit text from the environment. Unit conversions are exact, so `1.1MB` is exactly 1,100,000 bytes.
- **`deriveSchema`**: properties become keys, JSDoc comments become descriptions, `?` makes a key optional, literal unions become `oneOf`, `readonly T[]`/`ReadonlyArray<T>` become `array`, `Record<string, T>` becomes `record`, nested interfaces and type aliases are written out in place, and classes such as `Duration` become `of(Duration)`. When the target is exported, so is the generated constant. The macro rejects the following with an explanation: methods, generics, recursive types, mutable arrays (decoded arrays are frozen), and `T | undefined` without `?` (JSON has no undefined). The generated constant is annotated `Schema<Interface>`, so the type checker confirms that the schema decodes what the interface describes. Classes must be in scope in the file that invokes the macro.

### 5. TS++ in the Library

- **Type computation** (type-computation): `ObjectOf` uses type-level `let` and `match` to compute the output type of an object shape; keys of optional schemas are optional in the output.
- **Static interface members** (static-interface-members): `ConfigValue` requires value classes to provide both `static label` and `static decode(input): Decoded<this>`; `implements` checks `Duration`, `ByteSize`, and `Port`.
- **Compile-time macros** (macros): `deriveSchema` reads an interface's declaration and generates the schema along with the imports it needs. Generated code refers to this library through aliased imports of its own, without relying on the caller's imports.
- **Nominal types and algebraic data types** (nominal-types): `Decoded` and the schema `Structure` are `data` declarations handled with exhaustive `match`. `Issue` is a `data class` (advanced-classes). Value classes are `final class`es, and many functions use `do` bodies (modern-syntax).

### 6. Development

```sh
pnpm --filter @tspp/config-schema check
pnpm --filter @tspp/config-schema test
```

`test/fixture` is a consumer project that imports this library by its package name and enables only the macros plugin. The macro tests compile it and decode data with the schema it generates.
