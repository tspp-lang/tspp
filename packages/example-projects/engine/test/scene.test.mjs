import assert from "node:assert/strict";
import { test } from "node:test";
import { Vec3 } from "../dist/math/index.js";
import { Box, meshOf, OrbitCamera, Plane, Sphere, Torus, Transform } from "../dist/scene/index.js";

test("generated meshes wind counterclockwise from outside, with unit normals that point outward", () => {
  const shapes = { box: Box(new Vec3(1, 2, 3)), sphere: Sphere(1, 12, 8), plane: Plane(2, 3), torus: Torus(1, 0.3, 16, 8) };
  for (const [name, shape] of Object.entries(shapes)) {
    const { vertices, indices } = meshOf(shape);
    assert.equal(indices.length % 3, 0, name);
    assert.ok(indices.every(index => index < vertices.length), `${name}: indices stay in range`);
    for (const vertex of vertices) assert.ok(Math.abs(vertex.normal.length() - 1) < 1e-9, `${name}: unit normals`);
    for (let i = 0; i < indices.length; i += 3) {
      const [a, b, c] = [indices[i], indices[i + 1], indices[i + 2]].map(index => vertices[index]);
      const face = b.position.sub(a.position).cross(c.position.sub(a.position));
      if (face.length() < 1e-12) continue; // the poles of a sphere
      const normal = a.normal.add(b.normal).add(c.normal);
      assert.ok(face.dot(normal) > 0, `${name}: triangle ${i / 3} faces its normals`);
      const center = a.position.add(b.position).add(c.position);
      const core = name === "torus" ? new Vec3(center.x, 0, center.z).normalize().scale(3) : new Vec3(0, 0, 0);
      if (name !== "plane") assert.ok(normal.dot(center.sub(core)) > 0, `${name}: triangle ${i / 3} faces outward`);
    }
  }
  assert.throws(() => meshOf(Sphere(1, 2, 8)), /segments must be an integer of at least 3/);
});

test("an orbit camera circles its target within the pitch and distance limits", () => {
  const camera = new OrbitCamera(new Vec3(0, 0, 0), 5, 0, 0, 1);
  assert.ok(camera.eye().sub(new Vec3(0, 0, 5)).length() < 1e-9);
  const raised = camera.orbited(0, 10);
  assert.ok(raised.pitch < Math.PI / 2 && raised.eye().y > 4.9, "pitch stops short of straight down");
  assert.equal(camera.zoomed(1000).distance, 100);
  assert.equal(camera.distance, 5, "the original camera is unchanged");
});

test("a transform scales, rotates, then moves", () => {
  const transform = new Transform(new Vec3(1, 0, 0), new Vec3(0, Math.PI / 2, 0), new Vec3(2, 2, 2));
  const point = transform.matrix().transformPoint(new Vec3(1, 0, 0));
  assert.ok(point.sub(new Vec3(1, 0, -2)).length() < 1e-9, String(point));
});
