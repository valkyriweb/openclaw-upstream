/**
 * Pi Fork plugin config helpers.
 */
import { existsSync } from "node:fs";
import type { PiHarnessConfig } from "./config-types.js";
import { ensureManagedPiRuntime } from "./managed-runtime.js";

export type { PiHarnessConfig } from "./config-types.js";

/** Well-known fallback locations for the pi binary, in preference order. */
const FALLBACK_PI_PATHS = [
  // pi-mono-fork local build (relative to standard home dir layout)
  `${process.env.HOME}/Projects/personal/pi-mono-fork/packages/coding-agent/dist/cli.js`,
  // pi CLI installed to user's local bin
  `${process.env.HOME}/.local/bin/pi`,
];

/**
 * Resolve the pi binary to use for spawning the RPC process.
 * Order: config.command → PATH 'pi' → fallback local dist paths.
 */
export function resolvePiBinary(config: PiHarnessConfig): string {
  if (config.command) {
    return config.command;
  }

  // Check if 'pi' is on PATH (skip full which() for simplicity — spawn will fail fast if not)
  // Check fallback paths next
  for (const fallback of FALLBACK_PI_PATHS) {
    if (existsSync(fallback)) {
      // If it's a .js file, run it with node
      if (fallback.endsWith(".js")) {
        return process.execPath; // will be combined with args in the caller
      }
      return fallback;
    }
  }

  // Default: assume 'pi' is on PATH
  return "pi";
}

/**
 * Resolve binary + args tuple, handling the case where the resolved binary is a
 * Node.js script (dist/cli.js) that needs to be invoked as `node <script> ...`.
 */
export function resolvePiCommand(config: PiHarnessConfig): {
  bin: string;
  prefixArgs: string[];
} {
  if (config.command) {
    ensureManagedPiRuntime(config);
    return { bin: config.command, prefixArgs: [] };
  }

  const managed = ensureManagedPiRuntime(config);
  if (managed) {
    return { bin: managed, prefixArgs: [] };
  }

  for (const fallback of FALLBACK_PI_PATHS) {
    if (existsSync(fallback)) {
      if (fallback.endsWith(".js")) {
        return { bin: process.execPath, prefixArgs: [fallback] };
      }
      return { bin: fallback, prefixArgs: [] };
    }
  }

  return { bin: "pi", prefixArgs: [] };
}
