import { getSwiftCoreApi, SwiftCoreApi } from "./runtime/api.js";
import { SWIFT_HOST_SUPPORTED, LIBSWIFT_CORE_NAME } from "./runtime/platform.js";
import { demangle } from "./runtime/demangle.js";
import {
  findType,
  swiftImages,
  swiftTypes,
  swiftClasses,
  swiftStructs,
  swiftEnums,
} from "./reflection/registry.js";
import { symbolicate } from "./runtime/symbolication.js";
import { SwiftInterceptor } from "./runtime/interceptor.js";
import {
  SwiftType,
  ClassType,
  StructType,
  EnumType,
  typeFromDescriptor,
  swiftFunction,
} from "./runtime/swift-type.js";
import { asSwiftObject, SwiftClassObject } from "./runtime/object-facade.js";
import { ClassInstance } from "./abi/heap-object.js";
import {
  Protocol as ProtocolClass,
  ProtocolComposition as ProtocolCompositionClass,
  swiftProtocols,
} from "./runtime/protocol.js";
import type { StableProtocol, StableProtocolComposition } from "./runtime/protocol.js";
import { markResilientModule } from "./runtime/calling-convention.js";
import { resolveAsyncFunction, resolveFunction } from "./runtime/method.js";
import { closure } from "./runtime/closure.js";
import { moduleRegistry, ModuleRegistry } from "./runtime/module-namespace.js";
import { ContextDescriptor } from "./abi/context-descriptor.js";

function* nameable(
  descriptors: Generator<ContextDescriptor>
): Generator<ContextDescriptor> {
  for (const descriptor of descriptors) {
    if (descriptor.fullTypeName !== null) {
      yield descriptor;
    }
  }
}

function typeOfKind<T extends SwiftType>(
  name: string,
  ctor: new (descriptor: ContextDescriptor) => T,
  kind: string
): T | null {
  const descriptor = findType(name);
  if (descriptor === null) {
    return null;
  }
  const type = typeFromDescriptor(descriptor);
  if (!(type instanceof ctor)) {
    throw new Error(`'${name}' is ${type.toJSON().kind}, not ${kind}`);
  }
  return type;
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
  ValueType,
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
  NativeFunctionType,
  MarshalledFunctionOptions,
  SwiftClassBoundInitializer,
  TupleTypeElement,
  ParameterConvention,
  FunctionTypeParameter,
  FunctionTypeSignature,
} from "./runtime/swift-type.js";
export { SwiftValue } from "./abi/instance.js";
export { SwiftError } from "./runtime/thrown-error.js";
export {
  ClosureSpec,
  AnyClosureBody,
} from "./runtime/closure.js";
export { SwiftSymbol } from "./runtime/symbolication.js";
export {
  SwiftInterceptorApi,
  SwiftInvocationCallbacks,
  SwiftAsyncCallbacks,
} from "./runtime/interceptor.js";
export { isSwiftObject } from "./runtime/method.js";
export type { ModuleRegistry, ModuleNamespace, ModuleMember } from "./runtime/module-namespace.js";
export type {
  SwiftBoundMethod,
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

  type(name: string): SwiftType | null {
    const descriptor = findType(name);
    return descriptor === null ? null : typeFromDescriptor(descriptor);
  },

  *enumerateTypes(module?: Module): Generator<SwiftType> {
    for (const descriptor of nameable(swiftTypes(module))) {
      yield typeFromDescriptor(descriptor);
    }
  },

  class(name: string): ClassType | null {
    return typeOfKind(name, ClassType, "class");
  },

  *enumerateClasses(module?: Module): Generator<ClassType> {
    for (const descriptor of nameable(swiftClasses(module))) {
      yield new ClassType(descriptor);
    }
  },

  struct(name: string): StructType | null {
    return typeOfKind(name, StructType, "struct");
  },

  *enumerateStructs(module?: Module): Generator<StructType> {
    for (const descriptor of nameable(swiftStructs(module))) {
      yield new StructType(descriptor);
    }
  },

  enum(name: string): EnumType | null {
    return typeOfKind(name, EnumType, "enum");
  },

  *enumerateEnums(module?: Module): Generator<EnumType> {
    for (const descriptor of nameable(swiftEnums(module))) {
      yield new EnumType(descriptor);
    }
  },

  closure,
  markResilient: markResilientModule,
  symbolicate,
  Interceptor: SwiftInterceptor,

  borrowObject(handle: NativePointer): SwiftClassObject {
    return asSwiftObject(handle);
  },

  adoptObject(handle: NativePointer): SwiftClassObject {
    return asSwiftObject(ClassInstance.adopt(handle));
  },

  NativeFunction: swiftFunction,
  function: resolveFunction,
  asyncFunction: resolveAsyncFunction,
  Protocol: {
    find: (name: string): StableProtocol | null => ProtocolClass.find(name),
  },
  ProtocolComposition: {
    fromSignature: (signature: string): StableProtocolComposition =>
      ProtocolCompositionClass.fromSignature(signature),
  },
};

export default Swift;
