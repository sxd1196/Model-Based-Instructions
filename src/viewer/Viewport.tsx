/** The 3D viewport. */
import { Suspense, useEffect, useRef, useState } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { Grid, Html, OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import { useStore } from '@/state/store';
import { resolveFrame } from '@/domain/evaluate';
import { CameraBinder, PlaybackClock, SceneBinder } from './SceneBinder';
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

        <AnnotationLayer />
        <SelectionOutline scene={scene} assembly={assembly} />
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

/** HTML callouts pinned to parts, via drei's Html (CSS2D equivalent). */
function AnnotationLayer() {
  const sequence = useStore((s) => s.sequence);
  const time = useStore((s) => s.time);
  const [, force] = useState(0);

  useEffect(() => {
    const i = setInterval(() => force((n) => n + 1), 100);
    return () => clearInterval(i);
  }, []);

  if (!sequence) return null;
  const frame = resolveFrame(sequence, time);

  return (
    <>
      {frame.annotations.map((a) => {
        const point =
          a.anchor.kind === 'world'
            ? a.anchor.point
            : ([0, 0, 0] as [number, number, number]);
        return (
          <Html
            key={a.id}
            position={point}
            style={{ transform: `translate(${a.offset[0]}px, ${a.offset[1]}px)` }}
            zIndexRange={[100, 0]}
          >
            <div className="callout">{a.text}</div>
          </Html>
        );
      })}
    </>
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

  return null;
}
