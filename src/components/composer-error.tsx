import { Alert, AlertDescription } from "./ui/alert";
import { Button } from "./ui/button";

/** Show actionable composer failures and let users acknowledge a stopped voice session.
@param props - Ordered errors and optional acknowledgment for the leading voice failure.
@returns The first error without discarding saved speech or retry state.
*/
export function ComposerError({
  errors,
  dismissVoiceError,
}: {
  errors: (string | undefined)[];
  dismissVoiceError?: () => void;
}) {
  const error = errors.find(Boolean);

  return error ? (
    <Alert variant="destructive" className="mb-3">
      <AlertDescription>{error}</AlertDescription>
      {dismissVoiceError && (
        <Button variant="ghost" onClick={dismissVoiceError}>
          Dismiss voice error
        </Button>
      )}
    </Alert>
  ) : null;
}
