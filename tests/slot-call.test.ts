import { test, expect, describe, beforeEach } from "@frida/injest/agent";
import { loadFixture } from "./fixtures/load.js";

import {
  AsyncFunctionPointer,
  ClassInstance,
  MethodDescriptorKind,
  Protocol,
  ProtocolRequirementKind,
  bindWitnessMethodAt,
  descriptorOf,
  metadataFor,
  metadataOf,
  readVTable,
} from "../src/abi.js";

import { Swift, SwiftClass, SwiftStruct, SwiftError, type CallResult } from "../src/index.js";

function host(): SwiftClass {
  return Swift.class("fixture.SlotHost")!;
}

// The host's method slots in declaration order: plain, checked, later, then the class method.
function slots(): { plain: string; checked: string; later: string; tagged: string } {
  const entries = readVTable(descriptorOf(host().$type)).filter((e) => e.kind === MethodDescriptorKind.Method);
  const selector = (e: { metadataOffset: number }): string => `vtable#${e.metadataOffset}`;
  const [plain, checked, later] = entries.filter((e) => e.isInstance).map(selector);
  const [tagged] = entries.filter((e) => !e.isInstance).map(selector);
  return { plain, checked, later, tagged };
}

function offsetOf(selector: string): number {
  return Number(selector.split("#")[1]);
}

function methodSlot(protocolName: string): string {
  const requirement = Protocol.find(protocolName)!.requirements.find((r) => r.kind === ProtocolRequirementKind.Method)!;
  return `${protocolName}#${requirement.witnessIndex}`;
}

const INT_TO_INT = "(x: Swift.Int) -> Swift.Int";

