/* eslint-disable @typescript-eslint/no-magic-numbers -- Native close has a bounded five-second deadline. */

/**
Wait for the authoritative native close, never just the stop RPC acknowledgment.
@param closed - Promise resolved by the native closed notification.
*/
export async function waitForRealtimeClosed(closed: Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    await Promise.race([
      closed,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error("Native realtime closure was not confirmed."));
        }, 5000);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
