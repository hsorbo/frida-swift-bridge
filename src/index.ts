import { getSwiftCoreApi, SwiftCoreApi } from "./runtime/api.js";
import { SWIFT_HOST_SUPPORTED, LIBSWIFT_CORE_NAME } from "./runtime/platform.js";
import { demangle } from "./runtime/demangle.js";
import {
  swiftImages,
  swiftTypes,
  swiftClasses,
  swiftStructs,
  swiftEnums,
} from "./reflection/registry.js";
import type { NameFilter } from "./runtime/swift-resolver.js";
import { symbolicate } from "./runtime/symbolication.js";
import { SwiftInterceptor } from "./runtime/interceptor.js";
import {
  NominalType,
  ClassType,
  StructType,
  EnumType,
  typeFromDescriptor,
  nominalTypeNamed,
  swiftFunction,
} from "./runtime/swift-type.js";
import { SwiftTypeFacade, SwiftClass, SwiftStruct, SwiftEnum } from "./runtime/type-facade.js";
import { asSwiftObject, SwiftClassObject } from "./runtime/object-facade.js";
import { ClassInstance } from "./abi/heap-object.js";
import {
  Protocol as ProtocolClass,
  ProtocolComposition as ProtocolCompositionClass,
  swiftProtocols,
} from "./runtime/protocol.js";
import type { StableProtocol, StableProtocolComposition } from "./runtime/protocol.js";
import { markResilientModule, markFrozenType } from "./runtime/calling-convention.js";
import { resolveSwiftAsyncFunction, resolveSwiftFunction } from "./runtime/qualified-function.js";
import { closure } from "./runtime/closure.js";
import { choose, ChooseOptions } from "./runtime/choose.js";
import { moduleRegistry, ModuleRegistry } from "./runtime/module-namespace.js";
import { ContextDescriptor } from "./abi/context-descriptor.js";

function* facadesOf<T extends NominalType>(descriptors: Generator<ContextDescriptor>): Generator<T["facade"]> {
  for (const descriptor of descriptors) {
    if (descriptor.fullTypeName !== null) {
      yield (typeFromDescriptor(descriptor) as T).facade;
    }
  }
}

function typeOfKind<T extends NominalType>(
  name: string,
  ctor: new (descriptor: ContextDescriptor) => T,
  kind: string
): T["facade"] | null {
  const type = nominalTypeNamed(name);
  if (type === null) {
    return null;
  }
  if (!(type instanceof ctor)) {
    throw new Error(`'${name}' is ${type.kind}, not ${kind}`);
  }
  return type.facade as T["facade"];
}

