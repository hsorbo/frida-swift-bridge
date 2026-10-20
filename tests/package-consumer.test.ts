import { test, expect } from "@frida/injest/agent";

import type { Protocol, ProtocolComposition } from "frida-swift-bridge2";
import Swift, {
  SwiftCoreApi,
  SwiftType,
  NominalType,
  StructType,
  EnumType,
  ClassType,
  TupleType,
  SwiftTypeFacade,
  SwiftClass,
  SwiftValueType,
  SwiftStruct,
  SwiftEnum,
  SwiftMember,
  SwiftInstanceMethod,
  SwiftValue,
  SwiftObject,
  SwiftClassObject,
  SwiftValueObject,
  SwiftField,
  SwiftBoundMethod,
  SwiftClosureValue,
  MethodResolveOptions,
  ValueMethodResolveOptions,
  CallArg,
  CallResult,
  ClosureSpec,
  AnyClosureBody,
  NativeFunctionType,
  MarshalledFunctionOptions,
  SwiftError,
  SwiftFunction,
  FacadeCallable,
  HookableTarget,
  SwiftHookArgs,
  SwiftHookTypes,
  SwiftInvocationCallbacks,
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
  CallPlan,
  SwiftBoundInitializer,
  MethodQuery,
  makeSwiftNativeFunction,
  metadataOf,
  descriptorOf,
} from "frida-swift-bridge2/abi";

