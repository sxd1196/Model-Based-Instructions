import { useCallback, useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { useStore } from '@/state/store';
import { buildAssemblyFromScene } from '@/cad/loadGltf';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { Viewport } from '@/viewer/Viewport';
import { AssemblyTree } from '@/ui/AssemblyTree';
import { Timeline } from '@/ui/Timeline';
import { Inspector } from '@/ui/Inspector';
import { ViewportToolbar } from '@/ui/ViewportToolbar';
import { AxisLegend } from '@/ui/AxisLegend';
import {
  downloadSequence,
  exportInstructionsHtml,
  readSequenceFile,
  recordCanvas,
} from '@/io/project';
import { makeDemoAssembly } from '@/cad/demo';
import './App.css';

export default function App() {
  const [scene, setScene] = useState<THREE.Object3D | null>(null);
  const [diagonal, setDiagonal] = useState(200);
  const [center, setCenter] = useState<[number, number, number]>([0, 0, 0]);
  const stopRecording = useRef<(() => void) | null>(null);
  const [recording, setRecording] = useState(false);

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
      setLoading(true);
      try {
        const url = URL.createObjectURL(file);
        const loader = new GLTFLoader();
        const gltf = await loader.loadAsync(url);
        ingest(gltf.scene, url, file.name.replace(/\.(glb|gltf)$/i, ''), file.name);
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
      try {
        loadSequence(await readSequenceFile(file));
        setWarnings(['Project loaded. Re-open the model file to see geometry.']);
      } catch (err) {
        setWarnings([`Invalid project file: ${(err as Error).message}`]);
      }
    },
    [loadSequence, setWarnings],
  );

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
    <div className="app">
      <header className="topbar">
        <div className="brand">Assembly Studio</div>

        <label className="btn">
          Open model
          <input
            type="file"
            accept=".glb,.gltf"
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

        <button className="btn" disabled={!sequence} onClick={() => sequence && downloadSequence(sequence)}>
          Save
        </button>
        <button className="btn" disabled={!sequence} onClick={() => sequence && exportInstructionsHtml(sequence)}>
          Export doc
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

      <div className="body">
        <aside className="left"><AssemblyTree /></aside>
        <main className="center">
          {loading && <div className="overlay">Loading model…</div>}
          {!sequence && !loading && (
            <div className="overlay welcome">
              <h2>Assembly Studio</h2>
              <p>Open a <b>.glb</b> / <b>.gltf</b> assembly, or try the demo model.</p>
              <p className="small">
                Convert STEP → glTF with FreeCAD or CAD Assistant.<br />
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
        </main>
        <aside className="right"><Inspector /></aside>
      </div>

      <footer className="bottom"><Timeline /></footer>
    </div>
  );
}
