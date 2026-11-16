// Repository tasks are defined in TypeScript and executed by task-kit.
import { command, defineTasks, runTaskCli } from "../../packages/example-projects/task-kit/dist/index.js";

const tasks = defineTasks({
  "build": {
    description: "Build all compiler, editor and example products",
    dependencies: ["build:skills", "build:plugin-sdk", "build:plugins", "build:compiler", "build:example-projects", "build:language-server", "build:vscode", "build:playground", "build:tests"],
    dependencyMode: "serial",
  },
  "build:skills": {
    description: "Build skills",
    run: command("node", "scripts/build-skills.mjs"),
    forwardArgs: true,
  },
  "check:skills": {
    description: "Check skills",
    run: command("node", "scripts/build-skills.mjs", "--check"),
    forwardArgs: true,
  },
  "test:skills": {
    description: "Test skills",
    run: command("node", "--test", "scripts/build-skills.test.mjs"),
    forwardArgs: true,
  },
  "test:tasks": {
    description: "Test repository task plans and command argument forwarding",
    run: command("node", "--test", "scripts/task/integration.test.mjs"),
    forwardArgs: true,
  },
  "build:plugin-sdk": {
    description: "Build plugin sdk",
    run: command("pnpm", "--filter", "@tspp/plugin-sdk", "build"),
    forwardArgs: true,
  },
  "build:plugins": {
    description: "Build plugins",
    run: command("pnpm", "--workspace-concurrency=1", "--filter", "./packages/plugins/**", "build"),
    forwardArgs: true,
  },
  "build:compiler": {
    description: "Build compiler",
    run: command("pnpm", "--filter", "ts-plus-plus", "build:compiler"),
    forwardArgs: true,
  },
  "build:language-server": {
    description: "Build language server",
    run: command("pnpm", "--filter", "tspp-language-server", "build"),
    forwardArgs: true,
  },
  "build:tests": {
    description: "Build tests",
    run: command("pnpm", "--filter", "ts-plus-plus", "build:tests"),
    forwardArgs: true,
  },
  "build:example-projects": {
    description: "Build example projects",
    run: command("pnpm", "--filter", "./packages/example-projects/**", "build"),
    forwardArgs: true,
  },
  "test:example-projects": {
    description: "Test example projects",
    run: command("pnpm", "--filter", "./packages/example-projects/**", "test"),
    forwardArgs: true,
  },
  "build:vscode": {
    description: "Build vscode",
    run: command("pnpm", "--filter", "tspp-vscode", "build"),
    forwardArgs: true,
  },
  "build:playground": {
    description: "Build playground",
    run: command("pnpm", "--filter", "tspp-playground", "build"),
    forwardArgs: true,
  },
  "playground:dev": {
    description: "Playground dev",
    inheritStdin: true,
    run: command("pnpm", "--filter", "tspp-playground", "dev"),
    forwardArgs: true,
  },
  "build:vscode:dev": {
    description: "Build vscode dev",
    dependencies: ["build:plugin-sdk", "build:plugins", "build:compiler", "build:language-server", "build:vscode"],
    dependencyMode: "serial",
  },
  "test": {
    description: "Test",
    dependencies: ["test:skills", "test:tasks", "test:cli", "test:features", "test:examples", "test:example-projects", "test:compiler", "test:language-server", "test:editor-conformance:run", "test:vscode"],
    dependencyMode: "serial",
  },
  "test:cli": {
    description: "Test cli",
    run: command("node", "--test", "scripts/test-cli-runner.mjs"),
    forwardArgs: true,
  },
  "test:features": {
    description: "Test features",
    dependencies: ["test:plugin-sdk", "test:plugins", "test:plugins:together", "test:core-parity"],
    dependencyMode: "serial",
  },
  "test:plugins:run": {
    description: "Test plugins run",
    run: command("pnpm", "--workspace-concurrency=1", "--filter", "@tspp/plugin-sdk", "--filter", "./packages/plugins/**", "test:run"),
    forwardArgs: true,
  },
  "test:plugins:together": {
    description: "Test plugins together",
    run: command("node", "scripts/test-plugins-together.mjs"),
    forwardArgs: true,
  },
  "test:core-parity": {
    description: "Test core parity",
    run: command("pnpm", "--filter", "@tspp/core-parity-tests", "test"),
    forwardArgs: true,
  },
  "test:compiler": {
    description: "Test compiler",
    run: command("pnpm", "--filter", "ts-plus-plus", "test"),
    forwardArgs: true,
  },
  "test:compiler:tspp": {
    description: "Test compiler tspp",
    run: command("pnpm", "--filter", "ts-plus-plus", "exec", "hereby", "runtests", "--tests", "unittests:: (tspp::|MLTT)", "--lint=false"),
    forwardArgs: true,
  },
  "test:eslint-rules": {
    description: "Test eslint rules",
    run: command("pnpm", "--filter", "ts-plus-plus", "test:eslint-rules"),
    forwardArgs: true,
  },
  "test:language-server": {
    description: "Test language server",
    run: command("pnpm", "--filter", "tspp-language-server", "test:commit"),
    forwardArgs: true,
  },
  "test:editor-conformance": {
    description: "Test editor conformance",
    run: command("pnpm", "--filter", "@tspp/editor-conformance", "test"),
    forwardArgs: true,
  },
  "test:editor-conformance:run": {
    description: "Test editor conformance run",
    run: command("pnpm", "--filter", "@tspp/editor-conformance", "test:run"),
    forwardArgs: true,
  },
  "test:plugin-sdk": {
    description: "Test plugin sdk",
    run: command("pnpm", "--filter", "@tspp/plugin-sdk", "test"),
    forwardArgs: true,
  },
  "test:plugins": {
    description: "Test plugins",
    run: command("pnpm", "--workspace-concurrency=1", "--filter", "./packages/plugins/**", "test"),
    forwardArgs: true,
  },
  "test:examples": {
    description: "Test examples",
    run: command("node", "scripts/test-examples.mjs"),
    forwardArgs: true,
  },
  "test:vscode": {
    description: "Test vscode",
    run: command("pnpm", "--filter", "tspp-vscode", "test"),
    forwardArgs: true,
  },
  "test:playground": {
    description: "Test playground",
    run: command("pnpm", "--filter", "tspp-playground", "test:smoke"),
    forwardArgs: true,
  },
  "lint": {
    description: "Lint",
    dependencies: ["lint:compiler", "lint:packages"],
    dependencyMode: "serial",
  },
  "lint:compiler": {
    description: "Lint compiler",
    run: command("pnpm", "--filter", "ts-plus-plus", "lint"),
    forwardArgs: true,
  },
  "lint:language-server": {
    description: "Lint language server",
    run: command("pnpm", "--filter", "tspp-language-server", "lint"),
    forwardArgs: true,
  },
  "lint:packages": {
    description: "Lint packages",
    run: command("pnpm", "--workspace-concurrency=1", "--filter", "@tspp/plugin-sdk", "--filter", "./packages/plugins/**", "--filter", "tspp-vscode", "--filter", "tspp-playground", "--filter", "./packages/examples/**", "lint"),
    forwardArgs: true,
  },
  "pack:release": {
    description: "Pack release",
    run: command("node", "scripts/pack-release.mjs"),
    forwardArgs: true,
  },
  "test:release": {
    description: "Test release",
    run: command("node", "scripts/test-release.mjs"),
    forwardArgs: true,
  },
  "knip": {
    description: "Knip",
    run: command("pnpm", "--filter", "ts-plus-plus", "knip"),
    forwardArgs: true,
  },
  "core-diff": {
    description: "Core diff",
    run: command("node", "scripts/core-diff.mjs"),
    forwardArgs: true,
  },
  "core-diff:check": {
    description: "Core diff check",
    run: command("node", "scripts/core-diff.mjs", "--check"),
    forwardArgs: true,
  },
  "lsp-diff": {
    description: "Lsp diff",
    run: command("node", "scripts/core-diff.mjs", "--target", "lsp"),
    forwardArgs: true,
  },
  "lsp-diff:check": {
    description: "Lsp diff check",
    run: command("node", "scripts/core-diff.mjs", "--target", "lsp", "--check"),
    forwardArgs: true,
  },
  "format": {
    description: "Format",
    run: command("pnpm", "--filter", "ts-plus-plus", "format"),
    forwardArgs: true,
  },
  "clean": {
    description: "Clean",
    run: [command("pnpm", "--filter", "@tspp/plugin-sdk", "run", "clean"), command("pnpm", "--filter", "./packages/plugins/**", "run", "clean"), command("pnpm", "--filter", "ts-plus-plus", "run", "clean"), command("pnpm", "--filter", "tspp-language-server", "run", "clean")],
    forwardArgs: true,
  },
  "check": {
    description: "Run repository checks and lint",
    dependencies: ["check:skills", "check:tasks", "check:example-projects", "check:language-server", "check:playground", "lint"],
    dependencyMode: "serial",
  },
  "check:language-server": {
    description: "Type-check the language server",
    run: command("pnpm", "--filter", "tspp-language-server", "typecheck"),
  },
  "check:tasks": {
    description: "Check task definitions and bootstrap script",
    run: [command("node", "--check", "scripts/bootstrap-tasks.mjs"), command("node", "node_modules/typescript/bin/tsc", "-p", "scripts/task/tsconfig.json", "--noEmit", "--pretty", "false")],
  },
  "check:playground": {
    description: "Type-check the playground",
    run: command("pnpm", "--filter", "tspp-playground", "typecheck"),
  },
  "check:example-projects": {
    description: "Check example projects",
    run: command("pnpm", "--filter", "./packages/example-projects/**", "check"),
    forwardArgs: true,
  },
});

runTaskCli(tasks, { rootDir: process.cwd() }).then((code: number) => {
  process.exitCode = code;
}).catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
