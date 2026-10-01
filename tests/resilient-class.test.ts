import { test, expect, describe, beforeEach } from "@frida/injest/agent";
import { loadFixture } from "./fixtures/load.js";

import { ClassType, ClassInstance, ClassMetadata, Metadata, MethodDescriptorKind, readVTableChain, metadataFor, typeOf, metadataOf, SwiftClass } from "../src/abi.js";
// resilient.dylib is stripped, so ResilientBase.greeting has only a dispatch-thunk symbol;
// resolveMethod's symbol route can't find it, unlike the vtable route used below.
function concreteSubType(): SwiftClass {
  return (typeOf(metadataFor("fixture.ConcreteSub")!) as ClassType).facade;
}

function resilientBaseType(): SwiftClass {
  return (typeOf(metadataFor("resilient.ResilientBase")!) as ClassType).facade;
}

function String_(): Metadata {
  return metadataFor("Swift.String")!;
}

describe("resilient superclass (cross-module fixture)", () => {
  beforeEach(() => { loadFixture(); });

  test("reads both the inherited and the subclass's own stored property", () => {
    const obj = concreteSubType().init(3, 4);
    expect(obj.$field("tag").read()).toEqual(int64(3));
    expect(obj.$field("extra").read()).toEqual(int64(4));
  });

  test("a base slot reaches the most-derived override", () => {
    const entries = readVTableChain(new ClassMetadata(metadataOf(concreteSubType()).handle)).filter(
      (e) => e.kind === MethodDescriptorKind.Method && e.isInstance
    );
    expect(entries.length).toBe(1); // ResilientBase.greeting, inherited positionally
    const slot = entries[0].metadataOffset;

    const sub = concreteSubType().init(1, 2);
    expect(new ClassInstance(sub.$handle).vtableMethod(slot, { returnType: String_(), argTypes: [] }).call()).toBe("sub");

    const base = resilientBaseType().init(1);
    expect(new ClassInstance(base.$handle).vtableMethod(slot, { returnType: String_(), argTypes: [] }).call()).toBe("base");
  });

  test("the live impl differs from the descriptor's declared impl", () => {
    const entries = readVTableChain(new ClassMetadata(metadataOf(concreteSubType()).handle)).filter(
      (e) => e.kind === MethodDescriptorKind.Method && e.isInstance
    );
    const { declaredImpl, metadataOffset } = entries[0];

    const sub = concreteSubType().init(1, 2);
    const live = new ClassInstance(sub.$handle).vtableMethod(metadataOffset, { returnType: String_(), argTypes: [] }).address;
    expect(live.equals(declaredImpl)).toBe(false);
  });
});
