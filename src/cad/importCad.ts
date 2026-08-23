/**
 * In-browser STEP / IGES / BREP import via OpenCascade compiled to WASM.
 *
 * Removes the FreeCAD round-trip for the common case: drop a .step file
 * straight into the app. The WASM module is ~8MB, so it is loaded lazily on
 * first use rather than at startup.
 *
 * SolidWorks .sldasm/.sldprt are NOT supported and cannot be: the format is
 * proprietary and closed, and no open-source reader exists. `describeFile`
 * detects them and returns an actionable message instead of failing obscurely.
 */
import * as THREE from 'three';

export type CadFormat = 'gltf' | 'step' | 'iges' | 'brep' | 'solidworks' | 'unknown';

export interface FormatInfo {
  format: CadFormat;
  /** Can this app open it directly? */
  supported: boolean;
  /** User-facing explanation when it cannot. */
  message?: string;
}

/** Classify a file by extension and say plainly what can be done with it. */
export function describeFile(filename: string): FormatInfo {
  const ext = filename.toLowerCase().split('.').pop() ?? '';

  switch (ext) {
    case 'glb':
    case 'gltf':
      return { format: 'gltf', supported: true };

    case 'step':
    case 'stp':
      return { format: 'step', supported: true };

    case 'iges':
    case 'igs':
      return { format: 'iges', supported: true };

    case 'brep':
      return { format: 'brep', supported: true };

    case 'sldasm':
    case 'sldprt':
      return {
        format: 'solidworks',
        supported: false,
        message:
          'SolidWorks files are a closed, proprietary format — no open-source ' +
          'library can read them. In SolidWorks: File → Save As → STEP AP242, ' +
          'enable "Export assembly as multiple bodies", then open the .step here.',
      };

    case 'ipt':
    case 'iam':
      return {
        format: 'unknown',
        supported: false,
        message:
          'Inventor files are proprietary. Export STEP (AP242 or AP214) from ' +
          'Inventor and open that instead.',
      };

    case 'f3d':
    case 'f3z':
      return {
        format: 'unknown',
        supported: false,
        message:
          'Fusion 360 archives are proprietary. Use File → Export → STEP in ' +
          'Fusion, then open the .step here.',
      };

    default:
      return {
        format: 'unknown',
        supported: false,
        message: `Unrecognised file type ".${ext}". Supported: .step/.stp, .iges/.igs, .brep, .glb/.gltf.`,
      };
  }
}

// ---------------------------------------------------------------- wasm

type OcctModule = {
  ReadStepFile: (buf: Uint8Array, params: unknown) => OcctResult;
  ReadIgesFile: (buf: Uint8Array, params: unknown) => OcctResult;
  ReadBrepFile: (buf: Uint8Array, params: unknown) => OcctResult;
};

interface OcctMesh {
  name?: string;
  color?: [number, number, number];
  attributes: {
    position: { array: number[] };
    normal?: { array: number[] };
  };
  index?: { array: number[] };
}

interface OcctNode {
  name?: string;
  meshes?: number[];
  children?: OcctNode[];
}

interface OcctResult {
  success: boolean;
  meshes?: OcctMesh[];
  root?: OcctNode;
}

let occtPromise: Promise<OcctModule> | null = null;

/**
 * Where the browser should fetch the OCCT wasm binary from.
 *
 * Explicit rather than sniffed. Emscripten resolves its .wasm relative to the
 * page, which under Vite hits the SPA HTML fallback and dies with
 * "expected magic word 00 61 73 6d, found 3c 21 64 6f" (that being `<!do`).
 * Environment detection is unreliable here — vitest's jsdom reports a
 * plausible http://localhost baseURI AND sets import.meta.env.DEV, so both
 * the obvious checks misfire and send Node looking for C:\wasm\.
 *
 * So: the browser entry point sets this once at startup; tests leave it null
 * and get the package's own resolution, which works fine under Node.
 */
let wasmUrl: string | null = null;

/** Call once from the browser entry point. */
export function setOcctWasmUrl(url: string): void {
  wasmUrl = url;
}

/** Lazily initialise the ~8MB WASM module; cached for the session. */
async function getOcct(): Promise<OcctModule> {
  if (!occtPromise) {
    occtPromise = import('occt-import-js').then((mod) => {
      // occt-import-js is a UMD bundle, so the callable factory can land on
      // `default`, `default.default`, or the namespace itself depending on how
      // the bundler interops it. Node CJS and Vite ESM disagree — hence the
      // probe rather than a fixed unwrap. Getting this wrong fails at runtime
      // with "init is not a function".
      const candidates = [
        (mod as unknown as Record<string, unknown>).default,
        ((mod as unknown as Record<string, Record<string, unknown>>).default ?? {}).default,
        mod as unknown,
      ];
      const factory = candidates.find((c) => typeof c === 'function') as
        | ((options?: { locateFile?: (path: string) => string }) => Promise<OcctModule>)
        | undefined;

      if (!factory) {
        throw new Error(
          'occt-import-js did not expose a callable initialiser — the module ' +
          'shape changed. Check the UMD interop in cad/importCad.ts.',
        );
      }

      return wasmUrl
        ? factory({
            locateFile: (path: string) => (path.endsWith('.wasm') ? wasmUrl! : path),
          })
        : factory();
    });
  }
  return occtPromise;
}

