// The materials are shader functions that also run on the CPU, so their look can be checked without a GPU.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Mat3, Mat4, Vec2, Vec3, Vec4 } from "@tspp/engine/math";
import { Normals, NormalsModule, Plastic, PlasticModule, Tiles, TilesModule } from "../dist/shaders/materials.js";

const frame = {
  viewProjection: Mat4.identity(),
  eye: new Vec3(0, 0, 5),
  lightDirection: new Vec3(0, -1, 0),
  lightColor: new Vec3(1, 1, 1),
  sky: new Vec3(0.5, 0.7, 0.9),
  ground: new Vec3(0.3, 0.2, 0.1),
  time: 0,
};
const model = { matrix: Mat4.identity(), normalMatrix: Mat3.identity(), color: new Vec3(0.8, 0.2, 0.2), shininess: 32 };
const surfaceAt = (world, normal) => ({ clip: new Vec4(0, 0, 0, 1), world, normal, uv: new Vec2(0, 0) });
const brightness = color => color.x + color.y + color.z;

test("plastic is brightest where it faces the sun, and stays within display range", () => {
  const top = Plastic.fragment(surfaceAt(new Vec3(0, 1, 0), new Vec3(0, 1, 0)), frame, model);
  const side = Plastic.fragment(surfaceAt(new Vec3(1, 0, 0), new Vec3(1, 0, 0)), frame, model);
  const bottom = Plastic.fragment(surfaceAt(new Vec3(0, -1, 0), new Vec3(0, -1, 0)), frame, model);
  assert.ok(brightness(top) > brightness(side) && brightness(side) > brightness(bottom), `${top} ${side} ${bottom}`);
  assert.ok(top.x > top.y, "the model's red shows through");
  for (const value of [...top.components, ...bottom.components]) assert.ok(value >= 0 && value <= 1, String(value));
  assert.equal(top.w, 1);
});

test("tiles alternate between light and dark squares and fade into the sky far away", () => {
  assert.equal(Tiles.parity(0.5, 0.5), 0);
  assert.equal(Tiles.parity(1.5, 0.5), 1);
  assert.equal(Tiles.parity(-0.5, 0.5), 1);
  const up = new Vec3(0, 1, 0);
  const light = Tiles.fragment(surfaceAt(new Vec3(1.5, 0, 0.5), up), frame, model);
  const dark = Tiles.fragment(surfaceAt(new Vec3(0.5, 0, 0.5), up), frame, model);
  assert.ok(brightness(light) > brightness(dark));
  const far = Tiles.fragment(surfaceAt(new Vec3(0.5, 0, -40), up), frame, model);
  const sky = Normals.fragment(surfaceAt(new Vec3(0, 0, 0), up), frame, model);
  assert.ok(Math.abs(far.z - Math.pow(0.9 / 1.9, 1 / 2.2)) < 1e-9, `the far floor shows the sky: ${far}`);
  assert.ok(sky.equals(new Vec4(0.5, 1, 0.5, 1)), "the normal view shows +y as green");
});

test("the vertex stage places model vertices in the world", () => {
  const moved = { ...model, matrix: Mat4.translation(new Vec3(2, 0, 0)) };
  const surface = Plastic.vertex({ position: new Vec3(1, 1, 1), normal: new Vec3(0, 0, 1), uv: new Vec2(0.25, 0.75) }, frame, moved);
  assert.ok(surface.world.equals(new Vec3(3, 1, 1)));
  assert.ok(surface.clip.equals(new Vec4(3, 1, 1, 1)));
  assert.ok(surface.uv.equals(new Vec2(0.25, 0.75)));
});

test("every material is compiled with the same vertex layout and bindings, so meshes and bind groups are shared", () => {
  for (const module of [PlasticModule, TilesModule, NormalsModule]) {
    assert.equal(module.vertex.layout.stride, 32);
    assert.deepEqual(module.bindings.map(binding => [binding.name, binding.binding, binding.layout.size]), [["frame", 0, 144], ["model", 1, 128]]);
    assert.match(module.code, /fn placeSurface\(vertex: StandardVertex, frame: Frame, model: Model\) -> Surface/);
  }
  assert.match(TilesModule.code, /fn parity\(x: f32, z: f32\) -> f32/);
  assert.doesNotMatch(PlasticModule.code, /fn parity/);
});
