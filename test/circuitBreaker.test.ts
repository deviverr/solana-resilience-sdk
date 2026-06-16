import { describe, it, expect } from "vitest";
import { CircuitBreaker } from "../src/core/circuitBreaker.js";
import { manualClock } from "./mocks/networkSimulator.js";

describe("CircuitBreaker", () => {
  it("opens after the failure threshold and blocks requests", () => {
    const cb = new CircuitBreaker({ failureThreshold: 3 });
    expect(cb.canRequest()).toBe(true);
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.getState()).toBe("closed");
    cb.recordFailure();
    expect(cb.getState()).toBe("open");
    expect(cb.canRequest()).toBe(false);
  });

  it("transitions open → half-open after the open duration", () => {
    const clock = manualClock();
    const cb = new CircuitBreaker({
      failureThreshold: 1,
      openDurationMs: 1_000,
      clock: clock.now,
    });
    cb.recordFailure();
    expect(cb.getState()).toBe("open");
    clock.advance(999);
    expect(cb.getState()).toBe("open");
    clock.advance(1);
    expect(cb.getState()).toBe("half-open");
    expect(cb.canRequest()).toBe(true);
  });

  it("closes from half-open after enough successes", () => {
    const clock = manualClock();
    const cb = new CircuitBreaker({
      failureThreshold: 1,
      successThreshold: 2,
      openDurationMs: 10,
      clock: clock.now,
    });
    cb.recordFailure();
    clock.advance(10);
    expect(cb.getState()).toBe("half-open");
    cb.recordSuccess();
    expect(cb.getState()).toBe("half-open");
    cb.recordSuccess();
    expect(cb.getState()).toBe("closed");
  });

  it("re-opens immediately on a failure while half-open", () => {
    const clock = manualClock();
    const cb = new CircuitBreaker({
      failureThreshold: 1,
      openDurationMs: 10,
      clock: clock.now,
    });
    cb.recordFailure();
    clock.advance(10);
    expect(cb.getState()).toBe("half-open");
    cb.recordFailure();
    expect(cb.getState()).toBe("open");
  });

  it("resets consecutive failures on success while closed", () => {
    const cb = new CircuitBreaker({ failureThreshold: 3 });
    cb.recordFailure();
    cb.recordFailure();
    cb.recordSuccess();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.getState()).toBe("closed"); // counter was reset
  });

  it("can be force-closed", () => {
    const cb = new CircuitBreaker({ failureThreshold: 1 });
    cb.recordFailure();
    expect(cb.getState()).toBe("open");
    cb.close();
    expect(cb.getState()).toBe("closed");
  });
});
