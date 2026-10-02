import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

// The dependency-free conformance route loads only its real, bounded source graph.
const approvalKey = new URL("../packages/core/src/approval-effect-key.ts", import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@rakazo/core/node/approval-effect-key") {
      return { url: approvalKey, shortCircuit: true };
    }
    if (context.parentURL && specifier.startsWith(".") && specifier.endsWith(".js")) {
      const source = new URL(specifier.slice(0, -3) + ".ts", context.parentURL);
      if (existsSync(fileURLToPath(source))) return { url: source.href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
