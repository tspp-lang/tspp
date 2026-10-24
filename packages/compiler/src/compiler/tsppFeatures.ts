import { CompilerOptions } from "./types.js";

export interface TsppFeatureDefinition {
  readonly name: string;
  readonly dependencies: readonly string[];
  readonly initComments: readonly string[];
}

export const tsppFeatureDefinitions: readonly TsppFeatureDefinition[] = [
  {
    name: "higherKindedTypes",
    dependencies: [],
    initComments: [
      "获得：高阶类型参数和一等类型构造器。",
      "影响：TS超集=是；透明擦除=是。",
    ],
  },
  {
    name: "nominalTypes",
    dependencies: [],
    initComments: [
      "获得：newtype 名义类型声明、data 代数数据类型声明与对应变体构造器，以及值层 match 模式匹配表达式。",
      "影响：TS超集=是；透明擦除=否（生成运行时构造器与匹配分派）。",
    ],
  },
  {
    name: "typeComputation",
    dependencies: [],
    initComments: [
      "获得：增强类型计算的语法：类型层局部绑定 let X = T in U、结构模式匹配 match T { ... } 与类型 lambda <T> =>> Body。",
      "影响：TS超集=是；透明擦除=是。",
    ],
  },
  {
    name: "modernSyntax",
    dependencies: [],
    initComments: [
      "获得：值层表达式与求值语法：let ... in 表达式、do { ... } 表达式以及 do 函数/方法隐式返回体。",
      "影响：TS超集=是；透明擦除=否（降级转换）。",
    ],
  },
  {
    name: "macros",
    dependencies: [],
    initComments: [
      "获得：macro function 编译期函数与 macro 调用语句。",
      "影响：TS超集=是；透明擦除=否（宏调用会被编译期结果替换）。",
    ],
  },
  {
    name: "formalContracts",
    dependencies: [],
    initComments: [
      "获得：requires、ensures 与循环 invariant 的静态 SMT 验证（输出标准 SMT-LIB 2.6，不依赖特定求解器）。",
      "影响：TS超集=是；透明擦除=是。",
    ],
  },
  {
    name: "standardLibraryPredicates",
    dependencies: ["formalContracts"],
    initComments: [
      '获得：标准库数值谓词 isEven、isOdd、isPositive、isNegative、isNonNegative、isZero、divides、between；number 需 numberModel（"mathematical-real" 或 "safe-integer"）。',
      "影响：TS超集=是；透明擦除=是。",
    ],
  },
  {
    name: "refinementTypes",
    dependencies: ["formalContracts"],
    initComments: [
      "获得：由 SMT 求解器验证类型引入点的谓词精化类型别名。",
      "影响：TS超集=是；透明擦除=是。",
    ],
  },
  {
    name: "smtLibraries",
    dependencies: ["formalContracts"],
    initComments: [
      "获得：用 ts-plus-plus/smt 定义逻辑函数、谓词与公理，并在契约中调用；逻辑库模块会在编译期执行。",
      "影响：TS超集=是；透明擦除=是（逻辑函数只用于规格，运行时调用会抛错）。",
    ],
  },
  {
    name: "typeUniverses",
    dependencies: ["higherKindedTypes"],
    initComments: [
      "获得：Type0、Type1 等类型宇宙与 kind 分层。",
      "影响：TS超集=是；透明擦除=是。",
    ],
  },
  {
    name: "dependentFunctionTypes",
    dependencies: ["typeUniverses"],
    initComments: [
      "获得：返回类型可以依赖参数的 Pi 类型，以及显式 Lam/Ann MLTT 项。",
      "影响：TS超集=是；透明擦除=是。",
    ],
  },
  {
    name: "dependentFunctionInterop",
    dependencies: ["dependentFunctionTypes"],
    initComments: [
      "获得：Pi 类型与 TypeScript 泛型函数之间的赋值和调用。",
      "影响：TS超集=是；透明擦除=是。",
    ],
  },
  {
    name: "typeMatching",
    dependencies: ["dependentFunctionTypes"],
    initComments: [
      "获得：match mltt T { ... } 精确类型分支、reify descriptor 的表达式匹配与构造器 infer 捕获；IfType 和 TypeMatch 保留为兼容写法。",
      "影响：TS超集=是；透明擦除=是；开放类型保持为中性项。",
    ],
  },
  {
    name: "naturalNumbers",
    dependencies: ["dependentFunctionTypes"],
    initComments: [
      "获得：Nat、Zero、Succ 类型级自然数。",
      "影响：TS超集=是；透明擦除=是。",
    ],
  },
  {
    name: "naturalNumberAddition",
    dependencies: ["naturalNumbers"],
    initComments: [
      "获得：可归约的 NatAdd 类型级加法。",
      "影响：TS超集=是；透明擦除=是。",
    ],
  },
  {
    name: "naturalNumberElimination",
    dependencies: ["naturalNumbers"],
    initComments: [
      "获得：NatElim 依赖消去器。",
      "影响：TS超集=是；透明擦除=是。",
    ],
  },
  {
    name: "booleans",
    dependencies: ["dependentFunctionTypes"],
    initComments: [
      "获得：Bool、True、False 类型级布尔值。",
      "影响：TS超集=是；透明擦除=是。",
    ],
  },
  {
    name: "booleanElimination",
    dependencies: ["booleans"],
    initComments: [
      "获得：BoolElim 依赖消去器与 If 依值分支。",
      "影响：TS超集=是；透明擦除=是。",
    ],
  },
  {
    name: "identityTypes",
    dependencies: ["dependentFunctionTypes"],
    initComments: [
      "获得：Eq、Refl 相等类型与证明，以及 J path induction。",
      "影响：TS超集=是；透明擦除=是。",
    ],
  },
  {
    name: "sigmaTypes",
    dependencies: ["dependentFunctionTypes"],
    initComments: [
      "获得：Sigma、Pair、First、Second 依赖对及投影。",
      "影响：TS超集=是；透明擦除=是。",
    ],
  },
];

