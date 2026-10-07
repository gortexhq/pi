// Loads the extension factory under test, which the harness then hands to
// Pi's own loader as an inline extension. jiti runs with moduleCache:false,
// so every load re-evaluates the module graph the way Pi's /reload
// re-imports the extension (module-level state in state.ts resets); the
// memoized factory keeps one shared module state per generation, because a
// /new must see the previous invocation's bridge in order to stop it.

import path from "node:path";
import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { GortexExtensionOptions } from "../../src/index.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const INDEX_TS = path.join(HERE, "..", "..", "src", "index.ts");

export type Factory = (pi: ExtensionAPI, options?: GortexExtensionOptions) => void;

const factories = new Map<number, Promise<Factory>>();

export async function loadFactory(generation = 0): Promise<Factory> {
  let factory = factories.get(generation);
  if (!factory) {
    factory = createJiti(import.meta.url, { moduleCache: false, fsCache: false })
      .import(INDEX_TS)
      .then((value: unknown) => {
        const mod = value as { default?: unknown };
        if (typeof mod.default !== "function") {
          throw new Error("extension source does not default-export a factory function");
        }
        return mod.default as Factory;
      });
    factories.set(generation, factory);
  }
  return factory;
}
