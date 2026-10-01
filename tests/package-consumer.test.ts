import { test, expect } from "@frida/injest/agent";

import type { Protocol, ProtocolComposition } from "frida-swift-bridge2";
import Swift, {
  SwiftCoreApi,
  SwiftType,
  ValueType,
  StructType,
  EnumType,
  ClassType,
  SwiftValue,
  SwiftObject,
  SwiftClassObject,
  SwiftValueObject,
  SwiftField,
  SwiftBoundMethod,
  MethodResolveOptions,
  ValueMethodResolveOptions,
  CallArg,
  CallResult,
  ClosureSpec,
  AnyClosureBody,
  NativeFunctionType,
  MarshalledFunctionOptions,
  SwiftError,
} from "frida-swift-bridge2";
import {
  Metadata,
  ContextDescriptor,
  TypeLayout,
  ValueInstance,
  ClassInstance,
  ClosureBody,
  GenericRequirementDescriptor,
  InvertedProtocolsRequirement,
  SelfRouting,
  GenericMethodPlan,
  SwiftBoundInitializer,
  MethodQuery,
  makeSwiftNativeFunction,
  metadataOf,
  descriptorOf,
} from "frida-swift-bridge2/abi";

type _rootTypesAreImportable = [
  SwiftCoreApi, SwiftType, ValueType, StructType, EnumType, ClassType,
  Protocol, ProtocolComposition, SwiftValue, SwiftObject, SwiftClassObject,
  SwiftValueObject, SwiftField, SwiftBoundMethod, MethodResolveOptions,
  ValueMethodResolveOptions, CallArg, CallResult, ClosureSpec,
  AnyClosureBody, NativeFunctionType, MarshalledFunctionOptions,
  typeof Swift.Interceptor, SwiftError,
];
type _abiTypesAreImportable = [
  Metadata, TypeLayout, ValueInstance, ClassInstance, ClosureBody,
  GenericRequirementDescriptor, InvertedProtocolsRequirement, SelfRouting,
  GenericMethodPlan, SwiftBoundInitializer, MethodQuery,
];

function facadeKindContractsHoldAtCompileTime(
  cls: SwiftClassObject,
  val: SwiftValueObject,
  either: SwiftObject,
  field: SwiftField,
  type: SwiftType,
) {
  cls.$method("m");
  val.$method("m", { self: "mutating" });
  // @ts-expect-error self is value-only
  cls.$method("m", { self: "mutating" });

  if (either.$kind === "value") {
    either.$container();
  } else {
    either.$method("m");
  }
  // @ts-expect-error $container is value-only
  cls.$container();

  const read: SwiftValue = field.read();
  field.write(read);
  const handle: NativePointer = field.handle;
  const fieldType: SwiftType = field.type;
  const asArg: CallArg = field; // a $field view passes as a call argument without a cast
  void [handle, fieldType, asArg];
  // @ts-expect-error borrowed view hides ValueInstance.metadata
  field.metadata;
  // @ts-expect-error borrowed view hides ValueInstance.copyInto
  field.copyInto;

  Swift.NativeFunction(field.handle, type, [type], { throws: true });
  // @ts-expect-error raw hasSelf stays under /abi
  Swift.NativeFunction(field.handle, type, [type], { hasSelf: true });
}

function acquisitionPreservesFacadeKindAtCompileTime(cls: ClassType, st: StructType) {
  const borrowed: SwiftClassObject = Swift.borrowObject(NULL);
  const adopted: SwiftClassObject = Swift.adoptObject(NULL);
  const constructed: SwiftClassObject = cls.init();
  const value: SwiftValueObject = st.$fromJS(0);
  void [borrowed, adopted, constructed, value];
}

function rawMetadataStaysUnderAbi(type: SwiftType) {
  const metadata: Metadata = metadataOf(type);
  const descriptor: ContextDescriptor = descriptorOf(type);
  void [metadata, descriptor];
  // @ts-expect-error raw metadata stays under /abi metadataOf()
  const rawMetadata: Metadata = type.metadata;
  // @ts-expect-error raw descriptor stays under /abi descriptorOf()
  const rawDescriptor: ContextDescriptor = type.descriptor;
  void [rawMetadata, rawDescriptor];
}

function protocolRawInspectionStaysUnderAbi(p: Protocol, comp: ProtocolComposition) {
  const conformers: SwiftType[] = p.conformingTypes();
  void [p.name, p.fullName, p.isClassOnly, conformers];
  // @ts-expect-error raw protocol descriptor stays under /abi
  p.descriptor;
  // @ts-expect-error raw requirements stay under /abi
  p.requirements;
  // @ts-expect-error witness-table lookup stays under /abi
  p.conformanceFor;
  // @ts-expect-error existential metadata stays under /abi
  comp.metadata;
}

function rawOpsStayOffTheFacadeAtCompileTime(o: SwiftObject) {
  // @ts-expect-error $retain is an /abi-only ClassInstance op
  o.$retain();
  // @ts-expect-error $release is an /abi-only ClassInstance op
  o.$release();
  // @ts-expect-error $retainCount is an /abi-only ClassInstance op
  o.$retainCount();
  // @ts-expect-error $isUniquelyReferenced is an /abi-only ClassInstance op
  o.$isUniquelyReferenced();
  // @ts-expect-error $vtable is an /abi-only ClassInstance op
  o.$vtable();
  // @ts-expect-error $vtableMethod is an /abi-only ClassInstance op
  o.$vtableMethod();
}

void facadeKindContractsHoldAtCompileTime;
void acquisitionPreservesFacadeKindAtCompileTime;
void rawMetadataStaysUnderAbi;
void protocolRawInspectionStaysUnderAbi;
void rawOpsStayOffTheFacadeAtCompileTime;
void makeSwiftNativeFunction;

test("published entry points resolve as runtime values", () => {
  expect(typeof Swift.borrowObject).toBe("function");
  expect(typeof Swift.adoptObject).toBe("function");
  expect(typeof Swift.NativeFunction).toBe("function");
  expect(typeof Swift.closure).toBe("function");
  expect(typeof Swift.demangle).toBe("function");
  expect(typeof Swift.Interceptor.attach).toBe("function");
  expect(typeof ValueInstance).toBe("function");
  expect(typeof makeSwiftNativeFunction).toBe("function");
  expect(typeof metadataOf).toBe("function");
  expect(typeof descriptorOf).toBe("function");
});
