// `shaderModule` runs while a consumer compiles, so these tests compile the consumers in `fixture` and `invalid`,
// which import this package by name as other projects do.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Mat3, Mat4, Vec3, Vec4 } from "../dist/math/index.js";
import { writeUniforms } from "../dist/shader/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const tspp = path.join(path.dirname(createRequire(import.meta.url).resolve("ts-plus-plus/package.json")), "bin", "tspp");

/** Compiles a project and returns its diagnostics; an empty string means it compiled. */
function compile(project) {
  try {
    execFileSync(process.execPath, [tspp, "--compile", "-p", path.join(here, project, "tsppconfig.json"), "--pretty", "false"], { encoding: "utf8", stdio: "pipe" });
    return "";
  }
  catch (error) {
    return `${error.stdout}${error.stderr}`;
  }
}

test("a shader namespace compiles to WGSL with its structs, bindings, helpers and entries", async () => {
  assert.equal(compile("fixture"), "");
  const { LitModule } = await import("./fixture/dist/lit.js");
  const code = LitModule.code;
  assert.match(code, /struct Vertex \{\n {2}@location\(0\) position: vec3f,\n {2}@location\(1\) normal: vec3f,\n\}/);
  assert.match(code, /struct Surface \{\n {2}@builtin\(position\) clip: vec4f,\n {2}@location\(0\) world: vec3f,/);
  assert.match(code, /struct Frame \{[^}]*eye: vec3f,\n {2}time: f32,\n {2}@align\(16\) @size\(32\) light: Light,\n\}/);
  assert.match(code, /@group\(0\) @binding\(0\) var<uniform> frame: Frame;/);
  assert.match(code, /fn shade\(normal: vec3f, toLight: vec3f, toEye: vec3f, shininess: f32\) -> f32 \{\n {2}let diffuse = max\(dot\(normal, toLight\), 0\.0\);\n {2}var specular = 0\.0;\n {2}if \(diffuse > 0\.0\) \{/);
  assert.match(code, /@vertex fn vertex\(input: Vertex\) -> Surface \{\n {2}let world = frame\.model \* vec4f\(input\.position, 1\.0\);/);
  assert.match(code, /@fragment fn fragment\(surface: Surface\) -> @location\(0\) vec4f \{/);
  assert.match(code, /return vec4f\(color\.x, color\.y, color\.z, 1\.0\);/);
  assert.deepEqual(LitModule.vertex, {
    entry: "vertex",
    layout: { stride: 24, attributes: [
      { name: "position", location: 0, offset: 0, format: "float32x3" },
      { name: "normal", location: 1, offset: 12, format: "float32x3" },
    ] },
  });
  const [frame] = LitModule.bindings;
  assert.equal(frame.name, "frame");
  assert.equal(frame.layout.size, 224);
  assert.deepEqual(frame.layout.fields.map(field => [field.name, field.offset]), [["viewProjection", 0], ["model", 64], ["normalMatrix", 128], ["eye", 176], ["time", 188], ["light", 192]]);
});

test("the functions of a shader namespace still run on the CPU, and their uniforms pack for the GPU", async () => {
  const { Lit, LitModule } = await import("./fixture/dist/lit.js");
  const frame = {
    viewProjection: Mat4.identity(),
    model: Mat4.translation(new Vec3(0, 1, 0)),
    normalMatrix: Mat3.identity(),
    eye: new Vec3(0, 0, 5),
    time: 0,
    light: { direction: new Vec3(0, 0, -1), color: new Vec3(1, 1, 1) },
  };
  const surface = Lit.vertex({ position: new Vec3(0, 0, 0), normal: new Vec3(0, 0, 1) }, frame);
  assert.ok(surface.clip.equals(new Vec4(0, 1, 0, 1)));
  const lit = Lit.fragment(surface, frame);
  const away = Lit.fragment({ ...surface, normal: new Vec3(0, 0, -1) }, frame);
  assert.ok(lit.x > away.x, `a surface facing the light is brighter: ${lit} vs ${away}`);
  assert.equal(writeUniforms(LitModule.bindings[0].layout, frame).length, 56);
});

test("constructs that WGSL cannot express are compile errors at the invocation", () => {
  const output = compile("invalid");
  const failures = output.split("\n").filter(line => line.includes("TS18080")).map(line => line.replace(/^.*failed: /u, ""));
  assert.deepEqual(failures, [
    "Untyped (line 11, column 3): the vertex entry: write the type, since WGSL needs it",
    "Random (line 18, column 41): a shader cannot call Math.random; call the built-in of @tspp/engine/math instead",
    "Global (line 23, column 3): a shader namespace holds only functions, interfaces and type aliases",
    "Unclipped (line 30, column 42): NoPosition needs a field of type Builtin<\"position\", Vec4> for the clip-space position",
    "Optional (line 7, column 37): Settings.tint: a shader struct has no optional fields",
    "Looping (line 43, column 20): a shader cannot contain an array literal expression",
    "Twice (line 49, column 48): Vertex cannot be both a vertex input and a uniform",
    "Callback (line 56, column 20): a shader cannot contain a non null expression",
  ]);
  assert.match(output, /invalid\.tspp\(70,14\): error TS2322: Type 'Vec3' is not assignable to type 'Vec2'\.\n {2}Types have separate declarations of a private property 'size'/);
});
