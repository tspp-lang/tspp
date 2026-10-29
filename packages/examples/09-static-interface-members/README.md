# 09 — 接口静态成员（Static Interface Members）

这个示例演示 TS++ 的 `staticInterfaceMembers` 特性：接口可以同时声明实例侧和静态侧契约，类的 `implements` 会检查两侧。

## 基本写法

```ts
interface Serializable {
  static readonly mediaType: string;
  static deserialize(data: string): this;
  serialize(): string;
}

class User implements Serializable {
  static readonly mediaType = "application/json";
  static deserialize(data: string): User {
    return new User();
  }
  serialize(): string {
    return "{}";
  }
}
```

若 `User` 缺少静态成员、静态签名不兼容，或缺少实例成员，编译器都会在 `implements` 处报错。静态成员只属于类构造器，不会出现在 `Serializable` 实例上。

静态签名中的 `this` 被 TS++ 定义为“当前实现类的实例类型”。因此 `User.deserialize` 可以返回 `User`，实现继承接口的 `VersionedUser` 也可以返回 `VersionedUser`。

## 为什么 TypeScript 官方没有直接支持

TypeScript 把类拆成两个类型：类名（如 `User`）代表实例侧，`typeof User` 代表构造器和静态侧；而 `interface` 与 `implements` 历来只描述和检查实例侧。把 `static` 放入接口后，还需要决定如何在普通类型位置引用接口的静态侧、如何处理多态 `this`、泛型、接口继承、声明合并，以及静态抽象成员的调用安全。

官方长期讨论过这个需求：

- [microsoft/TypeScript#14600](https://github.com/microsoft/TypeScript/issues/14600)：最初的静态接口成员与 `abstract static` 提案；
- [microsoft/TypeScript#33892](https://github.com/microsoft/TypeScript/issues/33892)：为类的静态侧指定接口，目前仍未形成共识；
- [microsoft/TypeScript#34516](https://github.com/microsoft/TypeScript/issues/34516)：`static abstract` 的调用安全与类型语义问题。

这不是 JavaScript 输出层面的困难——接口仍会完全擦除——主要难点在于如何扩展 TypeScript 的双侧、结构化类型模型而不制造歧义。

## TS++ 的取舍

为了让常见的工厂、解析和反序列化模式先变得实用，本特性采用一套刻意收窄的规则：

1. `InterfaceName` 在普通类型位置仍只表示实例侧，不新增 `static InterfaceName` 或 `typeof InterfaceName` 类型运算符；
2. 静态契约只由类声明的 `implements` 检查，实例侧与静态侧必须同时满足；
3. 静态签名中的 `this` 表示实现类的实例类型；
4. 接口 `extends` 会继承静态契约，声明合并也会合并静态成员；
5. 静态成员不能引用其接口的类型参数，因为一个构造器由所有实例类型参数共享；静态方法仍可声明自己的泛型参数；
6. `static` 只允许出现在接口成员中，普通对象类型字面量仍不接受该修饰符；
7. 该特性只影响类型检查和声明文件，生成的 JavaScript 与普通 TypeScript 类完全相同。

这意味着它解决的是“类声明必须满足静态契约”，暂时不尝试解决“把接口静态侧作为一等类型传递”的更大问题。后者仍可使用单独的构造器接口表达。

## 启用与运行

在 `tsppconfig.json` 中启用：

```json
{
  "compilerOptions": {
    "tsppFeatures": ["staticInterfaceMembers"]
  }
}
```

然后运行：

```bash
pnpm check
pnpm build
```
