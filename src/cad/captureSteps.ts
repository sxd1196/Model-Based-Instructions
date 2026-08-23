/**
 * Offscreen rendering for per-step screenshots.
 *
 * Renders each operation's end frame to a PNG so exported work instructions
 * show what the step looks like rather than describing it. Uses a SEPARATE
 * renderer and camera so the live viewport is untouched — capturing from the
 * on-screen canvas would flash the UI and fight the playhead.
 */
import * as THREE from 'three';
import type { CameraPose, Sequence } from '@/domain/schema';
import { buildTimeline, resolveFrame, type ResolvedFrame } from '@/domain/evaluate';
import { indexScene } from './loadGltf';

export interface StepShot {
  operationId: string;
  index: number;
  /** PNG data URL. */
  dataUrl: string;
}

export interface CaptureOptions {
  width?: number;
  height?: number;
  /** Fallback framing when a step has no authored camera. */
  homeCamera?: CameraPose | null;
  background?: string;
}

/**
 * Capture one image per operation at its end state (after motion, before the
 * next step begins) — the frame that shows the result of the instruction.
 */
export async function captureStepImages(
  sequence: Sequence,
  sourceScene: THREE.Object3D,
  options: CaptureOptions = {},
): Promise<StepShot[]> {
  const width = options.width ?? 800;
  const height = options.height ?? 600;

  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    preserveDrawingBuffer: true,
    alpha: false,
  });
  renderer.setSize(width, height, false);
  renderer.setPixelRatio(1);

  // Clone so posing parts for a screenshot cannot disturb the live scene.
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(options.background ?? '#15171c');

  const model = sourceScene.clone(true);
  scene.add(model);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x202430, 1.1));
  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(1, 1.4, 0.8);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xffffff, 0.6);
  fill.position.set(-1, 0.4, -0.6);
  scene.add(fill);

  const box = new THREE.Box3().setFromObject(model);
  const center = box.getCenter(new THREE.Vector3());
  const diagonal = box.getSize(new THREE.Vector3()).length() || 100;

  const camera = new THREE.PerspectiveCamera(45, width / height, diagonal / 5000, diagonal * 50);

  const index = indexScene(model, sequence.assembly);
  const rest = new Map<string, { p: THREE.Vector3; q: THREE.Quaternion }>();
  for (const [id, obj] of index) {
    rest.set(id, { p: obj.position.clone(), q: obj.quaternion.clone() });
  }

  const timeline = buildTimeline(sequence);
  const shots: StepShot[] = [];

  try {
    for (const entry of timeline) {
      // Sample at motion end, not step end: the dwell holds the same pose but
      // the result frame is what the operator needs to see.
      const frame = resolveFrame(sequence, entry.motionEndTime);
      applyFrame(frame, index, rest);
      aimCamera(camera, frame.camera ?? options.homeCamera ?? null, center, diagonal);

      renderer.render(scene, camera);
      shots.push({
        operationId: entry.operation.id,
        index: entry.index,
        dataUrl: renderer.domElement.toDataURL('image/png'),
      });
    }
  } finally {
    // WebGL contexts are a scarce resource; leaking them breaks later exports.
    renderer.dispose();
    renderer.forceContextLoss();
    disposeTree(model);
  }

  return shots;
}

const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _pivot = new THREE.Vector3();
const _offset = new THREE.Vector3();

/** Same pose composition as SceneBinder — see docs/ARCHITECTURE.md. */
function applyFrame(
  frame: ResolvedFrame,
  index: Map<string, THREE.Object3D>,
  rest: Map<string, { p: THREE.Vector3; q: THREE.Quaternion }>,
): void {
  for (const [id, obj] of index) {
    const base = rest.get(id);
    if (!base) continue;

    const style = frame.styles.get(id);
    obj.visible = style !== 'hidden';

    const move = frame.poses.get(id);
    if (!move) {
      obj.position.copy(base.p);
      obj.quaternion.copy(base.q);
      continue;
    }

    _quat.set(move.rotate[0], move.rotate[1], move.rotate[2], move.rotate[3]);
    _pivot.set(move.pivot[0], move.pivot[1], move.pivot[2]);
    _offset.copy(base.p).sub(_pivot).applyQuaternion(_quat).add(_pivot);
    _pos.set(move.translate[0], move.translate[1], move.translate[2]);

    obj.position.copy(_offset).add(_pos);
    obj.quaternion.copy(base.q).premultiply(_quat);
  }
}

function aimCamera(
  camera: THREE.PerspectiveCamera,
  pose: CameraPose | null,
  center: THREE.Vector3,
  diagonal: number,
): void {
  if (pose) {
    camera.position.set(pose.position[0], pose.position[1], pose.position[2]);
    camera.lookAt(pose.target[0], pose.target[1], pose.target[2]);
    camera.fov = pose.fov;
  } else {
    // Neutral three-quarter view, the CAD convention for a clear read.
    const d = diagonal * 1.5;
    camera.position.set(center.x + d, center.y + d * 0.7, center.z + d);
    camera.lookAt(center);
    camera.fov = 45;
  }
  camera.updateProjectionMatrix();
}

function disposeTree(root: THREE.Object3D): void {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    m.geometry?.dispose();
    const mat = m.material;
    if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
    else mat?.dispose();
  });
}
