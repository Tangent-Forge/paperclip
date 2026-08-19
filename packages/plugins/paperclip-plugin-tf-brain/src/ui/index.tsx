// UI bundle entrypoint. Re-exports every component referenced by an `exportName`
// in the manifest so esbuild can tree-shake the page surface into one bundle.
export { BrainPage } from "./BrainPage.js";
