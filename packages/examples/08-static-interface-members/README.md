# 08-static-interface-members — 接口中的静态成员契约 / Static Interface Members

本目录演示 TS++ 在 `interface` 中引入的 **`static` 静态成员声明**。它允许接口在描述实例方法的同时，直接约束实现类必须提供的**静态属性**与**静态工厂方法**，摆脱了标准 TypeScript 中需要将接口拆分为“实例接口 + 构造函数接口”的繁琐模式。

This directory demonstrates **`static` member declarations inside `interface`** in TS++. It allows an interface to specify both instance members and **static properties / factory methods** that an implementing class must provide, eliminating the need to split contracts into separate instance and constructor interfaces.

---

## 特性概览 / Feature Overview

| 语法特性 / Feature | 写法示例 / Syntax Example | 引入目的与效果 / Purpose & Effect |
| :--- | :--- | :--- |
| **`interface` 静态属性** | `interface Serializable { static readonly mediaType: string; }` | 要求所有 `implements Serializable` 的类必须在类自身上提供指定类型的静态属性。<br/>Requires any class implementing `Serializable` to define the matching static property on the class constructor. |
| **`interface` 静态方法与 `this`** | `interface Serializable { static deserialize(raw: string): this; }` | 要求实现类提供静态工厂方法，其中返回类型 `this` 会自动绑定为当前实现类的实例类型。<br/>Requires implementing classes to provide a static factory method whose `this` return type resolves to the implementing class instance. |
| **接口继承静态契约** | `interface Versioned extends Serializable { static fromVersion(v: number): this; }` | 子接口自动继承父接口的所有静态与实例契约，并在实现类上统一做编译期检查。<br/>Sub-interfaces inherit all static and instance contracts from base interfaces and enforce them together on implementing classes. |

---

## 源码文件阅读顺序 / Source Files

1. **[`src/01-basics.tspp`](./src/01-basics.tspp)** — 在 `interface` 中声明 `static` 属性与返回 `this` 的静态工厂方法、通过 `class ... implements` 统一实现，以及通过 `interface ... extends` 继承静态契约。
   Covers declaring `static` properties and `this`-returning static methods in an `interface`, implementing them on classes, and inheriting static contracts via `extends`.
2. **[`src/02-static-boundaries.tspp`](./src/02-static-boundaries.tspp)** — 验证静态成员不会污染实例类型，以及当类缺失静态成员或静态方法签名不匹配时的编译期错误拦截（`@ts-expect-error`）。
   Verifies that static members do not pollute instance types, and shows compile-time error checks (`@ts-expect-error`) when static members are missing or mistyped.

---

## 检查与代码规范 / Check & Lint

```bash
pnpm check
pnpm lint
```