// The stable root; version-sensitive ABI and reversing machinery lives behind the `/abi` subpath.
export { SwiftCoreApi } from "./runtime/api.js";
export { isSwiftSymbol, demangle } from "./runtime/demangle.js";
export type {
  StableProtocol as Protocol,
  StableProtocolComposition as ProtocolComposition,
} from "./runtime/protocol.js";
export {
  SwiftType,
  TypeKind,
  NominalType,
  StructType,
  EnumType,
  ClassType,
  TupleType,
  MetatypeType,
  FunctionType,
  ObjCClassWrapperType,
  ForeignClassType,
  ForeignReferenceType,
  TypeMember,
  MethodQuery,
  MemberLookupOptions,
  SwiftMember,
  SwiftInstanceMethod,
  NativeFunctionType,
  MarshalledFunctionOptions,
  TupleTypeElement,
  ParameterConvention,
  FunctionTypeParameter,
  FunctionTypeSignature,
} from "./runtime/swift-type.js";
export {
  SwiftTypeFacade,
  SwiftClass,
  SwiftValueType,
  SwiftStruct,
  SwiftEnum,
  SwiftClassBoundInitializer,
} from "./runtime/type-facade.js";
export { SwiftValue } from "./abi/instance.js";
export { SwiftError } from "./runtime/thrown-error.js";
export {
  ClosureSpec,
  AnyClosureBody,
} from "./runtime/closure.js";
export { SwiftSymbol } from "./runtime/symbolication.js";
export type { ChooseOptions } from "./runtime/choose.js";
export {
  SwiftInterceptorApi,
  SwiftInvocationCallbacks,
  SwiftAsyncCallbacks,
  SwiftInvocationContext,
  SwiftInterceptorOptions,
  HookableTarget,
} from "./runtime/interceptor.js";
export { isSwiftObject } from "./runtime/method.js";
export type { SwiftMemberFunction, SwiftAsyncMemberFunction } from "./runtime/qualified-function.js";
export type { ModuleRegistry, ModuleNamespace, ModuleMember } from "./runtime/module-namespace.js";
export type {
  SwiftBoundMethod,
  SwiftMemberSignature,
  SwiftBoundSignature,
  MemberOrigin,
  SwiftBoundInitializer,
  SwiftFunction,
  SwiftAsyncFunction,
  AsyncReceiver,
  CallResult,
  CallArg,
  MethodInfo,
  MethodKind,
  MethodResolveOptions,
  ValueMethodResolveOptions,
  SelfOwnership,
  AccessorKind,
  PropertyInfo,
} from "./runtime/method.js";
export {
  SwiftObject,
  SwiftClassObject,
  SwiftValueObject,
  SwiftField,
  SwiftClassBoundMethod,
  SwiftValueBoundMethod,
} from "./runtime/object-facade.js";

export const Swift = {
  get available(): boolean {
    return SWIFT_HOST_SUPPORTED && Process.findModuleByName(LIBSWIFT_CORE_NAME) !== null;
  },

  get api(): SwiftCoreApi {
    return getSwiftCoreApi();
  },

  demangle,
  images: swiftImages,
  enumerateProtocols: swiftProtocols,

  get modules(): ModuleRegistry {
    return moduleRegistry();
  },

  type(name: string): SwiftTypeFacade | null {
    return nominalTypeNamed(name)?.facade ?? null;
  },

  enumerateTypes(filter?: NameFilter): Generator<SwiftTypeFacade> {
    return facadesOf<NominalType>(swiftTypes(filter));
  },

  class(name: string): SwiftClass | null {
    return typeOfKind(name, ClassType, "class");
  },

  enumerateClasses(filter?: NameFilter): Generator<SwiftClass> {
    return facadesOf<ClassType>(swiftClasses(filter));
  },

  struct(name: string): SwiftStruct | null {
    return typeOfKind(name, StructType, "struct");
  },

  enumerateStructs(filter?: NameFilter): Generator<SwiftStruct> {
    return facadesOf<StructType>(swiftStructs(filter));
  },

  enum(name: string): SwiftEnum | null {
    return typeOfKind(name, EnumType, "enum");
  },

  enumerateEnums(filter?: NameFilter): Generator<SwiftEnum> {
    return facadesOf<EnumType>(swiftEnums(filter));
  },

  closure,
  markResilient: markResilientModule,
  markFrozen: markFrozenType,
  symbolicate,
  Interceptor: SwiftInterceptor,

  borrowObject(handle: NativePointer): SwiftClassObject {
    return asSwiftObject(handle);
  },

  adoptObject(handle: NativePointer): SwiftClassObject {
    return asSwiftObject(ClassInstance.adopt(handle));
  },

  choose(cls: SwiftClass, options?: ChooseOptions): SwiftClassObject[] {
    return choose(cls, options);
  },

  NativeFunction: swiftFunction,
  function: resolveSwiftFunction,
  asyncFunction: resolveSwiftAsyncFunction,
  Protocol: {
    find: (name: string): StableProtocol | null => ProtocolClass.find(name),
  },
  ProtocolComposition: {
    fromSignature: (signature: string): StableProtocolComposition =>
      ProtocolCompositionClass.fromSignature(signature),
  },
};

export default Swift;
