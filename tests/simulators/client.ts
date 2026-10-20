import { type Data, object, string } from "../../src/lib/protocol";
import { CodexSimulator } from "./codex";
import { type ScriptedCall } from "./contract";
import { type TurnScenario } from "./codex-turns";

/**
Drive complete simulator lifecycles with the same wire envelopes as a native transport.
*/
export class SimulatorClient {
  private sequence = 0;
  messages: Data[] = [];
  server: CodexSimulator;

  /**
Create one connection and retain its complete protocol traffic for assertions.
@param options - Isolated state and explicit scenarios.
*/
  constructor(options: { stateFile?: string; scripts?: ScriptedCall[]; turn?: TurnScenario } = {}) {
    this.server = new CodexSimulator((message) => {
      this.messages.push(structuredClone(message));
    }, options);
  }

  /**
Find exactly one acknowledgement for a submitted request.
@param id - Request identity.
@returns Native result.
*/
  private response(id: number) {
    const matches = this.messages.filter((message) => !message.method && message.id === id);
    const response = matches.at(0);

    if (!response || matches.length !== 1) {
      throw new Error(`Expected exactly one acknowledgement for ${String(id)}`);
    }

    if (response.error) {
      throw new Error(string(object(response.error).message));
    }

    return object(response.result);
  }

  /**
Send a native request and surface any simulator or native-style error.
@param method - Request method.
@param params - Native parameters.
@returns Validated response object.
*/
  async call(method: string, params: Data | null = {}) {
    const id = ++this.sequence;

    await this.server.receive({ id, method, params });

    return this.response(id);
  }

  /**
Initialize the wire protocol before other operations.
*/
  async initialize() {
    await this.call("initialize", {
      clientInfo: { name: "pocket-flow", version: "1" },
      capabilities: { experimentalApi: true },
    });
    await this.server.receive({ method: "initialized" });
  }
}
