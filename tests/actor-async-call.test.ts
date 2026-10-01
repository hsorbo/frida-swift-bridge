import { test, expect, describe, beforeEach } from "@frida/injest/agent";
import { loadFixture } from "./fixtures/load.js";

import { ClassType, SwiftError, metadataFor, typeOf } from "../src/abi.js";

declare function gc(): void;

function ticker() {
  return (typeOf(metadataFor("fixture.Ticker")!) as ClassType).init();
}

describe("actor-isolated async calling", () => {
  beforeEach(() => {
    loadFixture();
  });

  test("drives an actor-isolated async method: advance() ⇒ 1", async () => {
    expect(await ticker().advance()).toEqual(int64(1));
  });

  test("an unreferenced receiver survives GC while the call is in flight", async () => {
    const pending = ticker().advance();
    if (typeof gc === "function") {
      gc();
      gc();
    }
    expect(await pending).toEqual(int64(1));
  });

  test("actor state persists across calls: advance() twice ⇒ 1, 2", async () => {
    const t = ticker();
    expect(await t.advance()).toEqual(int64(1));
    expect(await t.advance()).toEqual(int64(2));
  });

  test("passes a gp argument: advance(by: 5) ⇒ 5", async () => {
    expect(await ticker().advance(5)).toEqual(int64(5));
  });

  test("passes and returns a Double: scaledCountAsync(1.5) after two ticks ⇒ 3.0", async () => {
    const t = ticker();
    await t.advance();
    await t.advance();
    expect(await t.scaledCountAsync(1.5)).toBe(3);
  });

  test("returns a non-POD String: labelAsync() after one tick ⇒ \"tick-1\"", async () => {
    const t = ticker();
    await t.advance();
    expect(await t.labelAsync()).toBe("tick-1");
  });

  test("resolves an async throwing actor method that does not throw: advanceOrThrowAsync(3) ⇒ 3", async () => {
    expect(await ticker().advanceOrThrowAsync(3)).toEqual(int64(3));
  });

  test("rejects with SwiftError when the actor method throws", async () => {
    await expect(ticker().advanceOrThrowAsync(0)).rejects.toThrow(SwiftError);
  });

  test("serializes concurrent calls on the actor: 20 × advance() ⇒ {1..20}", async () => {
    const t = ticker();
    const results = await Promise.all(Array.from({ length: 20 }, () => t.advance()));
    expect(new Set(results)).toEqual(new Set(Array.from({ length: 20 }, (_, i) => int64(i + 1))));
    expect(await t.$get("count")).toEqual(int64(20));
  });
});

function customTicker() {
  return (typeOf(metadataFor("fixture.CustomExecutorTicker")!) as ClassType).init();
}

describe("custom-executor actor async calling", () => {
  beforeEach(() => {
    loadFixture();
  });

  test("a custom-executor actor is an actor but not a default actor", () => {
    const t = typeOf(metadataFor("fixture.CustomExecutorTicker")!) as ClassType;
    expect(t.$isActor).toBe(true);
    expect(t.$isDefaultActor).toBe(false);
  });

  test("drives a custom-executor actor's async method: advance() ⇒ 1, 2", async () => {
    const t = customTicker();
    expect(await t.advance()).toEqual(int64(1));
    expect(await t.advance()).toEqual(int64(2));
  });

  test("serializes concurrent calls on a custom executor: 20 × advance() ⇒ {1..20}", async () => {
    const t = customTicker();
    const results = await Promise.all(Array.from({ length: 20 }, () => t.advance()));
    expect(new Set(results)).toEqual(new Set(Array.from({ length: 20 }, (_, i) => int64(i + 1))));
    expect(await t.$get("count")).toEqual(int64(20));
  });
});