describe("calling a vtable slot with a supplied signature", () => {
  beforeEach(() => { loadFixture(); });

  test("the hidden slots list without a signature, instance and class apart", () => {
    const { plain, checked, later, tagged } = slots();
    expect(host().$type.instanceMethods()).toEqual([plain, checked, later]);
    expect(host().$type.typeMethods()).toEqual([tagged]);
    expect(host().$type.instanceMethod(plain).signature).toBeNull();
  });

  test("a slot is called through $method as the /abi route calls it", () => {
    const obj = host().init(10)!;
    const bound = obj.$method(slots().plain, INT_TO_INT);
    expect(bound.call(5)).toEqual(int64(15));
    const Int = metadataFor("Swift.Int")!;
    const viaAbi = new ClassInstance(obj.$handle).vtableMethod(offsetOf(slots().plain), { returnType: Int, argTypes: [Int] });
    expect(viaAbi.call(5)).toEqual(int64(15));
    expect(bound.address.equals(viaAbi.address)).toBe(true);
    expect(bound.signature.argTypes.map((t) => t!.name)).toEqual(["Swift.Int"]);
    expect(bound.origin).toEqual(host().$type.instanceMethod(slots().plain).origin);
  });

  test("a nameless signature keeps the slot's selector; a leading name becomes the selector", () => {
    const { plain } = slots();
    const nameless = host().$type.instanceMethod(plain, INT_TO_INT);
    expect(nameless.selector).toBe(plain);
    expect(nameless.signature).toEqual({
      labels: ["x"],
      argTypeNames: ["Swift.Int"],
      returnTypeName: "Swift.Int",
      throws: false,
      thrownTypeName: null,
      isAsync: false,
      genericParams: [],
    });
    const named = host().$type.instanceMethod(plain, "plain(_: Swift.Int) -> Swift.Int");
    expect(named.selector).toBe("plain(_:)");
    expect(named.signature!.labels).toEqual([null]);
    expect(named.address.equals(nameless.address)).toBe(true);
    expect(named.bind(host().init(1)!).call(2)).toEqual(int64(3));
  });

  test("a subclass finds the inherited slot with its own override, through bind and $method", () => {
    const { plain } = slots();
    const sub = Swift.class("fixture.SlotSubHost")!.init(10)!;
    expect(sub.$method(plain, INT_TO_INT).call(4)).toEqual(int64(6));
    expect(host().$type.instanceMethod(plain, INT_TO_INT).bind(sub).call(4)).toEqual(int64(6));
    expect(host().init(10)!.$method(plain, INT_TO_INT).call(4)).toEqual(int64(14));
  });

  test("a throwing slot raises SwiftError", () => {
    const bound = host().init(10)!.$method(slots().checked, "(x: Swift.Int) throws -> Swift.Int");
    expect(bound.signature.throws).toBe(true);
    expect(bound.call(5)).toEqual(int64(15));
    expect(() => bound.call(-1)).toThrow(SwiftError);
  });

  test("an async slot binds through its async function pointer and returns a Promise", async () => {
    const { later } = slots();
    const word = metadataOf(host().$type).handle.add(offsetOf(later) * Process.pointerSize).readPointer();
    expect(host().$type.instanceMethod(later).address.equals(new AsyncFunctionPointer(word).code)).toBe(true);
    const bound = host().init(10)!.$method(later, "(x: Swift.Int) async -> Swift.Int");
    expect(bound.signature.isAsync).toBe(true);
    expect(await bound.call(5)).toEqual(int64(50));
  });

  test("a class-method slot takes the metatype through the type facade", () => {
    const { tagged, plain } = slots();
    expect(host().$typeMethod(tagged, INT_TO_INT).call(1)).toEqual(int64(1001));
    const member = host().$type.typeMethod(tagged, INT_TO_INT);
    expect(member.selector).toBe(tagged);
    expect(member.signature!.argTypeNames).toEqual(["Swift.Int"]);
    expect(host().$type.typeMethod(tagged).signature).toBeNull();
    expect(() => host().$type.instanceMethod(tagged, INT_TO_INT)).toThrow(/no instance method/);
    expect(() => host().$typeMethod(plain, INT_TO_INT)).toThrow(/no type method/);
  });

  test("a missing or contradicting signature is refused", () => {
    const { plain, later } = slots();
    const obj = host().init(10)!;
    expect(() => host().$type.instanceMethod(plain).bind(obj)).toThrow(/no symbol/);
    expect(() => obj.$method(plain)).toThrow(/no method/);
    expect(() => obj.$method(plain, "(x: Swift.Int)")).toThrow(/cannot parse a signature/);
    expect(() => obj.$method(plain, "(x: Swift.Int) async -> Swift.Int")).toThrow(/is not async/);
    expect(() => obj.$method(later, INT_TO_INT)).toThrow(/is async/);
    expect(() => obj.$method("vtable#1", INT_TO_INT)).toThrow(/no instance method vtable#1/);
    expect(() => Swift.class("fixture.Dispatcher")!.init()!.$method("pub", "(_: Swift.Int) -> Swift.Int")).toThrow(/not a vtable#/);
  });

  test("a typed hook on a slot sees typed args and the result", () => {
    const { plain } = slots();
    const member = host().$type.instanceMethod(plain, INT_TO_INT);
    let seen: CallResult[] = [];
    let left: CallResult = null;
    const listener = Swift.Interceptor.attach(member, {
      onEnter(args) {
        seen = args;
      },
      onLeave(ret) {
        left = ret;
      },
    });
    try {
      expect(host().init(10)!.$method(plain, INT_TO_INT).call(5)).toEqual(int64(15));
    } finally {
      listener.detach();
    }
    expect(seen).toEqual([int64(5)]);
    expect(left).toEqual(int64(15));
    const viaBound = Swift.Interceptor.attach(host().init(1)!.$method(plain, INT_TO_INT), { onEnter() {} });
    viaBound.detach();
  });
});

describe("calling a witness slot with a supplied signature", () => {
  beforeEach(() => { loadFixture(); });

  test("a struct's witness slot runs through the thunk as bindWitnessMethodAt does", () => {
    const selector = methodSlot("fixture.Scalable");
    const scalar = (Swift.type("fixture.NarrowScalar") as SwiftStruct).$new({ n: 3 });
    const bound = scalar.$method(selector, "(by: Swift.Int) -> Swift.Int");
    expect(bound.call(4)).toEqual(int64(12));
    const Int = metadataFor("Swift.Int")!;
    const table = Protocol.find("fixture.Scalable")!.conformanceFor(metadataFor("fixture.NarrowScalar")!)!;
    const viaAbi = bindWitnessMethodAt(table, offsetOf(selector), scalar.$handle, { argTypes: [Int], returnType: Int });
    expect(viaAbi.call(4)).toEqual(int64(12));
    expect(bound.address.equals(viaAbi.address)).toBe(true);
    expect(bound.signature.labels).toEqual(["by"]);
  });

  test("a class's witness slot takes the object as the protocol's Self convention has it", () => {
    const selector = methodSlot("fixture.Vocal");
    const speaker = Swift.class("fixture.BaseSpeaker")!.init()!;
    expect(speaker.$method(selector, "() -> Swift.String").call()).toBe("base");
    const member = Swift.class("fixture.BaseSpeaker")!.$type.instanceMethod(selector, "speak() -> Swift.String");
    expect(member.selector).toBe("speak()");
    expect(member.bind(speaker).call()).toBe("base");
  });

  test("a witness slot is refused as a typed hook target, like a named requirement", () => {
    const speaker = Swift.class("fixture.BaseSpeaker")!.init()!;
    const bound = speaker.$method(methodSlot("fixture.Vocal"), "() -> Swift.String");
    expect(() => Swift.Interceptor.attach(bound, { onEnter() {} })).toThrow(/protocol witness/);
    const member = Swift.class("fixture.BaseSpeaker")!.$type.instanceMethod(methodSlot("fixture.Vocal"), "() -> Swift.String");
    expect(() => Swift.Interceptor.attach(member, { onEnter() {} })).toThrow(/protocol witness/);
  });

  test("a void requirement is spelled -> ()", () => {
    const car = (Swift.type("fixture.Car") as SwiftStruct).$new({ speed: 1, wheels: 4 });
    expect(car.$method(methodSlot("fixture.Vehicle"), "() -> ()").call()).toBeNull();
  });
});
