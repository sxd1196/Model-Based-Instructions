import { useCallback, useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { useStore } from '@/state/store';
import { buildAssemblyFromScene } from '@/cad/loadGltf';
import { describeFile, importCadFile } from '@/cad/importCad';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { Viewport } from '@/viewer/Viewport';
import { AssemblyTree } from '@/ui/AssemblyTree';
import { Timeline } from '@/ui/Timeline';
import { Inspector } from '@/ui/Inspector';
import { ViewportToolbar } from '@/ui/ViewportToolbar';
import { AxisLegend } from '@/ui/AxisLegend';
import {
  downloadBundle,
  exportInstructionsHtml,
  recordCanvas,
} from '@/io/project';
import { openProjectJson } from '@/io/bundle';
import { captureStepImages } from '@/cad/captureSteps';
import { makeDemoAssembly } from '@/cad/demo';
import { usePopout } from '@/ui/usePopout';
import './App.css';

export default function App() {
  const [scene, setScene] = useState<THREE.Object3D | null>(null);
  const [diagonal, setDiagonal] = useState(200);
  const [center, setCenter] = useState<[number, number, number]>([0, 0, 0]);
  const stopRecording = useRef<(() => void) | null>(null);
  const [recording, setRecording] = useState(false);
  const viewport = usePopout(() => void 0);

  const sequence = useStore((s) => s.sequence);
  const warnings = useStore((s) => s.warnings);
  const loading = useStore((s) => s.loading);
  const newFromAssembly = useStore((s) => s.newFromAssembly);
  const loadSequence = useStore((s) => s.loadSequence);
  const setLoading = useStore((s) => s.setLoading);
  const setWarnings = useStore((s) => s.setWarnings);
  const undo = useStore((s) => s.undo);
  const redo = useStore((s) => s.redo);
  const togglePlay = useStore((s) => s.togglePlay);

  const ingest = useCallback(
    (root: THREE.Group, url: string, name: string, sourceFile: string) => {
      const result = buildAssemblyFromScene(root, url, { name, sourceFile });
      setScene(result.scene);
      setDiagonal(result.stats.diagonal || 200);
      setCenter(result.stats.center);
      newFromAssembly(result.assembly, [
        ...result.warnings,
        `Loaded ${result.stats.meshCount} meshes, ` +
          `${result.stats.triangleCount.toLocaleString()} triangles.`,
      ]);
    },
    [newFromAssembly],
  );

  const openModel = useCallback(
    async (file: File) => {
      const info = describeFile(file.name);

      if (!info.supported) {
        setWarnings([`CRITICAL: ${info.message}`]);
        return;
      }

      setLoading(true);
      try {
        if (info.format === 'gltf') {
          const url = URL.createObjectURL(file);
          const loader = new GLTFLoader();
          const gltf = await loader.loadAsync(url);
          ingest(gltf.scene, url, file.name.replace(/\.(glb|gltf)$/i, ''), file.name);
        } else {
          // STEP/IGES/BREP go through OpenCascade WASM. Loaded lazily, so the
          // first import pays an ~8MB download the glTF path never does.
          setWarnings(['Reading CAD file with OpenCascade… first import loads the parser.']);
          const buffer = await file.arrayBuffer();
          const result = await importCadFile(buffer, file.name);
          ingest(
            result.scene,
            `mem://${file.name}`,
            file.name.replace(/\.(step|stp|iges|igs|brep)$/i, ''),
            file.name,
          );
          if (result.warnings.length) {
            setWarnings((prev) => [...result.warnings, ...prev.slice(0, 2)]);
          }
        }
      } catch (err) {
        setWarnings([`Failed to load model: ${(err as Error).message}`]);
      } finally {
        setLoading(false);
      }
    },
    [ingest, setLoading, setWarnings],
  );

  const openDemo = useCallback(() => {
    const { root, name } = makeDemoAssembly();
    ingest(root, 'demo://gearbox', name, 'built-in demo');
  }, [ingest]);

  const openProject = useCallback(
    async (file: File) => {
      setLoading(true);
      try {
        const raw = JSON.parse(await file.text());
        const opened = await openProjectJson(raw);

        loadSequence(opened.sequence);

        if (opened.scene) {
          // Re-derive stats so the camera frames the restored model.
          const result = buildAssemblyFromScene(
            opened.scene, opened.sequence.assembly.modelUrl, {
              name: opened.sequence.assembly.name,
              sourceFile: opened.sequence.assembly.sourceFile,
            },
          );
          setScene(result.scene);
          setDiagonal(result.stats.diagonal || 200);
          setCenter(result.stats.center);
          setWarnings([`Project restored with geometry — ${result.stats.meshCount} meshes.`]);
        } else {
          setWarnings(opened.warnings);
        }
      } catch (err) {
        setWarnings([`Invalid project file: ${(err as Error).message}`]);
      } finally {
        setLoading(false);
      }
    },
    [loadSequence, setWarnings, setLoading],
  );

  const saveProject = useCallback(async () => {
    if (!sequence) return;
    setLoading(true);
    try {
      const { bytes, embedded } = await downloadBundle(sequence, scene);
      setWarnings([
        embedded
          ? `Saved with embedded geometry (${(bytes / 1024 / 1024).toFixed(1)} MB).`
          : 'Saved, but geometry could not be embedded — re-open the model after loading.',
      ]);
    } catch (err) {
      setWarnings([`Save failed: ${(err as Error).message}`]);
    } finally {
      setLoading(false);
    }
  }, [sequence, scene, setWarnings, setLoading]);

  // Keyboard: space = play/pause, ctrl+z / ctrl+shift+z = undo/redo.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        e.shiftKey ? redo() : undo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [togglePlay, undo, redo]);

  const [dragOver, setDragOver] = useState(false);

  // Drag-and-drop straight onto the window: the fastest path from a CAD
  // export to something on screen.
  useEffect(() => {
    const onDragOver = (e: DragEvent) => {
      e.preventDefault();
      setDragOver(true);
    };
    const onDragLeave = (e: DragEvent) => {
      if (e.relatedTarget === null) setDragOver(false);
    };
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const file = e.dataTransfer?.files?.[0];
      if (!file) return;
      if (file.name.toLowerCase().endsWith('.json')) openProject(file);
      else openModel(file);
    };

    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [openModel, openProject]);

  const exportDoc = useCallback(async () => {
    if (!sequence) return;
    setLoading(true);
    try {
      const images = new Map<string, string>();

      if (scene && sequence.operations.length) {
        setWarnings([`Rendering ${sequence.operations.length} step image(s)…`]);
        const shots = await captureStepImages(sequence, scene, {
          homeCamera: sequence.homeCamera,
        });
        for (const shot of shots) images.set(shot.operationId, shot.dataUrl);
      }

      exportInstructionsHtml(sequence, images);
      setWarnings([
        images.size
          ? `Exported with ${images.size} step image(s). Print to PDF from the browser.`
          : 'Exported. Add steps to include step images.',
      ]);
    } catch (err) {
      // Never lose the document over a failed render — ship it text-only.
      exportInstructionsHtml(sequence);
      setWarnings([`Exported without images: ${(err as Error).message}`]);
    } finally {
      setLoading(false);
    }
  }, [sequence, scene, setWarnings, setLoading]);

  const toggleRecord = () => {
    if (recording) {
      stopRecording.current?.();
      stopRecording.current = null;
      setRecording(false);
      return;
    }
    const canvas = document.querySelector('canvas');
    if (!canvas) return;
    stopRecording.current = recordCanvas(canvas, `${sequence?.name ?? 'sequence'}.webm`);
    setRecording(true);
  };

  return (
    <div className={`app${dragOver ? ' drag-over' : ''}`}>
      <header className="topbar">
        <div className="brand">Assembly Studio</div>

        <label className="btn">
          Open model
          <input
            type="file"
            accept=".glb,.gltf,.step,.stp,.iges,.igs,.brep"
            hidden
            onChange={(e) => e.target.files?.[0] && openModel(e.target.files[0])}
          />
        </label>

        <label className="btn">
          Open project
          <input
            type="file"
            accept=".json"
            hidden
            onChange={(e) => e.target.files?.[0] && openProject(e.target.files[0])}
          />
        </label>

        <button className="btn" onClick={openDemo}>Demo model</button>

        <div className="spacer" />

        <button className="btn" disabled={!sequence} onClick={saveProject}>
          Save
        </button>
        <button className="btn" disabled={!sequence} onClick={exportDoc}>
          Export doc
        </button>
        <button
          className="btn"
          disabled={!sequence || viewport.isOut}
          title="Open the 3D viewport in its own window; this window becomes the full-width authoring surface"
          onClick={viewport.open}
        >
          ⇲ Pop out 3D
        </button>
        <button className={`btn${recording ? ' rec' : ''}`} disabled={!sequence} onClick={toggleRecord}>
          {recording ? '■ Stop' : '● Record'}
        </button>
      </header>

      {warnings.length > 0 && (
        <div className="warnings">
          {warnings.map((w, i) => (
            <div key={i} className={w.startsWith('CRITICAL') ? 'warn critical' : 'warn'}>
              {w}
            </div>
          ))}
          <button className="dismiss" onClick={() => setWarnings([])}>✕</button>
        </div>
      )}

      {dragOver && (
        <div className="drop-hint">Drop a .step, .glb, or project .json to open</div>
      )}

      <div className={`body${viewport.isOut ? ' popped' : ''}`}>
        <aside className="left"><AssemblyTree /></aside>
        {/* Popped out: the motion/timeline panel takes the center column at
            full height — assembly | motion | instruction, three full-length
            panels. The viewport renders in its own window via the portal. */}
        {viewport.isOut && (
          <main className="center center-motion"><Timeline /></main>
        )}
        {viewport.portal(
          <main className={viewport.isOut ? 'center popout-fill' : 'center'}>
            {loading && <div className="overlay">Loading model…</div>}
            {!sequence && !loading && (
              <div className="overlay welcome">
                <h2>Assembly Studio</h2>
                <p>Open a <b>.glb</b> / <b>.gltf</b> assembly, or try the demo model.</p>
                <p className="small">
                  Drop a <b>.step</b> file straight in — no conversion needed.<br />
                  Export each solid as a <b>separate named object</b> — do not merge.
                </p>
                <button className="btn big" onClick={openDemo}>Load demo model</button>
              </div>
            )}
            <Viewport
              scene={scene}
              assembly={sequence?.assembly ?? null}
              diagonal={diagonal}
              center={center}
            />
            <ViewportToolbar />
            <AxisLegend />
            {viewport.isOut && (
              <button
                className="btn popin-btn"
                title="Dock the viewport back into the main window"
                onClick={viewport.close}
              >
                ⇱ Pop back in
              </button>
            )}
          </main>,
        )}
        <aside className="right"><Inspector /></aside>
      </div>

      {!viewport.isOut && (
        <footer className="bottom"><Timeline /></footer>
      )}
    </div>
  );
}
