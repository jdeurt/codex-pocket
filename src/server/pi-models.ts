import { type ModelRuntime } from "@earendil-works/pi-coding-agent";
import { z } from "zod";

const MISSING_SEPARATOR = -1;

export const thinkingLevelSchema = z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]);

/** Resolve an explicit provider/model identity against Pi's catalog, never an invented model name.
@param runtime - Pi's configured catalog and authentication runtime.
@param selection - Qualified provider/model ID; a bare ID selects the OpenAI provider.
@returns The catalog model or an actionable unsupported-selection error.
*/
export function piModel(runtime: ModelRuntime, selection: string) {
  const separator = selection.indexOf("/");
  const provider = separator === MISSING_SEPARATOR ? "openai" : selection.slice(0, separator);
  const id = separator === MISSING_SEPARATOR ? selection : selection.slice(separator + 1);
  const model = runtime.getModel(provider, id);

  if (!model) {
    throw new Error("Unknown Pi model. Inspect pocket_session_models and choose a listed provider/model ID.");
  }

  return model;
}

/** Expose catalog identities and reasoning support without including credentials.
@param runtime - Pi's configured runtime.
@returns Public catalog metadata used by Pocket's session tools.
*/
export function piModelCatalog(runtime: ModelRuntime) {
  return runtime.getModels().map((model) => ({
    id: `${model.provider}/${model.id}`,
    name: model.name,
    reasoning: model.reasoning,
    contextWindow: model.contextWindow,
  }));
}
