/**
 * Direct manipulation: click-to-select and gizmo drag.
 *
 * All the math lives in `domain/authoring.ts`; this file only converts three.js
 * events into those calls. Keep it that way — logic here is untestable.
 */
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { PivotControls } from '@react-three/drei';
import * as THREE from 'three';
import { useStore } from '@/state/store';
import { indexScene } from '@/cad/loadGltf';
import {
  applyDragPolicy,
  clusterByParentFrame,
  resolveGizmoState,
  selectableParts,
} from '@/domain/authoring';
import { clusterMoveFromDrag } from '@/domain/rigid';
import { beginPreview, endPreview, updatePreview } from './dragPreview';
import { distance, liftOffSurface, snapToFeature } from '@/domain/snapping';
import type { Assembly, Move, Vec3 } from '@/domain/schema';

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
 *
 * In callout-anchor mode the same ray is snapped to the nearest vertex, edge
 * midpoint, or face centre and stored as a LOCAL-frame offset on the part.
 */
export function PickHandler({ scene, assembly }: Props) {
  const { camera, gl } = useThree();
  const pickPart = useStore((s) => s.pickPart);
  const clearSelection = useStore((s) => s.clearSelection);
  const pickEnabled = useStore((s) => s.pickEnabled);
  const anchorMode = useStore((s) => s.anchorMode);
  const setAnchorFromPick = useStore((s) => s.setAnchorFromPick);

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
        if (!anchorMode) clearSelection();
        return;
      }

      const id = objToId.get(hit.object);
      if (!id) return;

      if (anchorMode) {
        const snapped = snapHitToFeature(hit);
        if (snapped) setAnchorFromPick(id, snapped.kind, snapped.local, snapped.normal);
        return;
      }

      pickPart(id, { additive: e.shiftKey, deep: e.altKey });
    },
    [camera, gl, scene, objToId, pickPart, clearSelection, pickEnabled, anchorMode, setAnchorFromPick],
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
 * Convert a three.js intersection into a local-frame feature anchor.
 *
 * Local frame, not world: the anchor must stay welded to the feature as the
 * part animates away, and a world point would immediately drift.
 */
function snapHitToFeature(hit: THREE.Intersection): {
  kind: 'vertex' | 'edge' | 'face';
  local: Vec3;
  normal: Vec3;
} | null {
  const mesh = hit.object as THREE.Mesh;
  const geom = mesh.geometry as THREE.BufferGeometry;
  if (!geom?.attributes.position || hit.face == null) return null;

  const pos = geom.attributes.position as THREE.BufferAttribute;
  const readVertex = (i: number): Vec3 => [pos.getX(i), pos.getY(i), pos.getZ(i)];

  const triangle: [Vec3, Vec3, Vec3] = [
    readVertex(hit.face.a),
    readVertex(hit.face.b),
    readVertex(hit.face.c),
  ];

  // The hit point is in world space; bring it into the mesh's local frame so
  // it is comparable with the raw position attribute.
  const localHit = mesh.worldToLocal(hit.point.clone());
  const snapped = snapToFeature([localHit.x, localHit.y, localHit.z], triangle);

  // Lift slightly off the surface or the leader endpoint z-fights the face.
  const size = Math.max(
    distance(triangle[0], triangle[1]),
    distance(triangle[1], triangle[2]),
  );
  const lifted = liftOffSurface(snapped.point, snapped.normal, size * 0.02);

  return { kind: snapped.kind, local: lifted, normal: snapped.normal };
}

/**
 * Combined drag gizmo attached to the current selection.
 *
 * PivotControls rather than TransformControls: it carries translate arrows
 * AND rotate rings in one widget, so there is no mode state and no toolbar
 * buttons to switch personalities. Orbit works whenever the pointer is not
 * on a handle.
 *
 * The widget is driven through an external matrix (autoTransform off). While
 * idle the matrix is re-parked on the target every frame — SceneBinder
 * rewrites part transforms per frame, so anything positioned once goes stale
 * the moment a commit, scrub, or undo moves the part (the stranded-gizmo
 * bug). While dragging, the drag's provisional Move is fed to SceneBinder via
 * dragPreview, so the ACTUAL GEOMETRY follows the mouse in real time; release
 * commits the identical Move through the store.
 *
 * Single and multi-part selections take different paths:
 *  - one part  -> commitDrag, inverting the pose composition vs rest
 *  - many parts -> commitGroupDrag, composing a RIGID transform so the group
 *    keeps its internal geometry
 */
