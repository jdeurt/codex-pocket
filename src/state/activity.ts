/**
Host-owned execution bookkeeping passed explicitly through native event transitions.
*/
export interface ActivityState {
  turnId: string;
  calls: [string, string][];
  hasNativeActivity: boolean;
  isReasoning: boolean;
}
