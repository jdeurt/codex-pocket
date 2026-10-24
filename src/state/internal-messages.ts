import { string } from "../lib/protocol";
import { delegationMessagePrefix } from "./delegation-queue";
import { isRecoveryMessageId } from "./recovery";
import { REALTIME_TOOL_PREFIX } from "./realtime-tools";

/** Recognize reserved host receipt identities without inspecting text or trusting quoted markers.
@param id - Native or durable receipt identity.
@returns Whether this receipt belongs to host-generated internal work.
*/
export function isInternalMessageId(id: unknown) {
  return (
    isRecoveryMessageId(id) ||
    string(id).startsWith(delegationMessagePrefix) ||
    string(id).startsWith(REALTIME_TOOL_PREFIX)
  );
}
