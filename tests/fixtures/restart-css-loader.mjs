// The whole-component SSR check needs no CSS evaluation; browser checks use real styles.
import { registerHooks } from "node:module";

registerHooks({
  load(url, context, nextLoad) {
    return url.endsWith(".css") ? { format: "module", source: "", shortCircuit: true } : nextLoad(url, context);
  },
});
