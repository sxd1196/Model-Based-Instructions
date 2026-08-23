/** The 3D viewport. */
import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { Grid, Html, OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import { useStore } from '@/state/store';
import { resolveAnnotationPoint, resolveFrame } from '@/domain/evaluate';
import { CameraBinder, PlaybackClock, SceneBinder } from './SceneBinder';
import { DragGizmo, PickHandler } from './Manipulation';
import { AxisTriad, OriginMarker } from './Orientation';
import { RichTextView } from '@/ui/RichTextView';
import type { Assembly } from '@/domain/schema';

interface Props {
  scene: THREE.Object3D | null;
  assembly: Assembly | null;
  diagonal: number;
  center: [number, number, number];
}

export function Viewport({ scene, assembly, diagonal, center }: Props) {
  const controls = useRef<any>(null);
  const dist = Math.max(diagonal * 1.6, 1);

  return (
    <div className="viewport">
      <Canvas
        dpr={[1, 2]}
        gl={{ antialias: true, preserveDrawingBuffer: true }}
        camera={{
          position: [center[0] + dist, center[1] + dist * 0.7, center[2] + dist],
          fov: 45,
          near: Math.max(diagonal / 5000, 0.01),
          far: Math.max(diagonal * 50, 1000),
        }}
      >
        <color attach="background" args={['#15171c']} />
        <hemisphereLight intensity={0.55} groundColor="#202430" />
        <directionalLight position={[dist, dist * 1.4, dist * 0.8]} intensity={1.7} castShadow={false} />
        <directionalLight position={[-dist, dist * 0.4, -dist * 0.6]} intensity={0.5} />

        <Suspense fallback={<Html center><div className="loading">Loading…</div></Html>}>
          {scene && assembly && (
            <>
              <primitive object={scene} />
              <SceneBinder scene={scene} assembly={assembly} />
            </>
          )}
        </Suspense>

        <Grid
          args={[diagonal * 4 || 100, diagonal * 4 || 100]}
          cellSize={Math.max(diagonal / 20, 1)}
          sectionSize={Math.max(diagonal / 4, 5)}
          cellColor="#2a2f3a"
          sectionColor="#3d4557"
          position={[center[0], center[1] - diagonal * 0.55, center[2]]}
          fadeDistance={diagonal * 8 || 500}
          infiniteGrid={false}
        />

        <AnnotationLayer diagonal={diagonal} />
        <PickHandler scene={scene} assembly={assembly} />
        <DragGizmo scene={scene} assembly={assembly} />
        <OriginMarker scale={diagonal} />
        <AxisTriad />
        <CameraBinder controlsRef={controls} />
        <PlaybackClock />
        <CameraReporter />

        <OrbitControls
          ref={controls}
          makeDefault
          target={center}
          enableDamping
          dampingFactor={0.12}
        />
      </Canvas>

      <InstructionNote />
      <AnchorGuide />
    </div>
  );
}

/** Publishes the live camera so "capture current view" can read it. */
function CameraReporter() {
  const { camera, controls } = useThree();
  useEffect(() => {
    (window as any).__getCameraPose = () => {
      const t = (controls as any)?.target ?? new THREE.Vector3();
      return {
        position: [camera.position.x, camera.position.y, camera.position.z],
        target: [t.x, t.y, t.z],
        fov: (camera as THREE.PerspectiveCamera).fov ?? 45,
      };
    };
  }, [camera, controls]);
  return null;
}

/**
 * The step's INSTRUCTION as an on-screen note, parked in a viewport corner.
 *
 * Replaces the old separate 'screen note' annotation type — the instruction
 * IS the note. Deliberately plain DOM: slide furniture, camera-aligned by
 * construction, zero per-frame cost. Empty instructions render nothing.
 */
function InstructionNote() {
  const sequence = useStore((s) => s.sequence);
  const time = useStore((s) => s.time);
  if (!sequence) return null;

  const frame = resolveFrame(sequence, time);
  const op = sequence.operations[frame.activeOperationIndex];
  if (!op || !op.description.trim()) return null;

  return (
    <div className="screen-callouts">
      <div className={`screen-callout corner-${op.noteCorner}`}>
        <RichTextView rich={op.descriptionRich} plain={op.description} />
      </div>
    </div>
  );
}

/**
 * Step-by-step guide shown while placing a callout — the little window that
 * tells the user what to do next in the two-phase flow (pick, then pull).
 */
function AnchorGuide() {
  const anchorMode = useStore((s) => s.anchorMode);
  const setAnchorMode = useStore((s) => s.setAnchorMode);
  if (!anchorMode) return null;

  const pick = anchorMode.phase === 'pick';
  return (
    <div className="anchor-guide">
      <div className="anchor-guide-title">
        {pick ? 'Step 1 of 2 — pick the anchor' : 'Step 2 of 2 — place the note'}
      </div>
      <div className="anchor-guide-body">
        {pick
          ? 'Click a corner, edge, or face on the part. The leader line will attach exactly there.'
          : 'Pull the note away from the part, then click to drop it. The readout shows the distance.'}
      </div>
      <button className="anchor-guide-cancel" onClick={() => setAnchorMode(null)}>
        Esc · cancel
      </button>
    </div>
  );
}

/**
 * HTML callouts pinned to a world point or a moving part.
 *
 * Part-anchored labels resolve the part's ANIMATED position each frame, so a
 * label sticks to its part as the part moves. Redrawn on a rAF-driven tick
 * rather than per-frame React state, which would violate the no-setState-in-
 * useFrame rule (AGENTS.md §7).
 */
function AnnotationLayer({ diagonal }: { diagonal: number }) {
  // Marker scales with the model so it is visible on a 5mm bolt and a 2m frame.
  const markerSize = Math.max(diagonal * 0.004, 0.4);
  const sequence = useStore((s) => s.sequence);
  const anchorMode = useStore((s) => s.anchorMode);
  const setLabelOffsetFromPull = useStore((s) => s.setLabelOffsetFromPull);
  const { camera, gl } = useThree();
  const [, force] = useState(0);
  const raf = useRef<number>(0);
  /** Live world offset while the user pulls the note (phase 2). */
  const pullOffset = useRef<THREE.Vector3 | null>(null);

  useEffect(() => {
    let alive = true;
    const tick = () => {
      if (!alive) return;
      force((n) => (n + 1) % 1000000);
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => {
      alive = false;
      cancelAnimationFrame(raf.current);
    };
  }, []);

  // ---- phase 2: the note follows the cursor on a camera-facing plane ----
  const pulling = anchorMode?.phase === 'pull';

  useEffect(() => {
    if (!pulling || !sequence) {
      pullOffset.current = null;
      return;
    }
    const anno = sequence.operations
      .find((o) => o.id === anchorMode!.operationId)
      ?.annotations.find((a) => a.id === anchorMode!.annotationId);
    if (!anno) return;

    const el = gl.domElement;
    const ray = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    const plane = new THREE.Plane();
    const hit = new THREE.Vector3();

    const anchorPoint = () => {
      const { time } = useStore.getState();
      const frame = resolveFrame(sequence, time);
      const p = resolveAnnotationPoint(sequence, frame, anno);
      return p ? new THREE.Vector3(...p) : null;
    };

    const onMove = (e: PointerEvent) => {
      const a = anchorPoint();
      if (!a) return;
      const rect = el.getBoundingClientRect();
      ndc.set(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      );
      ray.setFromCamera(ndc, camera);
      // Camera-facing plane THROUGH the anchor: the pulled distance reads
      // true at the anchor's depth instead of landing on some far wall.
      plane.setFromNormalAndCoplanarPoint(
        camera.getWorldDirection(new THREE.Vector3()).negate(),
        a,
      );
      if (ray.ray.intersectPlane(plane, hit)) {
        pullOffset.current = hit.clone().sub(a);
      }
    };

    const onClick = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const off = pullOffset.current;
      if (off) {
        e.stopPropagation();
        setLabelOffsetFromPull([off.x, off.y, off.z]);
      }
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') useStore.getState().setAnchorMode(null);
    };

    el.addEventListener('pointermove', onMove);
    // WINDOW capture, not the canvas: the pulled note rides the cursor, so
    // the drop click usually lands on the note's own HTML wrapper — a canvas
    // listener would never hear it.
    window.addEventListener('pointerdown', onClick, true);
    window.addEventListener('keydown', onKey);
    return () => {
      el.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerdown', onClick, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [pulling, sequence, anchorMode, camera, gl, setLabelOffsetFromPull]);

  if (!sequence) return null;

  const { time } = useStore.getState();
  const frame = resolveFrame(sequence, time);

  return (
    <>
      {frame.annotations.map((a) => {
        const point = resolveAnnotationPoint(sequence, frame, a);
        if (!point) return null;

        const kind =
          a.anchor.kind === 'part' ? (a.anchor.feature?.kind ?? 'origin') : 'world';

        // While THIS annotation is being pulled, its label rides the cursor.
        const isPulling =
          pulling && anchorMode!.annotationId === a.id && pullOffset.current;
        const off: [number, number, number] = isPulling
          ? [pullOffset.current!.x, pullOffset.current!.y, pullOffset.current!.z]
          : a.labelOffset;
        const distance = Math.hypot(off[0], off[1], off[2]);

        return (
          <group key={a.id} position={point}>
            {/* Marker at the anchor so the label reads as attached. */}
            <mesh>
              <sphereGeometry args={[markerSize, 8, 8]} />
              <meshBasicMaterial
                color={kind === 'vertex' ? '#ffd24d' : '#ffa000'}
                depthTest={false}
                transparent
                opacity={0.95}
              />
            </mesh>

            {a.leader && distance > 0.01 && <LeaderLine3D offset={off} />}

            {/* The label lives at a real world position: anchor + offset. */}
            <Html
              position={off}
              zIndexRange={[100, 0]}
              center
            >
              <div className={`callout${isPulling ? ' pulling' : ''}`}>
                <RichTextView rich={a.rich} plain={a.text} />
                {isPulling && (
                  <div className="callout-distance">{distance.toFixed(0)}mm</div>
                )}
              </div>
            </Html>
          </group>
        );
      })}
    </>
  );
}

/** A real anchor-to-label line in world space — both ends are 3D points now. */
function LeaderLine3D({ offset }: { offset: [number, number, number] }) {
  const geometry = useMemo(
    () =>
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(...offset),
      ]),
    [offset],
  );

  useEffect(() => () => geometry.dispose(), [geometry]);

  return (
    <primitive
      object={new THREE.Line(
        geometry,
        new THREE.LineBasicMaterial({ color: '#ffa000', depthTest: false, transparent: true, opacity: 0.85 }),
      )}
    />
  );
}

