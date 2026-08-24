/**
 * The visible, draggable section plane.
 *
 * A translucent quad + border at the cut, draggable along its own normal —
 * the same interaction grammar as the part gizmo: live preview during the
 * drag (store writes marked live), ONE undo entry per drag (beginGesture on
 * grab), commit is just the last live write.
 *
 * Rendered only while the active operation has a section. The quad itself is
 * never clipped (renderOrder + no clippingPlanes) and never pickable by the
 * selection raycaster (name guard in PickHandler).
 */
import { useCallback, useMemo, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { useStore } from '@/state/store';

const AXIS_DIR: Record<'X' | 'Y' | 'Z', THREE.Vector3> = {
  X: new THREE.Vector3(1, 0, 0),
  Y: new THREE.Vector3(0, 1, 0),
  Z: new THREE.Vector3(0, 0, 1),
};
// Quad orientation: rotate the XY-plane quad so +Z aligns with the axis.
const QUAD_ROT: Record<'X' | 'Y' | 'Z', [number, number, number]> = {
  X: [0, Math.PI / 2, 0],
  Y: [-Math.PI / 2, 0, 0],
  Z: [0, 0, 0],
};

const _ray = new THREE.Ray();
const _tmp = new THREE.Vector3();

interface Props {
  diagonal: number;
  center: [number, number, number];
}

export function SectionPlane({ diagonal, center }: Props) {
  const { camera, gl } = useThree();
  const sequence = useStore((s) => s.sequence);
  const activeOperationId = useStore((s) => s.activeOperationId);
  const setSection = useStore((s) => s.setSection);
  const beginGesture = useStore((s) => s.beginGesture);

  const op = sequence?.operations.find((o) => o.id === activeOperationId);
  const section = op?.section ?? null;

  const dragState = useRef<{ startOffset: number; startT: number } | null>(null);

  const size = diagonal * 1.05;

  /**
   * Closest-approach parameter between the pointer ray and the axis line:
   * where along the section axis the cursor "is". Classic skew-lines math —
   * this is exactly how TransformControls drags an arrow.
   */
  const axisTFromPointer = useCallback(
    (e: PointerEvent): number | null => {
      const rect = gl.domElement.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      );
      const rc = new THREE.Raycaster();
      rc.setFromCamera(ndc, camera);
      _ray.copy(rc.ray);
      if (!section) return null;

      const dir = AXIS_DIR[section.axis];
      const origin = _tmp.set(center[0], center[1], center[2]);
      // Solve for t on line: origin + t*dir closest to the pointer ray.
      const w0 = origin.clone().sub(_ray.origin);
      const a = 1; // dir·dir
      const b = dir.dot(_ray.direction);
      const c = 1; // ray dir normalized
      const d = dir.dot(w0);
      const e2 = _ray.direction.dot(w0);
      const denom = a * c - b * b;
      if (Math.abs(denom) < 1e-6) return null;
      return (b * e2 - c * d) / denom;
    },
    [camera, gl, section, center],
  );

  const onPointerDown = useCallback(
    (e: { stopPropagation: () => void; nativeEvent: PointerEvent }) => {
      if (!section || !activeOperationId) return;
      e.stopPropagation();
      const t = axisTFromPointer(e.nativeEvent);
      if (t === null) return;

      beginGesture('Move section plane');
      dragState.current = { startOffset: section.offset, startT: t };

      const onMove = (ev: PointerEvent) => {
        const st = dragState.current;
        if (!st) return;
        const t2 = axisTFromPointer(ev);
        if (t2 === null) return;
        setSection(
          activeOperationId,
          { ...section, offset: st.startOffset + (t2 - st.startT) },
          true, // live: no checkpoint per move
        );
      };
      const onUp = () => {
        dragState.current = null;
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
    [section, activeOperationId, axisTFromPointer, beginGesture, setSection],
  );

  const position = useMemo(() => {
    if (!section) return new THREE.Vector3();
    const p = new THREE.Vector3(center[0], center[1], center[2]);
    // The plane sits at `offset` along its axis in WORLD terms; the other two
    // coordinates center on the model.
    if (section.axis === 'X') p.x = section.offset;
    if (section.axis === 'Y') p.y = section.offset;
    if (section.axis === 'Z') p.z = section.offset;
    return p;
  }, [section, center]);

  if (!section) return null;

  return (
    <group position={position} rotation={QUAD_ROT[section.axis]} name="__sectionPlane">
      {/* the face — grab anywhere on it */}
      <mesh onPointerDown={onPointerDown} renderOrder={999}>
        <planeGeometry args={[size, size]} />
        <meshBasicMaterial
          color={0xf08c00}
          transparent
          opacity={0.08}
          side={THREE.DoubleSide}
          depthWrite={false}
        />
      </mesh>
      {/* the border, so the cut plane reads even when nearly edge-on */}
      <lineSegments renderOrder={999}>
        <edgesGeometry args={[new THREE.PlaneGeometry(size, size)]} />
        <lineBasicMaterial color={0xf08c00} transparent opacity={0.9} />
      </lineSegments>
    </group>
  );
}
