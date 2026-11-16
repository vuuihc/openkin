/**
 * Local, offline Monaco setup for Vite. No CDN.
 *
 * - Points `@monaco-editor/react`'s loader at the bundled `monaco-editor`
 *   package so it never fetches the AMD loader from jsDelivr.
 * - Wires language workers via Vite's `?worker` imports so features like
 *   syntax tokenization run off the main thread, all served from our bundle.
 *
 * Imported for its side effects; import once before rendering an editor.
 */
import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

// `MonacoEnvironment` is declared globally by the monaco-editor package.
self.MonacoEnvironment = {
  getWorker(_workerId, label) {
    if (label === "json") return new jsonWorker();
    if (label === "css" || label === "scss" || label === "less") return new cssWorker();
    if (label === "html" || label === "handlebars" || label === "razor") return new htmlWorker();
    if (label === "typescript" || label === "javascript") return new tsWorker();
    return new editorWorker();
  },
};

// Use the locally bundled monaco instead of the CDN loader default.
loader.config({ monaco });

export default monaco;
