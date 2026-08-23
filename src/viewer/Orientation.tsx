/**
 * Always-on orientation aids.
 *
 * Exists because you could not tell which way +Z pointed without playing the
 * animation and watching something move. In a tool where every authored motion
 * is expressed as "+90mm in Z", that is a real problem.
 */
import { useEffect, useMemo } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';

export const AXIS_COLORS = {
  x: '#ff4d4d',
  y: '#4dff88',
  z: '#4d94ff',
} as const;

const TRIAD_SIZE = 96;

/** Module-level scratch: no allocation in the frame loop (AGENTS.md 7). */
const _size = new THREE.Vector2();

/**
 * A fixed triad in the lower-left corner mirroring the main camera's
 * orientation. Rendered by a second camera into a scissored viewport so it
 * always sits on top and never scales with the model.
 */
export function AxisTriad({ size = TRIAD_SIZE }: { size?: number }) {
  const { gl, camera, scene: mainScene } = useThree();

  const { scene, cam } = useMemo(() => {
    const s = new THREE.Scene();
    const c = new THREE.PerspectiveCamera(50, 1, 0.1, 100);

    const mkAxis = (dir: THREE.Vector3, color: string) => {
      const group = new THREE.Group();
      const mat = new THREE.MeshBasicMaterial({ color, depthTest: false });
      const up = new THREE.Vector3(0, 1, 0);

      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1, 8), mat);
      shaft.position.copy(dir).multiplyScalar(0.5);
      shaft.quaternion.setFromUnitVectors(up, dir);

      const head = new THREE.Mesh(new THREE.ConeGeometry(0.15, 0.34, 12), mat);
      head.position.copy(dir).multiplyScalar(1.15);
      head.quaternion.setFromUnitVectors(up, dir);

      group.add(shaft, head);
      return group;
    };

    s.add(mkAxis(new THREE.Vector3(1, 0, 0), AXIS_COLORS.x));
    s.add(mkAxis(new THREE.Vector3(0, 1, 0), AXIS_COLORS.y));
    s.add(mkAxis(new THREE.Vector3(0, 0, 1), AXIS_COLORS.z));

    s.add(new THREE.Mesh(
      new THREE.SphereGeometry(0.1, 12, 12),
      new THREE.MeshBasicMaterial({ color: '#c8cede', depthTest: false }),
    ));

    return { scene: s, cam: c };
  }, []);

  useEffect(() => () => {
    scene.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      if (m.material) (m.material as THREE.Material).dispose();
    });
  }, [scene]);

  useFrame(() => {
    // CRITICAL: any useFrame with priority > 0 DISABLES R3F's automatic
    // render, so this callback owns the whole frame. Render the main scene
    // first, then overlay the triad. Omitting the first render blanks the
    // viewport entirely — which is exactly what happened when this was added.
    const sizeVec = gl.getSize(_size);

    gl.setScissorTest(false);
    gl.setViewport(0, 0, sizeVec.x, sizeVec.y);
    gl.render(mainScene, camera);

    // Copy only the ROTATION: the triad shows direction, not position.
    cam.position.set(0, 0, 3.6).applyQuaternion(camera.quaternion);
    cam.quaternion.copy(camera.quaternion);

    // setViewport/setScissor take CSS pixels; three.js applies the pixel
    // ratio internally. Passing device pixels double-scales the corner.
    const prevAutoClear = gl.autoClear;
    gl.autoClear = false;
    gl.clearDepth();
    gl.setScissorTest(true);
    gl.setViewport(16, 16, size, size);
    gl.setScissor(16, 16, size, size);
    gl.render(scene, cam);

    gl.setScissorTest(false);
    gl.setViewport(0, 0, sizeVec.x, sizeVec.y);
    gl.autoClear = prevAutoClear;
  }, 1); // priority 1 => this callback drives rendering for the whole app

  return null;
}

/** A small marker at world origin so "zero" is locatable in an empty view. */
export function OriginMarker({ scale = 1 }: { scale?: number }) {
  const len = Math.max(scale * 0.08, 1);
  return (
    <group>
      {(['x', 'y', 'z'] as const).map((axis) => {
        const dir: [number, number, number] =
          axis === 'x' ? [len, 0, 0] : axis === 'y' ? [0, len, 0] : [0, 0, len];
        const geom = new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(0, 0, 0),
          new THREE.Vector3(...dir),
        ]);
        return (
          // eslint-disable-next-line react/no-unknown-property
          <primitive
            key={axis}
            object={new THREE.Line(
              geom,
              new THREE.LineBasicMaterial({ color: AXIS_COLORS[axis], depthTest: false }),
            )}
          />
        );
      })}
    </group>
  );
}
