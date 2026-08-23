/** The 3D viewport. */
import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
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
        <SelectionOutline scene={scene} assembly={assembly} />
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
  const [, force] = useState(0);
  const raf = useRef<number>(0);

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

            {a.leader && (
              <LeaderLine offset={a.offset} length={markerSize * 6} />
            )}

            <Html
              style={{ transform: `translate(${a.offset[0]}px, ${a.offset[1]}px)` }}
              zIndexRange={[100, 0]}
              center={false}
            >
              <div className="callout">
                <RichTextView rich={a.rich} plain={a.text} />
              </div>
            </Html>
          </group>
        );
      })}
    </>
  );
}

/**
 * A short 3D stub from the anchor toward the label.
 *
 * A true anchor-to-label line would need per-frame screen projection; this
 * reads as a leader at a fraction of the cost and never fights the HTML layer.
 */
function LeaderLine({
  offset,
  length,
}: {
  offset: [number, number];
  length: number;
}) {
  const geometry = useMemo(() => {
    const dir = new THREE.Vector3(offset[0], -offset[1], 0).normalize();
    return new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0),
      dir.multiplyScalar(length),
    ]);
  }, [offset, length]);

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

/** Highlights selected parts with a box helper — cheap and robust. */
function SelectionOutline({
  scene,
  assembly,
}: {
  scene: THREE.Object3D | null;
  assembly: Assembly | null;
}) {
  const selection = useStore((s) => s.selection);
  const { scene: root } = useThree();
  const helpers = useRef<THREE.BoxHelper[]>([]);

  useEffect(() => {
    for (const h of helpers.current) {
      root.remove(h);
      h.dispose();
    }
    helpers.current = [];

    if (!scene || !assembly || !selection.length) return;

    const byName = new Map<string, THREE.Object3D>();
    scene.traverse((o) => {
      if (!byName.has(o.name)) byName.set(o.name, o);
    });

    for (const id of selection) {
      const part = assembly.parts[id];
      const obj = byName.get(part?.name ?? id);
      if (!obj) continue;
      const helper = new THREE.BoxHelper(obj, 0xffa000);
      helper.userData.isSelectionHelper = true;
      root.add(helper);
      helpers.current.push(helper);
    }

    return () => {
      for (const h of helpers.current) {
        root.remove(h);
        h.dispose();
      }
      helpers.current = [];
    };
  }, [selection, scene, assembly, root]);

  // Re-fit every frame. A BoxHelper computes its box ONCE at construction,
  // but SceneBinder repositions parts each frame (commits, scrubbing, undo,
  // live drag preview), which left the orange box stranded at the part's old
  // position — the same stale-sync bug as the gizmo handle. update() refits
  // the helper to its object's current world transform; SceneBinder runs at
  // an earlier priority, so the part has already moved this frame.
  useFrame(() => {
    for (const h of helpers.current) h.update();
    if (import.meta.env.DEV && typeof window !== 'undefined') {
      // Dev-only probe: outline box centres for headless verification.
      (window as unknown as { __outlineProbe?: number[][] }).__outlineProbe =
        helpers.current.map((h) => {
          h.geometry.computeBoundingSphere();
          const c = h.geometry.boundingSphere!.center;
          return [c.x, c.y, c.z];
        });
    }
  });

  return null;
}
