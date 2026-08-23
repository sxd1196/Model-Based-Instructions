/**
 * Project bundles: a sequence plus its geometry in one file.
 *
 * Without this, saving a project stores only a filename reference — reopening
 * it shows an empty viewport until you manually re-open the .glb. That reads
 * as data loss even though nothing was lost, and it is the first thing a new
 * user hits.
 *
 * Format: a plain JSON envelope with the glTF embedded as base64. Not the
 * most compact option, but it stays inspectable, diffable, and needs no zip
 * dependency (AGENTS.md §2.8).
 */
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import * as THREE from 'three';
import type { Sequence } from '@/domain/schema';
import { parseSequence } from '@/domain/schema';

export const BUNDLE_VERSION = 1;

export interface ProjectBundle {
  kind: 'assembly-studio-project';
  bundleVersion: number;
  sequence: Sequence;
  /** Binary glTF, base64 encoded. Absent for reference-only projects. */
  modelGlb?: string;
}

/** True when a parsed JSON blob looks like a bundle rather than a bare sequence. */
export function isBundle(raw: unknown): raw is ProjectBundle {
  return (
    typeof raw === 'object' &&
    raw !== null &&
    (raw as ProjectBundle).kind === 'assembly-studio-project'
  );
}

/**
 * Serialize a live scene to a GLB ArrayBuffer.
 *
 * Uses three.js's own exporter so anything the viewer can display can be
 * round-tripped, including geometry that arrived from OpenCascade and never
 * existed as a file.
 */
export function exportSceneToGlb(scene: THREE.Object3D): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const exporter = new GLTFExporter();
    exporter.parse(
      scene,
      (result) => {
        if (result instanceof ArrayBuffer) resolve(result);
        else reject(new Error('Expected binary glTF output'));
      },
      (err) => reject(err instanceof Error ? err : new Error(String(err))),
      { binary: true, onlyVisible: false },
    );
  });
}

/** Load a GLB ArrayBuffer back into a scene graph. */
export function importGlbBuffer(buffer: ArrayBuffer): Promise<THREE.Group> {
  return new Promise((resolve, reject) => {
    new GLTFLoader().parse(
      buffer,
      '',
      (gltf) => resolve(gltf.scene),
      (err) => reject(err instanceof Error ? err : new Error(String(err))),
    );
  });
}

// ---------------------------------------------------------------- base64

/**
 * Chunked base64 encoding.
 *
 * String.fromCharCode(...bytes) blows the call stack on anything over a few
 * hundred KB, and CAD models are megabytes. Chunking is the fix.
 */
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

// ---------------------------------------------------------------- bundle

export async function buildBundle(
  sequence: Sequence,
  scene: THREE.Object3D | null,
): Promise<ProjectBundle> {
  const bundle: ProjectBundle = {
    kind: 'assembly-studio-project',
    bundleVersion: BUNDLE_VERSION,
    sequence,
  };

  if (scene) {
    try {
      bundle.modelGlb = arrayBufferToBase64(await exportSceneToGlb(scene));
    } catch {
      // A project that saves without geometry still beats no project at all;
      // the caller surfaces a warning.
    }
  }

  return bundle;
}

export interface OpenedProject {
  sequence: Sequence;
  scene: THREE.Group | null;
  warnings: string[];
}

/** Open either a bundle or a legacy bare-sequence file. */
export async function openProjectJson(raw: unknown): Promise<OpenedProject> {
  if (!isBundle(raw)) {
    // Older saves stored the sequence alone.
    return {
      sequence: parseSequence(raw),
      scene: null,
      warnings: [
        'This project has no embedded geometry — open the model file to see it. ' +
        'Re-saving will embed it.',
      ],
    };
  }

  const sequence = parseSequence(raw.sequence);

  if (!raw.modelGlb) {
    return {
      sequence,
      scene: null,
      warnings: ['This project was saved without geometry — open the model file to see it.'],
    };
  }

  try {
    const scene = await importGlbBuffer(base64ToArrayBuffer(raw.modelGlb));
    return { sequence, scene, warnings: [] };
  } catch (err) {
    return {
      sequence,
      scene: null,
      warnings: [`Embedded geometry could not be read: ${(err as Error).message}`],
    };
  }
}