type _rootTypesAreImportable = [
  SwiftCoreApi, SwiftType, NominalType, StructType, EnumType, ClassType, TupleType,
  SwiftTypeFacade, SwiftClass, SwiftValueType, SwiftStruct, SwiftEnum, SwiftMember, SwiftInstanceMethod,
  Protocol, ProtocolComposition, SwiftValue, SwiftObject, SwiftClassObject,
  SwiftValueObject, SwiftField, SwiftBoundMethod, MethodResolveOptions,
  ValueMethodResolveOptions, CallArg, CallResult, ClosureSpec,
  AnyClosureBody, NativeFunctionType, MarshalledFunctionOptions,
  typeof Swift.Interceptor, SwiftError,
];
type _abiTypesAreImportable = [
  Metadata, TypeLayout, ValueInstance, ClassInstance, ClosureBody,
  GenericRequirementDescriptor, InvertedProtocolsRequirement, SelfRouting,
  CallPlan, SwiftBoundInitializer, MethodQuery,
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

function acquisitionPreservesFacadeKindAtCompileTime(cls: SwiftClass, st: SwiftStruct, en: SwiftEnum) {
  const borrowed: SwiftClassObject = Swift.borrowObject(NULL);
  const adopted: SwiftClassObject = Swift.adoptObject(NULL);
  const constructed: SwiftClassObject = cls.init()!;
  const value: SwiftValueObject = st.$new(0);
  const made: SwiftValueObject | null = en.init()!;
  const kase: SwiftValueObject = en.$case("none");
  const closure: SwiftClosureValue = Swift.borrowClosure(NULL);
  const captures: SwiftField[] = closure.$captures();
  const kept: SwiftClassObject = borrowed.$retained();
  const keptClosure: SwiftClosureValue = closure.$retained();
  // @ts-expect-error a value is copied through its type's $copy, not retained
  value.$retained();
  void [borrowed, adopted, constructed, value, made, kase, captures, kept, keptClosure];
}

// A facade answers any Swift member name, so of its own members only the $-prefixed controls and
// $type are checked: a misspelled reflection member or control is a compile-time error, a
// misspelled Swift member is not.
function reflectionIsStrictAtCompileTime(cls: SwiftClass, st: SwiftStruct, o: SwiftClassObject, v: SwiftValueObject, t: SwiftType) {
  const classInfo: ClassType = cls.$type;
  const structInfo: StructType = st.$type;
  const dynamicInfo: ClassType = o.$type;
  const valueInfo: StructType | EnumType = v.$type;
  const name: string = t.name;
  const selectors: string[] = classInfo.instanceMethods();
  const found: SwiftInstanceMethod = classInfo.instanceMethod("greet");
  const typeMethod: SwiftMember = structInfo.typeMethod("make");
  const initializer: SwiftMember = classInfo.initializer("init(name:)");
  const back: SwiftClass = classInfo.facade;
  const superInfo: SwiftType | null = classInfo.superClass;
  void [dynamicInfo, valueInfo, name, selectors, found, typeMethod, initializer, back, superInfo];
  // @ts-expect-error reflection has no index signature
  classInfo.instanceMehtods();
  // @ts-expect-error reflection has no index signature
  o.$type.noSuchMember;
  // @ts-expect-error a receiver operation is not a reflection member
  classInfo.init()!;
  // @ts-expect-error a receiver operation is not a reflection member
  structInfo.$new(0);
  // @ts-expect-error a reflection member keeps its bare name
  cls.$type.$name;
}

function structuralReflectionHasNoDynamicMembersAtCompileTime(tuple: TupleType, any: SwiftType) {
  const elementType: SwiftType = tuple.elements[0].type;
  void elementType;
  // @ts-expect-error a structural type has no facade
  tuple.facade;
  // @ts-expect-error a structural type answers no Swift member names
  tuple.first;
  // @ts-expect-error a structural type has no Swift members to list
  tuple.instanceMethods();
  // @ts-expect-error the common base has no index signature
  any.anything;
}

function typesAreAcceptedAsReflectionOrFacadeAtCompileTime(cls: SwiftClass, info: ClassType, o: SwiftClassObject) {
  Swift.NativeFunction(NULL, cls, [info]);
  Swift.NativeFunction(NULL, info, [cls, o.$type]);
  o.$method("m", { typeArguments: [cls, info] });
  const metadata: Metadata = metadataOf(cls);
  const descriptor: ContextDescriptor = descriptorOf(info);
  const spelled: SwiftType | null = Swift.reflect("");
  const reflected: SwiftType = Swift.reflect(NULL);
  void [metadata, descriptor, spelled, reflected];
}

function rawMetadataStaysUnderAbi(type: SwiftType) {
  const metadata: Metadata = metadataOf(type);
  const descriptor: ContextDescriptor = descriptorOf(type);
  const layout: TypeLayout = type.layout;
  void [metadata, descriptor, layout];
  // @ts-expect-error raw metadata stays under /abi metadataOf()
  const rawMetadata: Metadata = type.metadata;
  // @ts-expect-error raw descriptor stays under /abi descriptorOf()
  const rawDescriptor: ContextDescriptor = type.descriptor;
  void [rawMetadata, rawDescriptor];
}

function protocolListingsStayNarrowAtCompileTime(t: ClassType) {
  for (const listed of Swift.enumerateProtocols()) {
    const name: string = listed.fullName;
    // @ts-expect-error a listed protocol is the stable view, the descriptor stays under /abi
    listed.descriptor;
    void name;
  }
  const conformed = t.protocols()["MyKit.P"];
  const conformedName: string = conformed.name;
  // @ts-expect-error a conformed protocol is the stable view, requirements stay under /abi
  conformed.requirements;
  // @ts-expect-error a slot binding is not a reflection member
  t.slotCall;
  void conformedName;
}

function protocolRawInspectionStaysUnderAbi(p: Protocol, comp: ProtocolComposition) {
  const conformers: NominalType[] = p.conformingTypes();
  const conforms: boolean = conformers[0].conformsTo(p);
  void [p.name, p.fullName, p.isClassOnly, conformers, conforms];
  // @ts-expect-error raw protocol descriptor stays under /abi
  p.descriptor;
  // @ts-expect-error raw requirements stay under /abi
  p.requirements;
  // @ts-expect-error witness-table lookup stays under /abi
  p.conformanceFor;
  // @ts-expect-error existential metadata stays under /abi
  comp.metadata;
}

function bridgeControlsAreStrictAtCompileTime(o: SwiftClassObject, v: SwiftValueObject, t: SwiftClass, k: string) {
  o.greet("x");
  o["greet"]("x");
  t["=="](o, o);
  v.count;
  o.$dispose();
  t.$type;
  // @ts-expect-error a misspelled control is not a Swift member
  o.$disopse();
  // @ts-expect-error a misspelled control is not a Swift member
  v.$feilds;
  // @ts-expect-error a misspelled control is not a Swift member
  t.$tpye;
  // @ts-expect-error a runtime-string key goes through $get or $call
  o[k];
  interface Generated extends SwiftClassObject { greet(name: string): string }
  const g = o as Generated;
  g.greet("x");
  // @ts-expect-error a generated interface inherits the strict controls
  g.$nope();
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

// The generator's prelude: a facade function and a bound method carrying the types they decode to.
interface $Callable<In extends CallArg[], Out extends CallResult[], Ret extends CallResult | Promise<CallResult>, Named = {}>
  extends FacadeCallable, SwiftHookTypes<Ret, Out, Named> {
  (...args: In): Ret;
}
interface $Bound<In extends CallArg[], Out extends CallResult[], Ret extends CallResult | Promise<CallResult>, Named = {}>
  extends SwiftBoundMethod, SwiftHookTypes<Ret, Out, Named> {
  call(...args: In): Ret;
}
type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type HookCallbacks<T extends HookableTarget> = Parameters<typeof Swift.Interceptor.attach<T>>[1];

function hookCallbacksFollowTheTargetAtCompileTime(
  greet: $Callable<[string], [string], string>,
  move: $Bound<[number | Int64], [Int64], Int64, { to: Int64 }>,
  padded: $Bound<[number | Int64], [Int64], Int64, { length: Int64 }>,
  annotated: SwiftFunction<Promise<Int64>, [number]>,
  shaped: SwiftFunction<[Int64, string], [Int64 | null, number[], SwiftValueObject]>,
) {
  Swift.Interceptor.attach(greet, {
    onEnter(args) {
      const who: string = args[0];
      void who;
    },
    onLeave(retval) {
      // @ts-expect-error null when the call threw
      const said: string = retval;
      const saidOrThrew: string | null = retval;
      void [said, saidOrThrew];
    },
  });
  const greeting: string = greet("x");
  const callable: FacadeCallable = greet;
  void [greeting, callable];

  Swift.Interceptor.attach(move, {
    onEnter(args) {
      const by: Int64 = args[0];
      const to: Int64 = args.to;
      void [by, to];
      // @ts-expect-error a label the member does not have
      args.too;
    },
  });
  Swift.Interceptor.attach(padded, {
    onEnter(args) {
      args.length.toFixed(); // a label an Array owns is the Array's, not the member's
    },
  });

  // The annotation types what a call accepts; a hook decodes the argument (an Int64 here) untyped.
  Swift.Interceptor.attachAsync(annotated, {
    onEnter(args) {
      // @ts-expect-error a call accepts a number, a hook observes the decoded value
      const by: number = args[0];
      const observed: CallResult = args[0];
      void [by, observed];
    },
    onComplete(retval) {
      // @ts-expect-error null when the call threw
      const sum: Int64 = retval;
      const sumOrThrew: Int64 | null = retval;
      void [sum, sumOrThrew];
    },
  });
  Swift.Interceptor.attach(shaped, {
    onEnter(args) {
      const untyped: Same<typeof args, SwiftHookArgs> = true;
      void untyped;
    },
    onLeave(retval) {
      const ret: [Int64, string] | null = retval;
      void ret;
    },
  });
  // @ts-expect-error an async target completes after its entry returns; hook it with attachAsync
  Swift.Interceptor.attach(annotated, {
    onLeave() {},
  });

  // Everything else, a member read off a facade (any) and a HookableTarget parameter included, keeps today's types.
  const untypedTargetsKeepTodaysCallbacks: Same<
    | HookCallbacks<NativePointer>
    | HookCallbacks<SwiftMember>
    | HookCallbacks<SwiftBoundMethod>
    | HookCallbacks<FacadeCallable>
    | HookCallbacks<SwiftFunction>
    | HookCallbacks<HookableTarget>
    | HookCallbacks<SwiftClassObject["greet"]>,
    SwiftInvocationCallbacks
  > = true;
  void untypedTargetsKeepTodaysCallbacks;
  // @ts-expect-error not a hook target
  Swift.Interceptor.attach(42, {});
}

void facadeKindContractsHoldAtCompileTime;
void hookCallbacksFollowTheTargetAtCompileTime;
void acquisitionPreservesFacadeKindAtCompileTime;
void reflectionIsStrictAtCompileTime;
void structuralReflectionHasNoDynamicMembersAtCompileTime;
void typesAreAcceptedAsReflectionOrFacadeAtCompileTime;
void rawMetadataStaysUnderAbi;
void protocolRawInspectionStaysUnderAbi;
void rawOpsStayOffTheFacadeAtCompileTime;
void protocolListingsStayNarrowAtCompileTime;
void bridgeControlsAreStrictAtCompileTime;
void makeSwiftNativeFunction;

test("published entry points resolve as runtime values", () => {
  expect(typeof Swift.borrowObject).toBe("function");
  expect(typeof Swift.adoptObject).toBe("function");
  expect(typeof Swift.borrowClosure).toBe("function");
  expect(typeof Swift.NativeFunction).toBe("function");
  expect(typeof Swift.reflect).toBe("function");
  expect(typeof Swift.closure).toBe("function");
  expect(typeof Swift.demangle).toBe("function");
  expect(typeof Swift.Interceptor.attach).toBe("function");
  expect(typeof ValueInstance).toBe("function");
  expect(typeof makeSwiftNativeFunction).toBe("function");
  expect(typeof metadataOf).toBe("function");
  expect(typeof descriptorOf).toBe("function");
});
