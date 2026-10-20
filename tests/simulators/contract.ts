import { Ajv, type ValidateFunction } from "ajv";
import { type Data, object, string } from "../../src/lib/protocol";
import { array } from "./values";
import { readFileSync } from "node:fs";

const NOT_FOUND = -1;

const contractPath = new URL("contracts/codex.json", import.meta.url);
const protocol = object(JSON.parse(readFileSync(contractPath, "utf8")));
const definitions = object(protocol.definitions);
const ajv = new Ajv({ strict: false, validateFormats: false, allErrors: true, schemas: { codex: protocol } });
const validators = new Map<string, ValidateFunction>();

/**
Find every method in one direction of the complete extracted native protocol.
@param name - Native request or notification union.
@returns Method names and the exact native message schemas.
*/
export function contractMethods(name: string) {
  return new Map(
    array(object(definitions[name]).oneOf).map((variant) => {
      const schema = object(variant);
      const methodSchema = object(object(schema.properties).method);
      const method = string(array(methodSchema.enum)[0]);

      return [method, schema];
    })
  );
}

/**
Validate a message or response against the installed native schema without coercing input.
@param reference - JSON pointer inside the complete extracted contract.
@param value - Incoming or outgoing value.
*/
export function validateContract(reference: string, value: unknown) {
  const isValid = validators.get(reference) ?? ajv.compile({ $ref: `codex#/${reference}` });

  validators.set(reference, isValid);

  if (!isValid(value)) {
    throw new Error(`Contract violation at ${reference}: ${ajv.errorsText(isValid.errors)}`);
  }
}

/**
Validate a single request efficiently without testing all unrelated protocol variants.
@param method - Native method name.
@param value - Complete native message.
@param union - Direction of the message.
*/
export function validateMessage(method: string, value: unknown, union = "ClientRequest") {
  const index = contractMethods(union).keys().toArray().indexOf(method);

  if (index === NOT_FOUND) {
    throw new Error(`Unknown ${union} method: ${method}`);
  }

  validateContract(`definitions/${union}/oneOf/${String(index)}`, value);
}

const responseOverrides: Record<string, string> = {
  "memory/reset": "MemoryResetResponse",
  "rollout/compress": "RolloutCompressResponse",
  "account/gatewayOAuth/read": "GatewayOAuthReadResponse",
  "account/gatewayOAuth/login": "GatewayOAuthLoginResponse",
  "account/gatewayOAuth/cancel": "GatewayOAuthCancelResponse",
  "remoteControl/status/read": "RemoteControlStatusReadResponse",
  "windowsSandbox/readiness": "WindowsSandboxReadinessResponse",
  "account/logout": "LogoutAccountResponse",
  "account/workspaceMessages/read": "GetWorkspaceMessagesResponse",
  "externalAgentConfig/import/readHistories": "ExternalAgentConfigImportHistoriesReadResponse",
  "configRequirements/read": "ConfigRequirementsReadResponse",
  "config/value/write": "ConfigWriteResponse",
  "config/batchWrite": "ConfigWriteResponse",
};

/** Derive the response from the native parameter type, including nullable parameters.
@param method - Native operation.
@param union - Request direction.
@returns Response schema pointer.
*/
function parameterResponse(method: string, union: string) {
  const schema = contractMethods(union).get(method);
  const params = object(object(schema?.properties).params);
  const nullable = array(params.anyOf)
    .map((entry) => object(entry))
    .find((entry) => entry.$ref);
  const reference = string(params.$ref) || string(nullable?.$ref);

  if (!reference) {
    throw new Error(`No native response mapping for ${method}`);
  }

  return reference.slice(2).replace(/Params$/, "Response");
}

/** Resolve every response type, including nullable and parameterless requests.
@param method - Native operation.
@param union - Request direction.
@returns JSON pointer into the extracted response schema, or an empty pointer for the native unit receipt.
*/
export function responseReference(method: string, union = "ClientRequest") {
  if (method === "config/mcpServer/reload") {
    return "";
  }

  return Object.hasOwn(responseOverrides, method)
    ? `definitions/v2/${responseOverrides[method]}`
    : parameterResponse(method, union);
}

/**
Resolve the response type paired with each native request's parameter type.
@param method - Native request method.
@param value - Returned result.
@param union - Request direction.
*/
export function validateResult(method: string, value: unknown, union = "ClientRequest") {
  const reference = responseReference(method, union);

  if (method === "config/mcpServer/reload") {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(object(value)).length > 0) {
      throw new Error("Expected the empty reload receipt observed in native calibration");
    }

    return;
  }

  validateContract(reference, value);
}

export interface ScriptedCall {
  method: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
  before?: Data[];
  after?: Data[];
  disconnect?: boolean;
  delayMs?: number;
}
