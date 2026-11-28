import { describe, expect, it } from "vitest";
import { withRetries } from "./retry";

const answer = (status: number) => ({ status }) as Response;
const noWait = () => Promise.resolve();

function attempts(...outcomes: (number | Error)[]) {
  let calls = 0;
  const attempt = () => {
    const outcome = outcomes[Math.min(calls++, outcomes.length - 1)];
    return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(answer(outcome));
  };
  return { attempt, calls: () => calls };
}

describe("withRetries", () => {
  it("asks again after a gateway's timeout, until an answer", async () => {
    const { attempt, calls } = attempts(504, 502, 200);
    expect((await withRetries(attempt, [1, 1, 1], noWait)).status).toBe(200);
    expect(calls()).toBe(3);
  });

  it("asks again after a dropped connection", async () => {
    const { attempt, calls } = attempts(new TypeError("Failed to fetch"), 200);
    expect((await withRetries(attempt, [1], noWait)).status).toBe(200);
    expect(calls()).toBe(2);
  });

  it("gives the app's own errors at once", async () => {
    const { attempt, calls } = attempts(500);
    expect((await withRetries(attempt, [1, 1], noWait)).status).toBe(500);
    expect(calls()).toBe(1);
  });

  it("gives up after the last retry, with the last answer", async () => {
    const { attempt, calls } = attempts(504);
    expect((await withRetries(attempt, [1, 1], noWait)).status).toBe(504);
    expect(calls()).toBe(3);
  });

  it("doesn't retry other errors", async () => {
    const { attempt, calls } = attempts(new Error("bug"));
    await expect(withRetries(attempt, [1], noWait)).rejects.toThrow("bug");
    expect(calls()).toBe(1);
  });

  it("waits the given delays", async () => {
    const waited: number[] = [];
    const { attempt } = attempts(503, 503, 200);
    await withRetries(attempt, [10, 20, 30], async (ms) => void waited.push(ms));
    expect(waited).toEqual([10, 20]);
  });
});
