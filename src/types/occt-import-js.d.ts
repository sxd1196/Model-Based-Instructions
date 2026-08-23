/**
 * occt-import-js ships no type declarations. The API surface we actually use
 * is modelled explicitly in cad/importCad.ts; this stops TypeScript treating
 * the bare import as an error.
 */
declare module 'occt-import-js' {
  const init: () => Promise<unknown>;
  export default init;
}
