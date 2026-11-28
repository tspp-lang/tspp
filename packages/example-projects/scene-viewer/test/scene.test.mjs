import assert from "node:assert/strict";
import { test } from "node:test";
import { Vec3 } from "@tspp/engine/math";
import { demoScene, sunDirection, transformAt } from "../dist/scene.js";

test("the demo scene stands a sphere, a box and a torus on a floor", () => {
  const scene = demoScene();
  assert.deepEqual(scene.map(object => object.name), ["floor", "sphere", "box", "torus"]);
  assert.ok(scene.every(object => object.name === "floor" || object.transform.position.y > 0), "the objects stand above the floor");
});

test("objects turn by their spin over time", () => {
  const torus = demoScene().find(object => object.name === "torus");
  const later = transformAt(torus, 2);
  assert.ok(later.rotation.equals(torus.spin.scale(2)));
  assert.ok(later.position.equals(torus.transform.position));
});

test("sunlight comes down from 50 degrees above the horizon", () => {
  const direction = sunDirection(0);
  assert.ok(Math.abs(direction.length() - 1) < 1e-12);
  assert.ok(Math.abs(Math.asin(-direction.y) - (50 * Math.PI) / 180) < 1e-12);
  assert.ok(sunDirection(Math.PI).sub(new Vec3(-direction.x, direction.y, -direction.z)).length() < 1e-12);
});