export interface StepImportResult {
  scene: THREE.Group;
  /** Non-fatal notes worth showing the user. */
  warnings: string[];
  meshCount: number;
  triangleCount: number;
}

/**
 * Parse a STEP/IGES/BREP buffer into a three.js scene graph.
 *
 * The OCCT node tree is preserved as nested Groups so sub-assemblies survive —
 * flattening here would defeat the whole point (AGENTS.md §2.5).
 */
export async function importCadFile(
  buffer: ArrayBuffer,
  filename: string,
): Promise<StepImportResult> {
  const info = describeFile(filename);
  if (!info.supported) throw new Error(info.message ?? 'Unsupported file type');

  const occt = await getOcct();
  const bytes = new Uint8Array(buffer);

  const result =
    info.format === 'iges'
      ? occt.ReadIgesFile(bytes, null)
      : info.format === 'brep'
        ? occt.ReadBrepFile(bytes, null)
        : occt.ReadStepFile(bytes, null);

  if (!result.success) {
    throw new Error(
      'OpenCascade could not read this file. It may be corrupt, or saved in a ' +
      'STEP flavour this build does not support — try re-exporting as AP214 or AP242.',
    );
  }

  const meshes = result.meshes ?? [];
  const warnings: string[] = [];

  if (!meshes.length) {
    warnings.push(
      'CRITICAL: the file parsed but contains no solid geometry. Surface-only ' +
      'or wireframe exports cannot be animated — re-export with solids.',
    );
  }

  const scene = new THREE.Group();
  scene.name = filename.replace(/\.(step|stp|iges|igs|brep)$/i, '');

  const built = meshes.map((m, i) => buildMesh(m, i));
  let triangleCount = 0;
  for (const mesh of built) {
    const idx = mesh.geometry.getIndex();
    triangleCount += idx ? idx.count / 3 : mesh.geometry.attributes.position.count / 3;
  }

  // Rebuild the assembly hierarchy from the OCCT node tree.
  const used = new Set<number>();
  if (result.root) {
    attachNode(result.root, scene, built, used, true);
  }
  // Any mesh the tree did not reference still belongs in the scene.
  built.forEach((mesh, i) => {
    if (!used.has(i)) scene.add(mesh);
  });

  const unnamed = built.filter((m) => !m.name || /^mesh_\d+$/.test(m.name)).length;
  if (unnamed > 0) {
    warnings.push(
      `${unnamed} solid(s) arrived without a name. Name parts in your CAD system ` +
      'before exporting — unnamed parts get synthetic ids that change on re-export, ' +
      'which breaks saved sequences.',
    );
  }

  return { scene, warnings, meshCount: built.length, triangleCount: Math.round(triangleCount) };
}

function buildMesh(m: OcctMesh, index: number): THREE.Mesh {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(m.attributes.position.array, 3),
  );

  if (m.attributes.normal?.array?.length) {
    geometry.setAttribute(
      'normal',
      new THREE.Float32BufferAttribute(m.attributes.normal.array, 3),
    );
  }
  if (m.index?.array?.length) {
    geometry.setIndex(m.index.array);
  }
  if (!m.attributes.normal?.array?.length) {
    geometry.computeVertexNormals();
  }

  const material = new THREE.MeshStandardMaterial({
    color: m.color ? new THREE.Color(...m.color) : 0x9aa4b2,
    roughness: 0.55,
    metalness: 0.45,
    side: THREE.DoubleSide,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = m.name?.trim() || `mesh_${index}`;
  return mesh;
}

/** Recreate OCCT's node tree as nested three.js Groups. */
function attachNode(
  node: OcctNode,
  parent: THREE.Object3D,
  meshes: THREE.Mesh[],
  used: Set<number>,
  isRoot = false,
): void {
  // The OCCT root is a synthetic wrapper; do not add a redundant group for it.
  const target = isRoot
    ? parent
    : (() => {
        const g = new THREE.Group();
        g.name = node.name?.trim() || 'Group';
        parent.add(g);
        return g;
      })();

  for (const meshIndex of node.meshes ?? []) {
    const mesh = meshes[meshIndex];
    if (mesh && !used.has(meshIndex)) {
      used.add(meshIndex);
      target.add(mesh);
    }
  }

  for (const child of node.children ?? []) {
    attachNode(child, target, meshes, used);
  }
}