// Module-level scratch: useFrame must not allocate (AGENTS.md §7).
const _acc = new THREE.Vector3();
const _scratch = new THREE.Vector3();
const _mpos = new THREE.Vector3();
const _mquat = new THREE.Quaternion();
const _mscale = new THREE.Vector3();
const _arrow = new THREE.Vector3();
const IDENT_Q = new THREE.Quaternion();
const ONE = new THREE.Vector3(1, 1, 1);

export function DragGizmo({ scene, assembly }: Props) {
  const { camera, gl } = useThree();
  const selection = useStore((s) => s.selection);
  const commitGroupDrag = useStore((s) => s.commitGroupDrag);
  const pause = useStore((s) => s.pause);

  const matrix = useRef(new THREE.Matrix4());
  const dragging = useRef(false);
  const dragStart = useRef(new THREE.Vector3());
  const lastPos = useRef(new THREE.Vector3());
  const lastQuat = useRef(new THREE.Quaternion());

  const index = useMemo(
    () => (scene && assembly ? indexScene(scene, assembly) : new Map()),
    [scene, assembly],
  );

  const isGroup = selection.length > 1;
  const targetId = selection.length === 1 ? selection[0] : null;
  const target = targetId ? index.get(targetId) : null;

  /**
   * A part's VISUAL centre: world-space bounding-box centre, not its origin.
   *
   * Real CAD meshes frequently bake geometry in world coordinates and leave
   * every node origin at the model origin — parking the gizmo at
   * getWorldPosition() then drops it in the middle of the model, nowhere
   * near the part (and pivoting there would swing the part around the whole
   * assembly). The local-space box is cached per geometry; only the
   * local->world transform runs per frame.
   */
  const localCenters = useRef(new WeakMap<THREE.Object3D, THREE.Vector3>());
  const visualCenter = useCallback((obj: THREE.Object3D, out: THREE.Vector3) => {
    let center = localCenters.current.get(obj);
    if (!center) {
      const mesh = obj as THREE.Mesh;
      if (mesh.isMesh && mesh.geometry) {
        if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
        center = mesh.geometry.boundingBox!.getCenter(new THREE.Vector3());
      } else {
        center = new THREE.Vector3();
      }
      localCenters.current.set(obj, center);
    }
    return obj.localToWorld(out.copy(center));
  }, []);

  /** Park the widget on its target while idle; never fight an active drag. */
  useFrame(() => {
    if (import.meta.env.DEV && typeof window !== 'undefined') {
      matrix.current.decompose(_mpos, _mquat, _mscale);
      // Screen-space projection so headless checks can aim a REAL mouse
      // press at a specific handle instead of guessing pixels.
      _scratch.copy(_mpos).project(camera);
      const rect = gl.domElement.getBoundingClientRect();
      _arrow.set(_mpos.x + widgetScale * 0.9, _mpos.y, _mpos.z).project(camera);
      (window as unknown as { __gizmoProbe?: unknown }).__gizmoProbe = {
        handle: _mpos.toArray(),
        screen: [
          rect.left + ((_scratch.x + 1) / 2) * rect.width,
          rect.top + ((1 - _scratch.y) / 2) * rect.height,
        ],
        arrowX: [
          rect.left + ((_arrow.x + 1) / 2) * rect.width,
          rect.top + ((1 - _arrow.y) / 2) * rect.height,
        ],
        target: target ? visualCenter(target, _scratch).toArray() : null,
        dragging: dragging.current,
      };
    }
    if (dragging.current) return;

    if (target) {
      visualCenter(target, _acc);
    } else if (isGroup) {
      // Group handle sits at the selection's visual centroid, so a drag
      // feels like grabbing the whole thing rather than one arbitrary member.
      _acc.set(0, 0, 0);
      let n = 0;
      for (const id of selection) {
        const obj = index.get(id);
        if (!obj) continue;
        visualCenter(obj, _scratch);
        _acc.add(_scratch);
        n++;
      }
      if (n === 0) return;
      _acc.divideScalar(n);
    } else {
      return;
    }

    // Identity rotation: handle axes stay world-aligned, matching how the
    // authored Moves and axis lock are expressed.
    matrix.current.compose(_acc, IDENT_Q, ONE);
  });

  /**
   * Recompute the provisional per-part Moves for the current handle pose.
   *
   * ONE path for single parts and groups: the drag is a WORLD rigid
   * transform about the handle's start position, re-expressed per parent
   * cluster. This is what makes rotation pivot about the handle (the part's
   * visual centre) rather than the part's node origin — on real CAD meshes
   * the origin often sits at the model origin, and pivoting there swings
   * the part around the entire assembly.
   */
  const previewFromHandle = useCallback((): Array<[string, Move]> | null => {
    const st = useStore.getState();
    if (!st.sequence) return null;
    const policy = { snap: st.snap, axisLock: st.axisLock };

    const parts = selectableParts(st.sequence.assembly, selection);
    if (!parts.length) return null;
    const op = st.sequence.operations.find((o) => o.id === st.activeOperationId);
    const s = dragStart.current;
    const gStart: [number, number, number] = [s.x, s.y, s.z];
    const gEnd: [number, number, number] = [
      lastPos.current.x, lastPos.current.y, lastPos.current.z,
    ];
    const gRot: [number, number, number, number] = [
      lastQuat.current.x, lastQuat.current.y, lastQuat.current.z, lastQuat.current.w,
    ];

    const out: Array<[string, Move]> = [];
    for (const cluster of clusterByParentFrame(st.sequence.assembly, parts)) {
      const existing = op?.tracks.find(
        (t) =>
          t.parts.length === cluster.parts.length &&
          t.parts.every((p) => cluster.parts.includes(p)),
      );
      const move = applyDragPolicy(
        clusterMoveFromDrag(existing?.to ?? null, cluster.frame, gStart, gEnd, gRot),
        policy,
      );
      for (const id of cluster.parts) out.push([id, move]);
    }
    return out;
  }, [selection]);

  const onDragStart = useCallback(() => {
    pause();
    dragging.current = true;

    matrix.current.decompose(_mpos, _mquat, _mscale);
    dragStart.current.copy(_mpos);
    lastPos.current.copy(_mpos);
    lastQuat.current.identity();

    beginPreview();
  }, [pause]);

  const onDrag = useCallback(
    (l: THREE.Matrix4) => {
      matrix.current.copy(l);
      l.decompose(_mpos, _mquat, _mscale);
      lastPos.current.copy(_mpos);
      lastQuat.current.copy(_mquat);

      // Live preview: SceneBinder renders this Move for the dragged parts
      // this frame, so the geometry — not just the handle — follows the
      // mouse. Snap and axis lock shape it here too, so what you see
      // stepping IS what will be committed.
      const moves = previewFromHandle();
      if (moves) updatePreview(moves);
    },
    [previewFromHandle],
  );

  const onDragEnd = useCallback(() => {
    dragging.current = false;
    endPreview();

    // Commit through the store — commitGroupDrag runs the SAME cluster math
    // as the preview (single parts are just a one-member group), so the part
    // lands exactly where the preview left it.
    const s = dragStart.current;
    if (selection.length > 0) {
      commitGroupDrag(
        selection,
        [s.x, s.y, s.z],
        [lastPos.current.x, lastPos.current.y, lastPos.current.z],
        [lastQuat.current.x, lastQuat.current.y, lastQuat.current.z, lastQuat.current.w],
      );
    }
  }, [selection, commitGroupDrag]);

  // Widget size: fraction of the selection's own footprint so it reads as
  // attached to the part on a bolt and on a housing alike.
  const widgetScale = useMemo(() => {
    const box = new THREE.Box3();
    const tmp = new THREE.Box3();
    for (const id of targetId ? [targetId] : selection) {
      const obj = index.get(id);
      if (!obj) continue;
      tmp.setFromObject(obj);
      box.union(tmp);
    }
    if (box.isEmpty()) return 60;
    const d = box.getSize(new THREE.Vector3()).length();
    return Math.max(d * 0.75, 30);
  }, [targetId, selection, index]);

  const hasTarget = !!target || isGroup;
  const gizmoState = resolveGizmoState({
    selectionCount: selection.length,
    hasSequence: !!assembly,
  });
  if (!gizmoState.visible || !hasTarget) return null;

  return (
    <PivotControls
      matrix={matrix.current}
      autoTransform={false}
      onDragStart={onDragStart}
      onDrag={onDrag}
      onDragEnd={onDragEnd}
      scale={widgetScale}
      lineWidth={3}
      // Arrows + rings only. The corner plane sliders are one prop away
      // (remove this) but crowd the widget on small parts.
      disableSliders
      // Scaling a CAD part is meaningless and corrupts the rigid model.
      disableScaling
      depthTest={false}
      annotations
    />
  );
}
