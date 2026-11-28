# Engine / 引擎

[中文](#中文) | [English](#english)

## 中文

**Engine**（`@tspp/engine`）是一个用 TS++ 编写的小型 **WebGPU 引擎**。它的着色器不是 WGSL 字符串，而是普通的 TS++ 函数：编译期宏 `shaderModule` 把一个 namespace 里的函数翻译成 WGSL，同时算出顶点缓冲和 uniform 缓冲的内存布局。这些函数照样能在 CPU 上运行，所以着色器逻辑可以直接做单元测试。

```ts
export namespace Lit {
  export function vertex(input: Vertex, frame: Frame): Surface {
    const world = frame.model.mul(vec4(input.position, 1));
    return { clip: frame.viewProjection.mul(world), world: world.xyz, normal: frame.normalMatrix.mul(input.normal) };
  }

  export function fragment(surface: Surface, frame: Frame): Vec4 {
    const light = max(dot(normalize(surface.normal), frame.light.direction.negate()), 0);
    return vec4(frame.light.color.scale(light), 1);
  }
}

macro shaderModule(Lit); // 生成 LitModule：WGSL 代码 + 缓冲布局
```

引擎分为四个模块，依赖方向自下而上：

| 模块 | 内容 |
| --- | --- |
| `@tspp/engine/math` | 向量 `Vec2`/`Vec3`/`Vec4`、矩阵 `Mat3`/`Mat4`，以及 `mix`、`clamp`、`dot` 等 WGSL 内置函数的 CPU 实现 |
| `@tspp/engine/shader` | 宏 `shaderModule`、`Builtin` 标记、生成结果的类型，以及按布局打包缓冲的 `packVertices`/`writeUniforms` |
| `@tspp/engine/gpu` | `Renderer`、`Pipeline`、`Mesh`、`Uniforms`、`BindGroup`，用着色器的类型约束网格和 uniform |
| `@tspp/engine/scene` | 几何体 `Shape`、轨道相机 `OrbitCamera`、`Transform`、`OrbitControls`、`animate` 循环 |

具体场景和材质属于应用，例如 [scene-viewer](../scene-viewer/README.md)。

### 1. 安装与构建

准备好[仓库开发环境](../../../README.zh-CN.md)后，在仓库根目录构建本库：

```sh
pnpm --filter @tspp/engine build
```

在使用它的项目 `package.json` 中添加工作区依赖，并在 `tsppconfig.json` 中启用宏插件（调用 `shaderModule` 需要）和 DOM 类型（使用 `gpu`、`scene` 需要）：

```json
{ "dependencies": { "@tspp/engine": "workspace:*" } }
```

```json
{
  "compilerOptions": {
    "lib": ["ES2022", "DOM"],
    "plugins": [{ "name": "ts-plus-plus/plugins/macros", "tspp": true }]
  }
}
```

本库是 ES 模块包，由打包工具（如 Vite）交给浏览器。

### 2. 快速上手

先用 interface 描述着色器的输入、输出和 uniform，再在 namespace 里写着色器函数：

```ts
import { dot, max, normalize, type Mat3, type Mat4, type Vec3, type Vec4, vec4 } from "@tspp/engine/math";
import { type Builtin, shaderModule } from "@tspp/engine/shader";

export interface Vertex { position: Vec3; normal: Vec3; }
export interface Surface { clip: Builtin<"position", Vec4>; world: Vec3; normal: Vec3; }
export interface Light { direction: Vec3; color: Vec3; }
export interface Frame { viewProjection: Mat4; model: Mat4; normalMatrix: Mat3; light: Light; }

export namespace Lit { /* 上面的 vertex 和 fragment */ }
macro shaderModule(Lit);
```

然后用 `gpu` 模块绘制。`createPipeline` 会检查 WGSL 编译结果；`Pipeline<Vertex, Bindings>` 只接受同一种顶点类型的网格和同一组绑定的 uniform：

```ts
import { Renderer } from "@tspp/engine/gpu";
import { meshOf, Sphere } from "@tspp/engine/scene";

const renderer = await Renderer.create(canvas);
const lit = await renderer.createPipeline(LitModule);
const mesh = renderer.createMesh(lit, meshOf(Sphere(1, 48, 32)));
const frame = renderer.createUniforms(lit, "frame");
const bindings = renderer.createBindGroup(lit, { frame });

frame.write({ viewProjection, model, normalMatrix: model.normalMatrix(), light });
renderer.frame({ r: 0.5, g: 0.7, b: 0.9, a: 1 }, pass => pass.draw(lit, bindings, mesh));
```

### 3. API 速查

| API | 说明 |
| --- | --- |
| `Vec2`/`Vec3`/`Vec4` | 不可变的 `data class`；`add`、`sub`、`mul`（逐分量）、`div`、`scale`、`negate`、`dot`、`length`、`normalize`、`Vec3.cross`，分量 `x`…`w`、`xy`、`xyz` |
| `Mat3`/`Mat4` | 列主序矩阵；`mul` 接受矩阵或向量；`Mat4.translation`、`rotation`、`scaling`、`perspective`（深度 0 到 1）、`lookAt`、`normalMatrix` |
| `vec2`/`vec3`/`vec4` 等 | WGSL 构造函数和内置函数的 CPU 版本，标量函数也逐分量作用于向量 |
| `shaderModule(Name)` | 把 namespace `Name` 编译为 `const NameModule: ShaderModule<Vertex, Bindings>`；namespace 导出时它也导出 |
| `Builtin<"position", Vec4>` | 把顶点输出的字段标为裁剪空间位置 |
| `packVertices`、`writeUniforms` | 按生成的布局把值写进 `Float32Array` |
| `Renderer` | `create`、`createPipeline`、`createMesh`、`createUniforms`、`createBindGroup`、`frame`；不支持 WebGPU 时抛出 `GpuUnavailableError` |
| `Shape`、`meshOf` | `Box`、`Sphere`、`Plane`、`Torus` 的网格，顶点为 `StandardVertex`（`position`、`normal`、`uv`） |
| `OrbitCamera`、`OrbitControls` | 绕目标旋转的相机，以及拖动旋转、滚轮或双指缩放的控制器 |
| `Transform`、`animate` | 缩放、旋转、平移的模型矩阵；每帧回调，返回停止函数 |

### 4. 着色器规则

- namespace 里有名为 `vertex` 和（或）`fragment` 的入口，其余函数是辅助函数，也可以调用项目里其他带函数体的函数。
- `vertex` 的第一个参数是顶点输入 interface，字段按顺序成为 `@location`；它返回的 interface 就是 `fragment` 的第一个参数，其中一个字段的类型是 `Builtin<"position", Vec4>`。`fragment` 返回 `Vec4` 颜色。
- 入口的其余参数是 uniform interface，按首次出现的顺序绑定到 `@group(0)`，两个入口里同名参数共用一个绑定。CPU 端按参数名填写这些 uniform。
- 函数体可以用：数字（`f32`）、布尔值、`math` 中的向量和矩阵及其方法、`math` 中的内置函数、interface（翻译为结构体）、`const`/`let`、赋值、`if`、`for`、`while`、`break`、`continue`、`return`、三元表达式（翻译为 `select`），以及常量 `Math.PI`。
- 每个参数和返回值都要写类型；结构体字段不能可选；不支持数组、闭包、`Math.random` 等 WGSL 无法表达的内容。这些都会在宏调用处报编译错误，并给出行号和原因。
- 嵌套在 uniform 里的结构体按 16 字节对齐并补齐到 16 字节；生成的 WGSL 用 `@align`/`@size` 写明，CPU 端布局与之一致。

### 5. TS++ 的实际用途

- **编译期宏**：`shaderModule` 借助 checker 识别每个表达式的类型，再把函数体翻译成 WGSL，同时推导缓冲布局；生成代码只从本库导入 `defineShader`。
- **`data class` 与 `final class`**：向量是带结构相等和 `copy` 的不可变值；私有的 `size` 字段让 `Vec3` 不能当作 `Vec2` 使用，即便它在结构上包含 `Vec2` 的全部成员。
- **`data` 与 `match`**：`Shape` 是代数数据类型，`meshOf` 对它穷尽匹配。

### 6. 开发与测试

```sh
pnpm --filter @tspp/engine test
```

测试先构建本库，再编译 `test/fixture`（正确的着色器）和 `test/invalid`（应当报错的着色器）两个消费者项目：检查生成的 WGSL 和布局、在 CPU 上运行着色器函数，以及数学、几何体、相机和缓冲打包。测试不需要 GPU，因此不会检查 WGSL 在 GPU 驱动上的编译结果；`Renderer.createPipeline` 会在运行时报告 WGSL 编译错误。

---

## English

**Engine** (`@tspp/engine`) is a small **WebGPU engine** written in TS++. Its shaders are not WGSL strings but ordinary TS++ functions: the compile-time macro `shaderModule` translates the functions of a namespace to WGSL and works out the memory layouts of the vertex and uniform buffers. The functions still run on the CPU, so shader logic can be unit-tested directly.

```ts
export namespace Lit {
  export function vertex(input: Vertex, frame: Frame): Surface {
    const world = frame.model.mul(vec4(input.position, 1));
    return { clip: frame.viewProjection.mul(world), world: world.xyz, normal: frame.normalMatrix.mul(input.normal) };
  }

  export function fragment(surface: Surface, frame: Frame): Vec4 {
    const light = max(dot(normalize(surface.normal), frame.light.direction.negate()), 0);
    return vec4(frame.light.color.scale(light), 1);
  }
}

macro shaderModule(Lit); // generates LitModule: WGSL code plus buffer layouts
```

The engine has four modules, each depending only on those above it:

| Module | Contents |
| --- | --- |
| `@tspp/engine/math` | Vectors `Vec2`/`Vec3`/`Vec4`, matrices `Mat3`/`Mat4`, and CPU versions of WGSL built-ins such as `mix`, `clamp` and `dot` |
| `@tspp/engine/shader` | The `shaderModule` macro, the `Builtin` marker, the types of what it generates, and `packVertices`/`writeUniforms` to fill buffers by layout |
| `@tspp/engine/gpu` | `Renderer`, `Pipeline`, `Mesh`, `Uniforms` and `BindGroup`, typed by the shader so meshes and uniforms must match it |
| `@tspp/engine/scene` | `Shape` geometry, the `OrbitCamera`, `Transform`, `OrbitControls` and the `animate` loop |

Scenes and materials belong to applications, such as [scene-viewer](../scene-viewer/README.md).

### 1. Build and Install

After setting up the [repository development environment](../../../README.md), build the library from the repository root:

```sh
pnpm --filter @tspp/engine build
```

Add a workspace dependency to the consuming project's `package.json`, and in its `tsppconfig.json` enable the macros plugin (to invoke `shaderModule`) and the DOM library (to use `gpu` and `scene`):

```json
{ "dependencies": { "@tspp/engine": "workspace:*" } }
```

```json
{
  "compilerOptions": {
    "lib": ["ES2022", "DOM"],
    "plugins": [{ "name": "ts-plus-plus/plugins/macros", "tspp": true }]
  }
}
```

The library is an ES module package, served to browsers by a bundler such as Vite.

### 2. Quick Start

Describe the shader's input, output and uniforms with interfaces, then write the shader functions in a namespace:

```ts
import { dot, max, normalize, type Mat3, type Mat4, type Vec3, type Vec4, vec4 } from "@tspp/engine/math";
import { type Builtin, shaderModule } from "@tspp/engine/shader";

export interface Vertex { position: Vec3; normal: Vec3; }
export interface Surface { clip: Builtin<"position", Vec4>; world: Vec3; normal: Vec3; }
export interface Light { direction: Vec3; color: Vec3; }
export interface Frame { viewProjection: Mat4; model: Mat4; normalMatrix: Mat3; light: Light; }

export namespace Lit { /* the vertex and fragment above */ }
macro shaderModule(Lit);
```

Then draw with the `gpu` module. `createPipeline` checks the WGSL compilation result; a `Pipeline<Vertex, Bindings>` accepts only meshes of its vertex type and uniforms of its bindings:

```ts
import { Renderer } from "@tspp/engine/gpu";
import { meshOf, Sphere } from "@tspp/engine/scene";

const renderer = await Renderer.create(canvas);
const lit = await renderer.createPipeline(LitModule);
const mesh = renderer.createMesh(lit, meshOf(Sphere(1, 48, 32)));
const frame = renderer.createUniforms(lit, "frame");
const bindings = renderer.createBindGroup(lit, { frame });

frame.write({ viewProjection, model, normalMatrix: model.normalMatrix(), light });
renderer.frame({ r: 0.5, g: 0.7, b: 0.9, a: 1 }, pass => pass.draw(lit, bindings, mesh));
```

### 3. API Quick Reference

| API | Description |
| --- | --- |
| `Vec2`/`Vec3`/`Vec4` | Immutable `data class`es; `add`, `sub`, `mul` (componentwise), `div`, `scale`, `negate`, `dot`, `length`, `normalize`, `Vec3.cross`, and components `x`…`w`, `xy`, `xyz` |
| `Mat3`/`Mat4` | Column-major matrices; `mul` takes a matrix or a vector; `Mat4.translation`, `rotation`, `scaling`, `perspective` (depth 0 to 1), `lookAt`, `normalMatrix` |
| `vec2`/`vec3`/`vec4` and others | CPU versions of WGSL constructors and built-ins; scalar functions also apply to each component of vectors |
| `shaderModule(Name)` | Compiles namespace `Name` to `const NameModule: ShaderModule<Vertex, Bindings>`, exported when the namespace is |
| `Builtin<"position", Vec4>` | Marks a vertex output field as the clip-space position |
| `packVertices`, `writeUniforms` | Write values into a `Float32Array` by a generated layout |
| `Renderer` | `create`, `createPipeline`, `createMesh`, `createUniforms`, `createBindGroup`, `frame`; throws `GpuUnavailableError` without WebGPU |
| `Shape`, `meshOf` | Meshes of `Box`, `Sphere`, `Plane` and `Torus`, with `StandardVertex` vertices (`position`, `normal`, `uv`) |
| `OrbitCamera`, `OrbitControls` | A camera that circles a target, and controls that orbit by dragging and zoom by wheel or pinch |
| `Transform`, `animate` | A model matrix that scales, rotates and moves; a per-frame callback that returns a stop function |

### 4. Shader Rules

- A namespace has entries named `vertex` and/or `fragment`; its other functions are helpers, and shaders may also call other functions with bodies in the project.
- The first parameter of `vertex` is the vertex input interface, whose fields become `@location`s in order. It returns the interface that `fragment` takes first, one of whose fields has the type `Builtin<"position", Vec4>`. `fragment` returns a `Vec4` color.
- Further entry parameters are uniform interfaces, bound to `@group(0)` in order of first appearance; parameters of the same name in both entries share a binding. The CPU fills these uniforms by parameter name.
- Bodies may use numbers (`f32`), booleans, the vectors and matrices of `math` and their methods, the built-ins of `math`, interfaces (as structs), `const`/`let`, assignments, `if`, `for`, `while`, `break`, `continue`, `return`, conditional expressions (as `select`), and the constant `Math.PI`.
- Every parameter and return type is written out; struct fields cannot be optional; arrays, closures, `Math.random` and anything else WGSL cannot express are not supported. Each is a compile error at the macro invocation, with a line and a reason.
- A struct nested in a uniform is aligned to 16 bytes and padded to 16; the generated WGSL says so with `@align`/`@size`, and the CPU layout matches it.

### 5. TS++ in the Library

- **Compile-time macros**: `shaderModule` asks the checker for the type of each expression, translates the function bodies to WGSL and derives the buffer layouts; generated code imports only `defineShader` from this library.
- **`data class` and `final class`**: vectors are immutable values with structural equality and `copy`; a private `size` field keeps a `Vec3` from passing as a `Vec2`, although it has every member a `Vec2` has.
- **`data` and `match`**: `Shape` is an algebraic data type that `meshOf` matches exhaustively.

### 6. Development

```sh
pnpm --filter @tspp/engine test
```

The tests build the library, then compile two consumer projects, `test/fixture` (valid shaders) and `test/invalid` (shaders that must be rejected). They check the generated WGSL and layouts, run shader functions on the CPU, and cover the math, geometry, camera and buffer packing. They need no GPU, so they do not check how a GPU driver compiles the WGSL; `Renderer.createPipeline` reports WGSL compilation errors at runtime.
