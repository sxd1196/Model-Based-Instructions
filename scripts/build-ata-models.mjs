/**
 * One-time fixture build: convert Assemble-Them-All benchmark assemblies
 * (per-part OBJ files, credit: Tian et al., MIT CSAIL / Fusion 360 Gallery
 * dataset) into single named-mesh GLBs the app ingests directly.
 * Source: https://github.com/yunshengtian/Assemble-Them-All
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as THREE from 'three';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';

// GLTFExporter assumes browser APIs; node 20+ has Blob, needs FileReader.
if (typeof globalThis.FileReader === 'undefined') {
  globalThis.FileReader = class {
    readAsArrayBuffer(blob) {
      blob.arrayBuffer().then((buf) => {
        this.result = buf;
        this.onloadend?.();
      });
    }
    readAsDataURL(blob) {
      blob.arrayBuffer().then((buf) => {
        this.result = 'data:application/octet-stream;base64,' + Buffer.from(buf).toString('base64');
        this.onloadend?.();
      });
    }
  };
}

const SRC = process.argv[2];
const OUT = 'public/models';
const PICKS = [
  { id: '00031', name: 'ATA Beam Joint (3 parts)' },
  { id: '00026', name: 'ATA Latch Block (4 parts)' },
  { id: '00014', name: 'ATA Clamp (5 parts)' },
  { id: '00057', name: 'ATA Housing Stack (7 parts)' },
  { id: '00024', name: 'ATA Bracket Set (10 parts)' },
];

fs.mkdirSync(OUT, { recursive: true });
const loader = new OBJLoader();

for (const pick of PICKS) {
  const dir = path.join(SRC, pick.id);
  const objs = fs.readdirSync(dir).filter((f) => f.endsWith('.obj')).sort();
  const root = new THREE.Group();
  root.name = pick.name;
  for (const file of objs) {
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    const group = loader.parse(text);
    // Merge each OBJ's meshes into ONE part mesh (they are one part).
    const geos = [];
    group.traverse((o) => { if (o.isMesh) geos.push(o.geometry); });
    if (!geos.length) continue;
    let geo = geos[0];
    if (geos.length > 1) {
      const { mergeGeometries } = await import('three/examples/jsm/utils/BufferGeometryUtils.js');
      geo = mergeGeometries(geos.map((g) => g.index ? g.toNonIndexed() : g));
    }
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
      color: 0x8892a6, metalness: 0.3, roughness: 0.6,
    }));
    mesh.name = 'Part_' + path.basename(file, '.obj');
    root.add(mesh);
  }

  // These OBJs are unit-scaled; the app treats units as mm. Scale so the
  // assembly diagonal lands ~200mm (typical bench part).
  const box = new THREE.Box3().setFromObject(root);
  const diag = box.getSize(new THREE.Vector3()).length() || 1;
  const s = 200 / diag;
  for (const child of root.children) {
    child.geometry.scale(s, s, s);
  }

  const exporter = new GLTFExporter();
  const glb = await exporter.parseAsync(root, { binary: true });
  const out = path.join(OUT, `ata-${pick.id}.glb`);
  fs.writeFileSync(out, Buffer.from(glb));
  console.log(`${out}: ${root.children.length} parts, ${(fs.statSync(out).size / 1024).toFixed(0)}KB`);
}
