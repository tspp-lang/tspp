# TS++ 示例 10: 算子切片与占位符表达式 (`operatorSections`)

本示例演示 TS++ 的 `operatorSections` 特性。

## 特性概述

在函数式编程与数据流水线中，常常需要编写小型的匿名单参数或双参数箭头函数。`operatorSections` 引入以 `_` 作为占位符的轻量级表达式语法：

```tspp
const addOne: (x: number) => number = (_ + 1);
const total = numbers.reduce(_ + _, 0);
const names = users.map(_.name);
```

### 脱糖规则

编译器在解析阶段自动将其脱糖为普通 JavaScript 箭头函数，不引入任何运行时库或隐式开销：

| 表达式 | 脱糖结果 |
|---|---|
| `(_ + 1)` | `(__p0) => __p0 + 1` |
| `(10 - _)` | `(__p0) => 10 - __p0` |
| `(_ + _)` | `(__p0, __p1) => __p0 + __p1` |
| `(_.name)` | `(__p0) => __p0.name` |
| `list.map(_ * 2)` | `list.map((__p0) => __p0 * 2)` |

## 配置启用

在 `tsppconfig.json` 中配置：

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "tsppFeatures": [
      "operatorSections"
    ]
  }
}
```

## 运行与验证

在当前目录或 examples 根目录下执行：

```bash
pnpm check
pnpm build
```

