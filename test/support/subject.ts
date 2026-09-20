// Loads the extension factory under test, which the harness then hands to
// Pi's own loader as an inline extension.
//
// `generation` stands in for what jiti's moduleCache:false does on /reload: a
// new generation re-evaluates the module (module-level state in state.ts
// resets); the same generation reuses it (module-level state is shared,
// factory re-invocation only). That distinction is load-bearing: a /new must
// see the previous invocation's bridge in order to stop it.

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { GortexExtensionOptions } from "../../src/index.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const INDEX_TS = path.join(HERE, "..", "..", "src", "index.ts");

export type Factory = (pi: ExtensionAPI, options?: GortexExtensionOptions) => void;

export async function loadFactory(generation = 0): Promise<Factory> {
  const url = pathToFileURL(INDEX_TS).href + `?generation=${generation}`;
  const mod = (await import(url)) as { default?: unknown };
  if (typeof mod.default !== "function") {
    throw new Error("extension source does not default-export a factory function");
  }
  return mod.default as Factory;
}
