/**
 * The bridge from the pure evaluator to the live three.js scene.
 *
 * Runs every frame. Deliberately imperative and allocation-free in the hot path:
 * with hundreds of parts, creating objects per frame is what kills framerate.
 * Scratch objects are module-level and reused.
 */
import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { useStore } from '@/state/store';
import { resolveFrame } from '@/domain/evaluate';
import type { ResolvedFrame, StyleMode } from '@/domain/evaluate';
import { indexScene } from '@/cad/loadGltf';
import { dragPreview } from './dragPreview';
import type { Assembly } from '@/domain/schema';

const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _pivot = new THREE.Vector3();
const _offset = new THREE.Vector3();

interface Props {
  scene: THREE.Object3D;
  assembly: Assembly;
}

/** Cached original materials so ghost/highlight can be reverted cheaply. */
type MatRecord = { original: THREE.Material | THREE.Material[] };

export function SceneBinder({ scene, assembly }: Props) {
  const index = useMemo(() => indexScene(scene, assembly), [scene, assembly]);
  const rest = useRef(new Map<string, { p: THREE.Vector3; q: THREE.Quaternion }>());
  const materials = useRef(new Map<string, MatRecord>());
  const ghostMat = useRef<THREE.Material | null>(null);
  const highlightMat = useRef<THREE.Material | null>(null);

  // Capture rest poses once. Everything is a delta from these.
  useEffect(() => {
    const map = new Map<string, { p: THREE.Vector3; q: THREE.Quaternion }>();
    for (const [id, obj] of index) {
      map.set(id, { p: obj.position.clone(), q: obj.quaternion.clone() });
    }
    rest.current = map;

    const mats = new Map<string, MatRecord>();
    for (const [id, obj] of index) {
      const mesh = obj as THREE.Mesh;
      if (mesh.isMesh && mesh.material) mats.set(id, { original: mesh.material });
    }
    materials.current = mats;

    ghostMat.current = new THREE.MeshStandardMaterial({
      color: 0x88aacc,
      transparent: true,
      opacity: 0.12,
      depthWrite: false,
      roughness: 0.9,
    });
    highlightMat.current = new THREE.MeshStandardMaterial({
      color: 0xffa000,
      emissive: 0x442200,
      roughness: 0.4,
      metalness: 0.1,
    });

    return () => {
      ghostMat.current?.dispose();
      highlightMat.current?.dispose();
    };
  }, [index]);

  useFrame(() => {
    const { sequence, time } = useStore.getState();
    if (!sequence) return;

    const frame = resolveFrame(sequence, time);
    applyPoses(frame, index, rest.current);
    applyStyles(frame, index, materials.current, ghostMat.current, highlightMat.current);
  });

  return null;
}

function applyPoses(
  frame: ResolvedFrame,
  index: Map<string, THREE.Object3D>,
  rest: Map<string, { p: THREE.Vector3; q: THREE.Quaternion }>,
) {
  // During a gizmo drag the provisional Moves for the dragged parts override
  // the evaluated frame, so the GEOMETRY follows the mouse in real time
  // rather than jumping on release. Per-part moves: clusters under different
  // parents carry different local Moves for the same world motion.
  const preview = dragPreview.active ? dragPreview : null;

  for (const [id, obj] of index) {
    const base = rest.get(id);
    if (!base) continue;

    const move = preview?.moves.get(id) ?? frame.poses.get(id);

    if (!move) {
      // Untouched: sit at rest. Cheap early-out for the common case.
      obj.position.copy(base.p);
      obj.quaternion.copy(base.q);
      continue;
    }

    _quat.set(move.rotate[0], move.rotate[1], move.rotate[2], move.rotate[3]);

    // Rotate about the pivot, then translate. Pivot is expressed in the
    // parent frame, which is why we work relative to the rest position.
    _pivot.set(move.pivot[0], move.pivot[1], move.pivot[2]);
    _offset.copy(base.p).sub(_pivot).applyQuaternion(_quat).add(_pivot);

    _pos.set(move.translate[0], move.translate[1], move.translate[2]);
    obj.position.copy(_offset).add(_pos);
    obj.quaternion.copy(base.q).premultiply(_quat);
  }
}

function applyStyles(
  frame: ResolvedFrame,
  index: Map<string, THREE.Object3D>,
  materials: Map<string, MatRecord>,
  ghost: THREE.Material | null,
  highlight: THREE.Material | null,
) {
  for (const [id, obj] of index) {
    const mode: StyleMode = frame.styles.get(id) ?? 'normal';
    const mesh = obj as THREE.Mesh;

    obj.visible = mode !== 'hidden';
    if (!mesh.isMesh) continue;

    const rec = materials.get(id);
    if (!rec) continue;

    if (mode === 'ghost' && ghost) mesh.material = ghost;
    else if (mode === 'highlight' && highlight) mesh.material = highlight;
    else mesh.material = rec.original;
  }
}

/** Drives the R3F camera from the evaluated frame when a pose is authored. */
export function CameraBinder({ controlsRef }: { controlsRef: React.RefObject<any> }) {
  const { camera } = useThree();

  useFrame(() => {
    const { sequence, time, playing } = useStore.getState();
    if (!sequence) return;

    // While paused the user owns the camera; only drive it during playback.
    // Without this, orbiting during authoring fights the timeline every frame.
    if (!playing) return;

    const frame = resolveFrame(sequence, time);
    const pose = frame.camera;
    if (!pose) return;

    camera.position.set(pose.position[0], pose.position[1], pose.position[2]);
    if (controlsRef.current) {
      controlsRef.current.target.set(pose.target[0], pose.target[1], pose.target[2]);
      controlsRef.current.update();
    }
    const cam = camera as THREE.PerspectiveCamera;
    if (cam.isPerspectiveCamera && cam.fov !== pose.fov) {
      cam.fov = pose.fov;
      cam.updateProjectionMatrix();
    }
  });

  return null;
}

/** Advances the playhead. Single owner of time progression. */
export function PlaybackClock() {
  const last = useRef<number | null>(null);

  useFrame(() => {
    const { playing, playbackRate, time, sequence, setTime, pause } = useStore.getState();
    const now = performance.now();

    if (!playing || !sequence) {
      last.current = now;
      return;
    }

    if (last.current === null) {
      last.current = now;
      return;
    }

    const dt = ((now - last.current) / 1000) * playbackRate;
    last.current = now;

    const next = time + dt;
    setTime(next);

    // Stop at the end rather than looping; authors expect a hard stop.
    const total = sequence.operations.reduce((a, o) => a + o.duration + o.dwell, 0);
    if (next >= total) pause();
  });

  return null;
}
