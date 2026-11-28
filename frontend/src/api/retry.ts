/** Answers that mean the gateway in front of the app gave up, not the app:
 * a request that takes longer than the gateway's timeout (a scenario's
 * curves, computed the first time: a felt-temperature field per sampled
 * year) gets one, while the app goes on computing and keeps the result.
 * Asked again a little later, it answers at once, or waits for the
 * computation already running (fields.py's ComputeCache): retrying costs
 * the server nothing more. */
const GATEWAY_GAVE_UP = new Set([502, 503, 504]);

/** The waits before each retry: about half a minute more in all. */
export const RETRY_DELAYS_MS = [2000, 4000, 8000, 8000, 8000];

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** `attempt` again after a gateway's timeout or a dropped connection (fetch
 * rejects with a TypeError), up to `delays.length` more times; the last
 * answer or error as it is. For GETs only: they change nothing. */
export async function withRetries(
  attempt: () => Promise<Response>,
  delays: readonly number[] = RETRY_DELAYS_MS,
  wait: (ms: number) => Promise<void> = sleep,
): Promise<Response> {
  for (let retry = 0; ; retry++) {
    const last = retry >= delays.length;
    try {
      const res = await attempt();
      if (last || !GATEWAY_GAVE_UP.has(res.status)) return res;
    } catch (error) {
      if (last || !(error instanceof TypeError)) throw error;
    }
    await wait(delays[retry]);
  }
}
