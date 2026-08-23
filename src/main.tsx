import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import { setOcctWasmUrl } from '@/cad/importCad';

// Served from public/wasm by scripts/sync-wasm.mjs. Set explicitly because
// Emscripten's default resolution hits Vite's SPA HTML fallback.
setOcctWasmUrl('/wasm/occt-import-js.wasm');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
