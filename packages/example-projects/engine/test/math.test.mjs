import assert from "node:assert/strict";
import { test } from "node:test";
import { clamp, dot, Mat3, Mat4, mix, normalize, reflect, smoothstep, step, Vec2, Vec3, Vec4, vec3, vec4 } from "../dist/math/index.js";

const close = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-9, `${message ?? ""} ${actual} ≠ ${expected}`);
const closeVector = (actual, expected) => actual.components.forEach((value, index) => close(value, expected.components[index], `component ${index}`));

test("vectors are immutable values with componentwise arithmetic", () => {
  const a = new Vec3(1, 2, 3);
  assert.ok(a.add(new Vec3(1, 1, 1)).equals(new Vec3(2, 3, 4)));
  assert.ok(a.mul(new Vec3(2, 0, -1)).equals(new Vec3(2, 0, -3)));
  assert.ok(a.equals(new Vec3(1, 2, 3)), "the original is unchanged");
  assert.equal(a.dot(new Vec3(4, 5, 6)), 32);
  assert.ok(new Vec3(1, 0, 0).cross(new Vec3(0, 1, 0)).equals(new Vec3(0, 0, 1)));
  close(new Vec2(3, 4).normalize().length(), 1);
  assert.ok(new Vec4(1, 2, 3, 4).xyz.equals(a));
});

test("built-ins apply to numbers and to each component of vectors", () => {
  assert.equal(mix(2, 4, 0.25), 2.5);
  assert.ok(mix(vec3(0), vec3(2, 4, 6), 0.5).equals(new Vec3(1, 2, 3)));
  assert.ok(clamp(new Vec2(-1, 5), new Vec2(0, 0), new Vec2(1, 1)).equals(new Vec2(0, 1)));
  assert.equal(step(0.5, 0.2), 0);
  assert.equal(smoothstep(0, 1, 0.5), 0.5);
  assert.ok(vec4(new Vec3(1, 2, 3), 1).equals(new Vec4(1, 2, 3, 1)));
  closeVector(reflect(normalize(new Vec3(1, -1, 0)), new Vec3(0, 1, 0)), normalize(new Vec3(1, 1, 0)));
  assert.equal(dot(new Vec2(1, 2), new Vec2(3, 4)), 11);
});

test("matrices compose transforms in column-major order", () => {
  const move = Mat4.translation(new Vec3(1, 2, 3));
  const turn = Mat4.rotation(new Vec3(0, 0, 1), Math.PI / 2);
  // Rotate first, then move.
  closeVector(move.mul(turn).transformPoint(new Vec3(1, 0, 0)), new Vec3(1, 3, 3));
  assert.ok(Mat4.identity().mul(move).equals(move));
  const scale = Mat4.scaling(new Vec3(2, 4, 8));
  closeVector(scale.normalMatrix().mul(new Vec3(1, 1, 1)), new Vec3(0.5, 0.25, 0.125));
  assert.throws(() => new Mat3([1, 2, 3]), /9 elements/);
  assert.throws(() => new Mat3([1, 2, 3, 2, 4, 6, 0, 0, 1]).inverse(), /singular/);
});

test("lookAt and perspective map the view frustum to WebGPU clip space", () => {
  const eye = new Vec3(0, 0, 5);
  const view = Mat4.lookAt(eye, new Vec3(0, 0, 0), new Vec3(0, 1, 0));
  closeVector(view.transformPoint(eye), new Vec3(0, 0, 0));
  closeVector(view.transformPoint(new Vec3(0, 0, 0)), new Vec3(0, 0, -5));
  const projection = Mat4.perspective(Math.PI / 2, 1, 1, 10);
  close(projection.transformPoint(new Vec3(0, 0, -1)).z, 0, "near plane");
  close(projection.transformPoint(new Vec3(0, 0, -10)).z, 1, "far plane");
  assert.throws(() => Mat4.perspective(1, 1, 0, 10), /0 < near < far/);
});
