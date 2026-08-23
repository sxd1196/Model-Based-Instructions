/**
 * Direct manipulation: click-to-select and gizmo drag.
 *
 * All the math lives in `domain/authoring.ts`; this file only converts three.js
 * events into those calls. Keep it that way — logic here is untestable.
 */
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import { TransformControls } from '@react-three/drei';
import * as THREE from 'three';
import { useStore } from '@/state/store';
import { indexScene } from '@/cad/loadGltf';
import type { Assembly } from '@/domain/schema';

interface Props {
  scene: THREE.Object3D | null;
  assembly: Assembly | null;
}

/**
 * Raycast picking on the canvas.
 *
 * Bound to pointerup with a movement threshold rather than click, so orbiting
 * the camera never changes the selection — that misfire is maddening when
 * authoring.
 */
export function PickHandler({ scene, assembly }: Props) {
  const { camera, gl } = useThree();
  const pickPart = useStore((s) => s.pickPart);
  const clearSelection = useStore((s) => s.clearSelection);
  const pickEnabled = useStore((s) => s.pickEnabled);

  const index = useMemo(
    () => (scene && assembly ? indexScene(scene, assembly) : new Map()),
    [scene, assembly],
  );

  const objToId = useMemo(() => {
    const m = new Map<THREE.Object3D, string>();
    for (const [id, obj] of index) m.set(obj, id);
    return m;
  }, [index]);

  const down = useRef<{ x: number; y: number } | null>(null);

  const onPointerDown = useCallback((e: PointerEvent) => {
    down.current = { x: e.clientX, y: e.clientY };
  }, []);

  const onPointerUp = useCallback(
    (e: PointerEvent) => {
      if (!pickEnabled || !scene) return;
      const start = down.current;
      down.current = null;
      if (!start) return;

      // Treat anything beyond a few pixels as a camera drag, not a click.
      if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > 4) return;

      const rect = gl.domElement.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      );

      const raycaster = new THREE.Raycaster();
      raycaster.setFromCamera(ndc, camera);
      const hits = raycaster.intersectObject(scene, true);

      // Skip helpers and anything hidden by the current styles.
      const hit = hits.find(
        (h) => h.object.visible && !h.object.userData.isSelectionHelper,
      );

      if (!hit) {
        clearSelection();
        return;
      }

      const id = objToId.get(hit.object);
      if (id) pickPart(id, { additive: e.shiftKey, deep: e.altKey });
    },
    [camera, gl, scene, objToId, pickPart, clearSelection, pickEnabled],
  );

  useEffect(() => {
    const el = gl.domElement;
    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('pointerup', onPointerUp);
    return () => {
      el.removeEventListener('pointerdown', onPointerDown);
      el.removeEventListener('pointerup', onPointerUp);
    };
  }, [gl, onPointerDown, onPointerUp]);

  return null;
}

/**
 * Drag gizmo attached to the current selection.
 *
 * Uses a proxy Object3D rather than attaching directly to the mesh: the
 * SceneBinder rewrites every part's transform each frame from the evaluated
 * timeline, so a gizmo attached to real geometry would fight it. The proxy is
 * free to move, and we commit its pose on mouseUp.
 */
export function DragGizmo({ scene, assembly }: Props) {
  const selection = useStore((s) => s.selection);
  const gizmo = useStore((s) => s.gizmo);
  const activeOperationId = useStore((s) => s.activeOperationId);
  const commitDrag = useStore((s) => s.commitDrag);
  const pause = useStore((s) => s.pause);

  const proxy = useRef<THREE.Object3D>(new THREE.Object3D());
  const controls = useRef<any>(null);

  const index = useMemo(
    () => (scene && assembly ? indexScene(scene, assembly) : new Map()),
    [scene, assembly],
  );

  // Only single-part drags for now: a multi-part gizmo needs a shared frame
  // and rigid-group commit, which is a separate feature.
  const targetId = selection.length === 1 ? selection[0] : null;
  const target = targetId ? index.get(targetId) : null;

  // Park the proxy on the part whenever the selection changes.
  useEffect(() => {
    if (!target) return;
    target.getWorldPosition(proxy.current.position);
    target.getWorldQuaternion(proxy.current.quaternion);
  }, [target, targetId]);

  const onMouseDown = useCallback(() => pause(), [pause]);

  const onMouseUp = useCallback(() => {
    if (!targetId) return;
    const p = proxy.current;
    commitDrag(
      targetId,
      [p.position.x, p.position.y, p.position.z],
      [p.quaternion.x, p.quaternion.y, p.quaternion.z, p.quaternion.w],
    );
  }, [targetId, commitDrag]);

  const active = gizmo !== 'off' && !!target && !!activeOperationId;
  if (!active) return null;

  return (
    <>
      <primitive object={proxy.current} />
      <TransformControls
        ref={controls}
        object={proxy.current}
        mode={gizmo}
        onMouseDown={onMouseDown}
        onMouseUp={onMouseUp}
        size={0.8}
      />
    </>
  );
}
