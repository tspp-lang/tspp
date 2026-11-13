import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const developmentCompiler = join(root, "../compiler/built/local/typescript.js");
const ts = require(existsSync(developmentCompiler) ? developmentCompiler : "ts-plus-plus");

function optionSchema(option, allowNull = true) {
  let schema;
  if (option.type instanceof Map) {
    const choices = [...option.type.keys()];
    const patterns = choices.map(value => [...value].map(character => /[a-z]/i.test(character)
      ? `[${character.toLowerCase()}${character.toUpperCase()}]`
      : character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(""));
    schema = { type: "string", anyOf: [{ enum: choices }, { pattern: `^(?:${patterns.join("|")})$` }] };
  }
  else if (option.type === "list") schema = { type: "array", items: optionSchema(option.element, false) };
  else if (["boolean", "string", "number", "object"].includes(option.type)) schema = { type: option.type };
  else schema = {};
  if (allowNull && schema.type) {
    schema.type = [schema.type, "null"];
    if (schema.anyOf) schema.anyOf.push({ type: "null" });
  }
  if (option.description) schema.description = ts.flattenDiagnosticMessageText(option.description.message, "\n");
  return schema;
}

const compilerOptions = Object.fromEntries(ts.optionDeclarations
  .filter(option => !option.isCommandLineOnly)
  .map(option => [option.name, optionSchema(option)]));
compilerOptions.paths = { type: ["object", "null"], additionalProperties: { type: "array", items: { type: "string" } } };
compilerOptions.plugins = {
  ...compilerOptions.plugins,
  items: { type: "object", required: ["name"], properties: {
    name: { type: "string", description: "Plugin package name." },
    tspp: { type: "boolean", description: "Enable a TS++ feature capsule." },
  }, additionalProperties: true },
};
const stringList = { type: "array", items: { type: "string" } };
const schema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "TS++ project configuration",
  description: "TS++ compiler configuration. Generated from the bundled compiler's option declarations.",
  type: "object",
  allowComments: true,
  allowTrailingCommas: true,
  properties: {
    $schema: { type: "string" },
    extends: { anyOf: [{ type: "string" }, stringList] },
    compilerOptions: { type: "object", properties: compilerOptions, additionalProperties: false },
    files: stringList,
    include: stringList,
    exclude: stringList,
    references: { type: "array", items: { type: "object", required: ["path"], properties: {
      path: { type: "string", description: "TS++ configuration file or directory containing tsppconfig.json." },
      prepend: { type: "boolean" },
    } } },
    compileOnSave: { type: "boolean" },
    watchOptions: { type: "object", properties: Object.fromEntries((ts.optionsForWatch ?? []).map(option => [option.name, optionSchema(option)])) },
    typeAcquisition: { type: "object", properties: {
      enable: { type: "boolean" }, include: stringList, exclude: stringList,
      disableFilenameBasedTypeAcquisition: { type: "boolean" },
    } },
  },
  additionalProperties: false,
};
const output = join(root, "schemas/tsppconfig.schema.json");
const content = JSON.stringify(schema, null, 2) + "\n";
if (process.argv.includes("--check")) {
  if (!existsSync(output) || readFileSync(output, "utf8") !== content) {
    throw new Error("TS++ configuration schema is stale. Run the VS Code extension build.");
  }
} else {
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, content);
}
