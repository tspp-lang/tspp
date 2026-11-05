import { applyEdits, findNodeAtLocation, getNodeValue, modify, parseTree, printParseErrorCode, type Node, type ParseError } from "jsonc-parser";
import type { DiagnosticInfo, FeatureDefinition } from "./protocol";

export interface ProjectConfiguration {
  readonly features: readonly string[];
  readonly diagnostics: readonly DiagnosticInfo[];
  readonly runBlockReason?: string;
}

export function defaultConfiguration(features: readonly string[], definitions: readonly FeatureDefinition[]): string {
  const plugins = features.flatMap(id => {
    const definition = definitions.find(candidate => candidate.id === id);
    return definition ? [{ name: definition.packageName, tspp: true }] : [];
  });
  return JSON.stringify({
    compilerOptions: {
      strict: true,
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "Bundler",
      plugins,
    },
    include: ["src/**/*.ts", "src/**/*.tspp"],
  }, null, 2) + "\n";
}

const diagnostic = (message: string, node?: Node, category: DiagnosticInfo["category"] = "error"): DiagnosticInfo => ({
  fileName: "/tsconfig.json",
  span: node && { start: node.offset, length: node.length },
  message,
  code: 18000,
  category,
  unnecessary: false,
  deprecated: false,
});

function propertyNode(root: Node, path: readonly string[]): Node | undefined {
  return findNodeAtLocation(root, path)?.parent;
}

/** Reads the browser-supported portion of tsconfig and produces user-facing compatibility diagnostics. */
export function parseProjectConfiguration(text: string, definitions: readonly FeatureDefinition[]): ProjectConfiguration {
  const errors: ParseError[] = [];
  const root = parseTree(text, errors, { allowTrailingComma: true, disallowComments: false });
  const diagnostics = errors.map(error => diagnostic(
    `Invalid tsconfig.json: ${printParseErrorCode(error.error)}.`,
    { offset: error.offset, length: error.length } as Node,
  ));
  if (!root || root.type !== "object") {
    if (!errors.length) diagnostics.push(diagnostic("tsconfig.json must contain a JSON object.", root));
    return { features: [], diagnostics };
  }

  const unsupportedTopLevel: Record<string, string> = {
    extends: "The Playground cannot load an external 'extends' configuration. Copy those options into this tsconfig.json.",
    references: "TypeScript project references are not supported in the Playground.",
  };
  for (const [name, message] of Object.entries(unsupportedTopLevel)) {
    const node = propertyNode(root, [name]);
    if (node) diagnostics.push(diagnostic(message, node));
  }

  const pluginsNode = findNodeAtLocation(root, ["compilerOptions", "plugins"]);
  const plugins = pluginsNode && getNodeValue(pluginsNode);
  const features: string[] = [];
  if (pluginsNode && !Array.isArray(plugins)) diagnostics.push(diagnostic("compilerOptions.plugins must be an array.", pluginsNode));
  else if (Array.isArray(plugins)) {
    for (let index = 0; index < plugins.length; index++) {
      const value = plugins[index] as { name?: unknown; tspp?: unknown } | null;
      if (!value || typeof value !== "object" || typeof value.name !== "string") continue;
      if (value.tspp !== true) continue;
      const definition = definitions.find(candidate => candidate.packageName === value.name);
      const node = findNodeAtLocation(root, ["compilerOptions", "plugins", index]);
      if (definition) features.push(definition.id);
      else diagnostics.push(diagnostic(`TSPP plugin '${value.name}' is not available in this Playground build.`, node));
    }
  }

  const moduleNode = findNodeAtLocation(root, ["compilerOptions", "module"]);
  const moduleValue: unknown = moduleNode && getNodeValue(moduleNode);
  const moduleKind = typeof moduleValue === "string" ? moduleValue.toLowerCase() : undefined;
  const runnableModules = new Set(["commonjs", "node16", "nodenext", "es6", "es2015", "es2020", "es2022", "esnext", "preserve"]);
  const runBlockReason = moduleKind && !runnableModules.has(moduleKind)
    ? `Run is unavailable because tsconfig.json uses module '${moduleValue}'. The browser runner supports CommonJS, Node16, NodeNext, ES2015, ES2020, ES2022, ESNext, and Preserve modules.`
    : undefined;
  if (runBlockReason) diagnostics.push(diagnostic(runBlockReason, moduleNode, "warning"));

  return { features, diagnostics, runBlockReason };
}

/** Adds or removes one known TSPP plugin while preserving the rest of the JSONC document. */
export function setFeatureInConfiguration(
  text: string,
  definition: FeatureDefinition,
  enabled: boolean,
): string | undefined {
  const errors: ParseError[] = [];
  const root = parseTree(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (!root || errors.length) return undefined;
  const pluginsNode = findNodeAtLocation(root, ["compilerOptions", "plugins"]);
  const existing = pluginsNode ? getNodeValue(pluginsNode) : [];
  if (!Array.isArray(existing)) return undefined;
  const plugins = existing.filter(plugin => !(plugin && typeof plugin === "object"
    && (plugin as { name?: unknown }).name === definition.packageName));
  if (enabled) plugins.push({ name: definition.packageName, tspp: true });
  return applyEdits(text, modify(text, ["compilerOptions", "plugins"], plugins, {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
  }));
}
