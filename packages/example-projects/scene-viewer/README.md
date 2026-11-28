# Scene Viewer / 场景查看器

[中文](#中文) | [English](#english)

## 中文

**Scene Viewer**（`@tspp/scene-viewer`）是一个在浏览器里运行的 **WebGPU 3D 场景查看器**，基于 [engine](../engine/README.md)。场景里有一块瓷砖地板，上面放着球体、立方体和圆环。可以拖动旋转视角、滚轮或双指缩放、调整太阳方位，还能切换到法线视图。

它的材质都是用 TS++ 写的着色器函数，由 `shaderModule` 编译成 WGSL：

| 材质 | 效果 |
| --- | --- |
| `Plastic` | 天空与地面的环境光、Blinn-Phong 阳光高光和边缘光，最后做色调映射 |
| `Tiles` | 世界坐标上一格一米的明暗瓷砖，远处渐隐到天空色 |
| `Normals` | 把表面朝向的 x、y、z 显示为红、绿、蓝 |

三种材质共用 `shaders/surface.tspp` 中的 uniform 和顶点阶段，以及 `shaders/lighting.tspp` 中的光照函数。宏会把被调用到的函数一起翻译进每个着色器。

### 1. 运行

需要支持 WebGPU 的浏览器（如 Chrome、Edge 113 及以上）和可用的 GPU。准备好[仓库开发环境](../../../README.zh-CN.md)后，在仓库根目录运行：

```sh
pnpm --filter @tspp/engine build
```

```sh
pnpm --filter @tspp/scene-viewer dev
```

然后打开 Vite 输出的地址。`pnpm --filter @tspp/scene-viewer bundle` 会把页面打包到 `site` 目录，可部署为静态站点。浏览器不支持 WebGPU 时，页面会显示原因。

### 2. 结构

| 文件 | 内容 |
| --- | --- |
| `src/shaders/surface.tspp` | `Frame`、`Model`、`Surface` 和共用的顶点阶段 `placeSurface` |
| `src/shaders/lighting.tspp` | 光照 `illuminate` 与色调映射 `display` |
| `src/shaders/materials.tspp` | 三个材质 namespace 和对应的 `shaderModule` 调用 |
| `src/scene.tspp` | 场景物体、材质 `Material`、视图模式 `ViewMode`、太阳方向 |
| `src/main.tspp` | 启动 WebGPU，建立管线、网格和 uniform，处理页面控件并逐帧绘制 |

### 3. TS++ 的实际用途

- **编译期宏**：材质写成普通函数，编译时生成 WGSL 和缓冲布局；同样的函数在测试里直接在 CPU 上运行。
- **`data` 与 `match`**：`Material` 和 `ViewMode` 是代数数据类型，每帧用 `match` 选出管线和材质参数，漏掉某种情况会编译失败。
- **类型化的 GPU 资源**：三种材质的顶点类型和绑定相同，所以网格和绑定组可以共用；换成顶点布局不同的着色器则无法通过编译。

### 4. 开发与测试

```sh
pnpm --filter @tspp/scene-viewer test
```

测试在 CPU 上运行材质函数，检查受光面比背光面亮、瓷砖明暗交替、远处地板融入天空、法线视图的颜色，以及场景的物体和动画。测试不需要 GPU。

---

## English

**Scene Viewer** (`@tspp/scene-viewer`) is a **WebGPU 3D scene viewer** that runs in the browser, built on [engine](../engine/README.md). Its scene is a tiled floor with a sphere, a box and a torus on it. Drag to orbit, scroll or pinch to zoom, move the sun, or switch to a view of the surface normals.

Its materials are shader functions written in TS++ and compiled to WGSL by `shaderModule`:

| Material | Look |
| --- | --- |
| `Plastic` | Sky and ground ambient light, a Blinn-Phong sun with highlights, and a rim light, then tone mapping |
| `Tiles` | One-meter tiles in two shades over world coordinates, fading into the sky with distance |
| `Normals` | The direction each surface faces, x, y and z as red, green and blue |

The three materials share the uniforms and vertex stage of `shaders/surface.tspp` and the lighting of `shaders/lighting.tspp`. The macro translates every function a shader calls into that shader.

### 1. Run

You need a browser with WebGPU (such as Chrome or Edge 113 or later) and a working GPU. After setting up the [repository development environment](../../../README.md), run from the repository root:

```sh
pnpm --filter @tspp/engine build
```

```sh
pnpm --filter @tspp/scene-viewer dev
```

Then open the address Vite prints. `pnpm --filter @tspp/scene-viewer bundle` bundles the page into `site`, which can be deployed as a static site. Where the browser does not support WebGPU, the page says why.

### 2. Layout

| File | Contents |
| --- | --- |
| `src/shaders/surface.tspp` | `Frame`, `Model`, `Surface` and the shared vertex stage `placeSurface` |
| `src/shaders/lighting.tspp` | Lighting with `illuminate` and tone mapping with `display` |
| `src/shaders/materials.tspp` | The three material namespaces and their `shaderModule` invocations |
| `src/scene.tspp` | The scene's objects, `Material`, the `ViewMode`, and the sun direction |
| `src/main.tspp` | Starts WebGPU, creates pipelines, meshes and uniforms, handles the page controls and draws each frame |

### 3. TS++ in the Application

- **Compile-time macros**: materials are ordinary functions, from which the build generates WGSL and buffer layouts; the tests run the same functions on the CPU.
- **`data` and `match`**: `Material` and `ViewMode` are algebraic data types; each frame `match`es them to choose a pipeline and material parameters, and a missing case does not compile.
- **Typed GPU resources**: the three materials share their vertex type and bindings, so they share meshes and bind groups; a shader with another vertex layout would not compile in their place.

### 4. Development

```sh
pnpm --filter @tspp/scene-viewer test
```

The tests run the materials on the CPU: a surface facing the sun is brighter than one facing away, tiles alternate, the far floor blends into the sky, the normal view shows the right colors, and the scene's objects move as they should. They need no GPU.
