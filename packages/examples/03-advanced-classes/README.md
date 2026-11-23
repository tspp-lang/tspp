# 03-advanced-classes — 现代类与封闭类层次 / Modern Classes & Sealed Class Hierarchies

本目录演示 TS++ 在面向对象编程（OOP）层面引入的七项现代类特性。它们消除了传统 TypeScript 类中的私有后备字段样板、单例声明样板与值对象方法样板，提供编译期强制的封闭类层次（`sealed`）与终态约束（`final`），并允许一个类同时继承多个基类。

This directory demonstrates seven modern object-oriented class features in TS++. They eliminate boilerplate for private backing fields, singletons, and value classes, enforce compile-time inheritance boundaries via `sealed` and `final`, and let a class inherit from several bases.

---

## 特性概览 / Feature Overview

| 语法特性 / Feature | 写法示例 / Syntax Example | 引入目的与效果 / Purpose & Effect |
| :--- | :--- | :--- |
| **`field` 隐式存储属性** | `field count: number = 0 { get() { return field; } set(v) { ... } }` | 为带自定义 `get`/`set` 的属性自动提供隐式后备存储（`field`），无需额外声明 `private _count`。<br/>Provides implicit backing storage (`field`) inside `get`/`set` accessors without declaring a separate private field. |
| **`object` 单例声明** | `object Origin { dimension: number = 2; }` | 一步声明既是全局唯一实例、又可直接用作类型注解的命名单例。<br/>Declares a named singleton that acts simultaneously as a runtime instance and its own static type. |
| **`data class` 数据类** | `data class Point(x: number, y: number)` | 用主构造器参数直接声明属性，并自动生成按值比较的 `equals`、`toString` 与 `copy` 方法。<br/>Declares properties from primary constructor parameters and auto-synthesizes `equals`, `toString`, and `copy`. |
| **`with` 非破坏性拷贝** | `const p2 = with(p0, { x: 10, y: 20 });` | 基于原实例创建一个仅更新指定属性的新副本，原实例保持不变，且在编译期严格校验属性名。<br/>Creates a new copy with updated properties without mutating the original instance, with strict compile-time property checking. |
| **`sealed class` 封闭类** | `sealed abstract class Outcome { ... }` | 限制该基类只能在**当前源文件内**被继承，配合 `object` 与 `data class` 构造封闭的类分支层次。<br/>Restricts subclassing to the **declaring source file**, enabling closed algebraic class hierarchies. |
| **`final` 类与方法** | `final class LockedBox` / `final isResolved()` | 禁止类被继承（`final class`）或禁止基类方法被子类重写（`final` 方法）。<br/>Forbids subclassing a class (`final class`) or overriding a method in subclasses (`final` method). |
| **多继承** | `class Panel extends Shape, Labeled, Describable` | 第一个基类是普通父类，之后的基类被复制到继承链上，并与原类共享私有字段、静态字段和 `instanceof`；两个基类提供同名成员时直接报错。<br/>The first base is an ordinary parent; later bases are copied onto the chain and share private fields, static fields, and `instanceof` with the original. The same member from two bases is an error. |

---

## 源码文件阅读顺序 / Source Files

1. **[`src/01-classes.tspp`](./src/01-classes.tspp)** — `field` 属性访问器、`object` 单例声明、`data class` 自动合成方法与 `with` 非破坏性拷贝表达式。
   Covers `field` backing properties, `object` singletons, `data class` synthesized methods, and `with` copy expressions.
2. **[`src/02-sealed-and-final.tspp`](./src/02-sealed-and-final.tspp)** — `sealed class` 封闭类层次、`final` 类与方法，以及违反约束时的编译期报错验证（`@ts-expect-error`）。
   Covers `sealed class` hierarchies, `final` classes and methods, and compile-time boundary checks (`@ts-expect-error`).
3. **[`src/03-multiple-inheritance.tspp`](./src/03-multiple-inheritance.tspp)** — 多继承：组合多个基类的行为、额外基类的抽象成员，以及成员冲突与不可复制基类的编译期报错。
   Covers multiple inheritance: combining several bases, abstract members of additional bases, and compile-time errors for conflicting members and bases that cannot be copied.

---

## 检查与代码规范 / Check & Lint

```bash
pnpm check
pnpm lint
```