export function isTsppConfigFileName(fileName: string | undefined): boolean {
  if (!fileName) return false;
  const normalized = fileName.replace(/\\/g, "/").toLowerCase();
  return normalized === "tsppconfig.json" || normalized.endsWith("/tsppconfig.json");
}

export function isTsppProject(options: CompilerOptions | undefined): boolean {
  return !!options && (isTsppConfigFileName(options.configFilePath) || options.tsppFeatures !== undefined);
}

export function hasTsppFeature(options: CompilerOptions, feature: string): boolean {
  if (!options.tsppFeatures) return false;
  if (feature === "nominalTypes" || feature === "newtypeDeclarations" || feature === "dataDeclarations") {
    return options.tsppFeatures.includes("nominalTypes") ||
      options.tsppFeatures.includes("newtypeDeclarations") ||
      options.tsppFeatures.includes("dataDeclarations");
  }
  return options.tsppFeatures.includes(feature);
}

export function getTsppFeatureDefinition(feature: string): TsppFeatureDefinition {
  return tsppFeatureDefinitions.find(definition => definition.name === feature)!;
}

export function generateTsppConfig(commitHash: string, newLine: string): string {
  const lines = [
    `// Generated by ts-plus-plus compiler commit ${commitHash}.`,
    "// 所有 TS++ 特性默认关闭；只取消注释你明确选择的特性。",
    "// ‘TS超集=是’表示现有 TypeScript 的语法、类型检查和运行时行为保持兼容。",
    "// ‘透明擦除=是’表示该特性只删除类型语法，不生成或改变 JavaScript 运行时代码。",
    "// 依赖项也必须显式列出；编译器不会自动开启、修改配置或容错启动。",
    "{",
    `  "extends": "./tsconfig.json",`,
    `  "compilerOptions": {`,
    `    "tsppFeatures": [`,
  ];

  for (const definition of tsppFeatureDefinitions) {
    lines.push("");
    for (const comment of definition.initComments) lines.push(`      // ${comment}`);
    lines.push(`      // 依赖：${definition.dependencies.length ? definition.dependencies.join(", ") : "无"}。`);
    lines.push(`      // "${definition.name}",`);
  }

  lines.push("    ]", "  }", "}", "");
  return lines.join(newLine);
}
