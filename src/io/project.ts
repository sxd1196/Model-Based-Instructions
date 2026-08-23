/** Save/load .assemblyproj files (JSON) and export instructions. */
import type { Sequence } from '@/domain/schema';
import { parseSequence } from '@/domain/schema';
import { buildTimeline } from '@/domain/evaluate';
import { richToHtml } from '@/domain/richtext';
import { buildBundle } from './bundle';

/** Legacy: sequence-only save. Prefer downloadBundle so geometry is kept. */
export function downloadSequence(sequence: Sequence) {
  const blob = new Blob([JSON.stringify(sequence, null, 2)], {
    type: 'application/json',
  });
  triggerDownload(blob, `${slug(sequence.name)}.assemblyproj.json`);
}

export async function readSequenceFile(file: File): Promise<Sequence> {
  const text = await file.text();
  return parseSequence(JSON.parse(text));
}

/**
 * Build a plain work-instruction document. Intentionally HTML, not PDF —
 * the browser prints HTML to PDF perfectly and it keeps us dependency-free.
 *
 * Pure: returns a string and touches no DOM, so it is testable headlessly.
 * `exportInstructionsHtml` is the thin browser wrapper around it.
 */
export function buildInstructionsHtml(
  sequence: Sequence,
  images: Map<string, string> = new Map(),
): string {
  const timeline = buildTimeline(sequence);
  const rows = timeline
    .map(
      (e, i) => `
    <section class="step">
      <h2><span class="num">${i + 1}</span> ${escapeHtml(e.operation.title)}</h2>
      ${
        images.has(e.operation.id)
          ? `<img class="shot" src="${images.get(e.operation.id)}" alt="Step ${i + 1}">`
          : ''
      }
      ${e.operation.description ? `<p>${richToHtml(e.operation.descriptionRich, e.operation.description)}</p>` : ''}
      ${
        e.operation.annotations.length
          ? `<ul class="callouts">${e.operation.annotations
              .map((a) => `<li>${richToHtml(a.rich, a.text)}</li>`)
              .join('')}</ul>`
          : ''
      }
      <dl>
        <dt>Parts</dt><dd>${
          e.operation.tracks
            .flatMap((t) => t.parts)
            .map((p) => escapeHtml(sequence.assembly.parts[p]?.name ?? p))
            .join(', ') || '—'
        }</dd>
        <dt>Time</dt><dd>${e.startTime.toFixed(1)}s – ${e.endTime.toFixed(1)}s</dd>
        ${Object.entries(e.operation.meta)
          .map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`)
          .join('')}
      </dl>
    </section>`,
    )
    .join('\n');

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(sequence.name)}</title>
<style>
  body{font:14px/1.6 system-ui,sans-serif;max-width:800px;margin:40px auto;padding:0 20px;color:#111}
  h1{border-bottom:2px solid #111;padding-bottom:8px}
  .step{page-break-inside:avoid;margin:28px 0;padding:16px;border:1px solid #ddd;border-radius:6px}
  .num{display:inline-block;width:28px;height:28px;line-height:28px;text-align:center;
       background:#111;color:#fff;border-radius:50%;margin-right:8px;font-size:14px}
  h2{font-size:17px;margin:0 0 8px}
  dl{display:grid;grid-template-columns:110px 1fr;gap:4px 12px;margin:10px 0 0;font-size:13px}
  dt{color:#666}dd{margin:0}
  .shot{width:100%;max-width:640px;border:1px solid #ddd;border-radius:4px;margin:10px 0;display:block}
  @media print{.step{border-color:#999}}
</style></head>
<body>
  <h1>${escapeHtml(sequence.name)}</h1>
  <p><b>Intent:</b> ${sequence.intent} &nbsp; <b>Steps:</b> ${timeline.length} &nbsp;
     <b>Source:</b> ${escapeHtml(sequence.assembly.sourceFile || sequence.assembly.name)}</p>
  ${rows}
</body></html>`;
}

export function exportInstructionsHtml(
  sequence: Sequence,
  images: Map<string, string> = new Map(),
) {
  const html = buildInstructionsHtml(sequence, images);
  triggerDownload(new Blob([html], { type: 'text/html' }), `${slug(sequence.name)}-instructions.html`);
}

/**
 * Record the canvas to WebM using the browser's own MediaRecorder.
 * No ffmpeg, no server. Returns a stop() you must call.
 */
export function recordCanvas(
  canvas: HTMLCanvasElement,
  filename = 'sequence.webm',
  fps = 60,
): () => void {
  const stream = canvas.captureStream(fps);
  const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find(
    (m) => MediaRecorder.isTypeSupported(m),
  );
  const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const chunks: BlobPart[] = [];

  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  recorder.onstop = () =>
    triggerDownload(new Blob(chunks, { type: 'video/webm' }), filename);
  recorder.start();

  return () => recorder.state !== 'inactive' && recorder.stop();
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'sequence';

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

/** Save a project WITH its geometry embedded, so reopening restores the model. */
export async function downloadBundle(
  sequence: Sequence,
  scene: unknown,
): Promise<{ bytes: number; embedded: boolean }> {
  const bundle = await buildBundle(sequence, scene as never);
  const json = JSON.stringify(bundle);
  triggerDownload(
    new Blob([json], { type: 'application/json' }),
    `${slug(sequence.name)}.assemblyproj.json`,
  );
  return { bytes: json.length, embedded: Boolean(bundle.modelGlb) };
}
