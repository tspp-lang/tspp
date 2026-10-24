# 01 — 高阶类型与类型宇宙

这个项目是一份可直接运行的 TS++ 入门示例，按顺序演示：

1. `Type` 与 `Type0`；
2. 普通泛型别名的 kind；
3. 把类型构造器保存为一等类型值；
4. 连续应用或给带括号的类型构造器结果传参；
5. 用高阶类型参数定义 `Functor`；
6. `Type0 : Type1`、`Type1 : Type2`；
7. 非累积宇宙带来的类型检查。

源码末尾保留了几个由 `// @ts-expect-error` 保护的反例。它们会触发 TS++ 语言服务的诊断，同时仍能让整个示例通过检查；如果某个反例不再报错，编译器会报告该指令未使用。

本例的 `tsppconfig.json` 显式开启 `higherKindedTypes` 与它所需的 `typeUniverses`；依赖项不会被编译器隐式开启。

## 在插件开发窗口中运行

在仓库根目录按 `F5`，选择 **TS++: VS Code Extension**。新打开的 Extension Development Host 会加载 `packages/examples`；通过窗口左下角的 **TS++ Examples** 状态栏按钮选择本例。

第一次运行时，如果 VS Code 询问是否允许使用工作区版本的 TypeScript，请选择 **Allow**。将鼠标悬停在 `labels` 上，可以看到它被推导为 `string[]`。

## 核心语法

普通泛型别名的 kind 可以由声明机械地得到：

```typescript
type Pair<A, B> = [A, B];
// Pair: (Type0, Type0) => Type0
```

如果一个非泛型别名要保存尚未应用的类型构造器，则需要显式标注 kind：

```typescript
type Arrays: Type0 => Type0 = Array;
type StringArray = Arrays<string>;
```

返回类型构造器的类型表达式可以继续直接应用；括号不会改变它的 kind：

```typescript
type IdentityConstructor<F: Type0 => Type0>: Type0 => Type0 = F;
type DirectNumberArray = IdentityConstructor<Array><number>;
type ParenthesizedNumberArray = (IdentityConstructor<Array>)<number>;
```

kind 也能约束高阶类型参数：

```typescript
interface Functor<F: Type0 => Type0> {
    map<A, B>(fa: F<A>, fn: (value: A) => B): F<B>;
}
```

`Type` 是 `Type0` 的兼容写法。宇宙层级没有预设上限，编译器会按需识别 `TypeN`；当前采用非累积规则，不会自动把低层宇宙提升到高层宇宙。

```typescript
type UniverseZero: Type1 = Type0;
type UniverseOne: Type2 = Type1;

// kind 中的别名会透明展开为 Type0。
type Arrays: UniverseZero => UniverseZero = Array;
```

## 命令行验证

在本目录运行：

```powershell
pnpm check
pnpm emit-declarations
```

声明输出位于 `dist/index.d.tspp`。普通 `.ts` 输入仍然输出 `.d.ts`。
