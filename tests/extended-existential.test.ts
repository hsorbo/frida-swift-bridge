import { test, expect, describe } from "@frida/injest/agent";
import { requireSwift } from "./swift.js";
import { fixtureExport, existentialMetadata, loadFixture } from "./fixtures/load.js";

import {
  Metadata,
  readValue,
  readObject,
  metadataFor,
  typeName,
  GenericRequirementKind,
  existentialProtocols,
  extendedExistentialRequirementSignature,
  extendedExistentialGeneralizationArguments,
} from "../src/abi.js";
import { MetadataKind } from "../src/abi/metadata.js";
import {
  extendedExistentialSpecialKind,
  ExtendedExistentialSpecialKind,
} from "../src/abi/existential.js";
import { makeSwiftNativeFunction } from "../src/runtime/calling-convention.js";

import { Swift } from "../src/index.js";
function ptrValue(p: NativePointer): NativePointer {
  const cell = Memory.alloc(Process.pointerSize);
  cell.writePointer(p);
  return cell;
}

function store(fn: string, metadata: Metadata): NativePointer {
  const RawPointer = metadataFor("Swift.UnsafeMutableRawPointer")!;
  const container = Memory.alloc(metadata.typeLayout.stride);
  makeSwiftNativeFunction(fixtureExport(fn), null, [RawPointer])(ptrValue(container));
  return container;
}

describe("readValue extended existential", () => {
  test("decodes a value type behind a parameterized-protocol existential (opaque)", () => {
    requireSwift();
    const Holder = existentialMetadata("fixture.holderIntType");
    expect(Holder.kind).toBe(MetadataKind.ExtendedExistential);
    expect(extendedExistentialSpecialKind(Holder)).toBe(ExtendedExistentialSpecialKind.None);
    expect(readValue(Holder, store("fixture.storeHolderInt", Holder))).toEqual({ item: int64(42) });
  });

  test("decodes a class reference behind a class-constrained parameterized existential", () => {
    requireSwift();
    const Ref = existentialMetadata("fixture.refIntType");
    expect(Ref.kind).toBe(MetadataKind.ExtendedExistential);
    expect(extendedExistentialSpecialKind(Ref)).toBe(ExtendedExistentialSpecialKind.Class);
    const ref = readValue(Ref, store("fixture.storeRefInt", Ref)) as NativePointer;
    expect(ref.isNull()).toBe(false);
    expect(readObject(ref)).toEqual({ value: int64(7) });
  });

  test("decodes the stored type behind a parameterized-protocol existential metatype (any P.Type)", () => {
    requireSwift();
    const M = existentialMetadata("fixture.holderMetatypeType");
    expect(M.kind).toBe(MetadataKind.ExtendedExistential);
    expect(extendedExistentialSpecialKind(M)).toBe(ExtendedExistentialSpecialKind.Metatype);
    expect(readValue(M, store("fixture.storeHolderMetatype", M))).toBe("fixture.IntHolder");
  });
});

describe("extended existential shape", () => {
  test("names the constrained protocol and its type argument (any Holder<Int>)", () => {
    requireSwift();
    const Holder = existentialMetadata("fixture.holderIntType");
    expect(existentialProtocols(Holder).map((p) => p.fullTypeName)).toEqual(["fixture.Holder"]);
    expect(extendedExistentialGeneralizationArguments(Holder).map((m) => typeName(m))).toEqual(["Swift.Int"]);
  });

  test("names the protocol of a class-constrained and a metatype shape (any Ref<Int>, any Holder<Int>.Type)", () => {
    requireSwift();
    const Ref = existentialMetadata("fixture.refIntType");
    expect(existentialProtocols(Ref).map((p) => p.fullTypeName)).toEqual(["fixture.Ref"]);
    expect(extendedExistentialGeneralizationArguments(Ref).map((m) => typeName(m))).toEqual(["Swift.Int"]);
    const M = existentialMetadata("fixture.holderMetatypeType");
    expect(existentialProtocols(M).map((p) => p.fullTypeName)).toEqual(["fixture.Holder"]);
    expect(extendedExistentialGeneralizationArguments(M).map((m) => typeName(m))).toEqual(["Swift.Int"]);
  });

  test("decodes the requirement signature: the argument's same-type binding, then Self's conformance", () => {
    requireSwift();
    const signature = extendedExistentialRequirementSignature(existentialMetadata("fixture.holderIntType"));
    expect(signature.map((r) => r.kind)).toEqual([GenericRequirementKind.SameType, GenericRequirementKind.Protocol]);
    expect(signature[0].sameTypeName).not.toBeNull();
    expect(signature[1].protocol!.fullTypeName).toBe("fixture.Holder");
  });

  test("separates a generic superclass's arguments and conformances from Self's protocols", (ctx) => {
    requireSwift();
    if (loadFixture().findExportByName("$s7fixture19hashedBoxHolderTypeSVyF") === null) {
      ctx.skip("fixture compiled without class & parameterized-protocol compositions (Swift < 6.2)");
    }
    const M = existentialMetadata("fixture.hashedBoxHolderType");
    expect(existentialProtocols(M).map((p) => p.fullTypeName)).toEqual(["fixture.Holder"]);
    expect(extendedExistentialGeneralizationArguments(M).map((m) => typeName(m))).toEqual(["Swift.Int", "Swift.String"]);
    const kinds = extendedExistentialRequirementSignature(M).map((r) => r.kind);
    expect(kinds).toContain(GenericRequirementKind.BaseClass);
  });

  test("names Self's protocol when there is no generalization signature (any Consumable & ~Copyable)", (ctx) => {
    requireSwift();
    if (loadFixture().findExportByName("$s7fixture25noncopyableConsumableTypeSVyF") === null) {
      ctx.skip("fixture compiled without a ~Copyable composition's metadata (Swift < 6.2)");
    }
    const M = existentialMetadata("fixture.noncopyableConsumableType");
    expect(M.kind).toBe(MetadataKind.ExtendedExistential);
    expect(existentialProtocols(M).map((p) => p.fullTypeName)).toEqual(["fixture.Consumable"]);
    expect(extendedExistentialGeneralizationArguments(M)).toEqual([]);
    expect(extendedExistentialRequirementSignature(M).map((r) => r.kind)).toEqual([
      GenericRequirementKind.Protocol,
      GenericRequirementKind.InvertedProtocols,
    ]);
  });
});
