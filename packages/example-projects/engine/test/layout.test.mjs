import assert from "node:assert/strict";
import { test } from "node:test";
import { Mat3, Vec2, Vec3 } from "../dist/math/index.js";
import { packVertices, writeUniforms } from "../dist/shader/index.js";

const vertexLayout = {
  stride: 20,
  attributes: [
    { name: "position", location: 0, offset: 0, format: "float32x3" },
    { name: "uv", location: 1, offset: 12, format: "float32x2" },
  ],
};

test("vertices are interleaved by the layout, ignoring fields the shader does not read", () => {
  const data = packVertices(vertexLayout, [
    { position: new Vec3(1, 2, 3), uv: new Vec2(0, 1), normal: new Vec3(9, 9, 9) },
    { position: new Vec3(4, 5, 6), uv: new Vec2(1, 0), normal: new Vec3(9, 9, 9) },
  ]);
  assert.deepEqual([...data], [1, 2, 3, 0, 1, 4, 5, 6, 1, 0]);
  assert.throws(() => packVertices(vertexLayout, [{ position: new Vec2(1, 2), uv: new Vec2(0, 0) }]), /vertex 0\.position: expected a value for vec3f/);
});

test("uniforms follow WGSL offsets, padding mat3 columns and nested structs", () => {
  const layout = {
    name: "Frame",
    size: 96,
    fields: [
      { name: "normal", offset: 0, type: "mat3x3f" },
      { name: "eye", offset: 48, type: "vec3f" },
      { name: "time", offset: 60, type: "f32" },
      { name: "light", offset: 64, type: "struct", layout: { name: "Light", size: 32, fields: [
        { name: "direction", offset: 0, type: "vec3f" },
        { name: "power", offset: 12, type: "f32" },
      ] } },
    ],
  };
  const data = writeUniforms(layout, {
    normal: new Mat3([1, 2, 3, 4, 5, 6, 7, 8, 9]),
    eye: new Vec3(10, 11, 12),
    time: 13,
    light: { direction: new Vec3(14, 15, 16), power: 17 },
  });
  assert.equal(data.length, 24);
  assert.deepEqual([...data.slice(0, 20)], [1, 2, 3, 0, 4, 5, 6, 0, 7, 8, 9, 0, 10, 11, 12, 13, 14, 15, 16, 17]);
  assert.throws(() => writeUniforms(layout, { normal: new Mat3([1, 0, 0, 0, 1, 0, 0, 0, 1]), eye: new Vec3(0, 0, 0), time: "now" }), /Frame\.time: expected a value for f32/);
  assert.throws(() => writeUniforms(layout, {}, new Float32Array(4)), /needs 96 bytes, not 16/);
});
