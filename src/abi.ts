// The `/abi` escape hatch: Swift-version-sensitive reversing capabilities outside the
// root's stability promise. An explicit allowlist, not a star re-export of the root.
export {
  RelativeDirectPointer,
  RelativeIndirectablePointer,
} from "./basic/relative-pointer.js";
export {
  SwiftSection,
  getSwiftSection,
  enumerateTypeContextDescriptors,
} from "./image/sections.js";
export {
  ContextDescriptor,
  ContextDescriptorKind,
} from "./abi/context-descriptor.js";
export {
  enumerateSwiftModules,
  enumerateTypes,
  swiftImages,
  swiftTypes,
  swiftClasses,
  swiftStructs,
  swiftEnums,
  findType,
} from "./reflection/registry.js";
export {
  MetadataKind,
  Metadata,
  TypeLayout,
  getMetadata,
  getGenericMetadata,
  instantiateGenericMetadata,
} from "./abi/metadata.js";
export { buildGenericMetadata } from "./abi/generic-instantiation.js";
export {
  ProtocolConformance,
  enumerateProtocolConformances,
  enumerateProtocols,
  findProtocol,
  conformsToProtocol,
} from "./abi/protocol-conformance.js";
export {
  AccessibleFunctionRecord,
  enumerateAccessibleFunctions,
  findAccessibleFunction,
} from "./abi/accessible-function.js";
export { AsyncFunctionPointer } from "./abi/async-function-pointer.js";
export { AsyncContext } from "./abi/async-context.js";
export { AsyncTask, Job, JobKind, JobPriority } from "./abi/async-task.js";
export {
  driveAsyncCall,
  callAsync,
  currentAsyncTask,
  AsyncCallOptions,
  AsyncResultShape,
  AsyncFloatArg,
  FloatClass,
  SerialExecutorRef,
} from "./runtime/async-call.js";
export {
  ProtocolRequirementKind,
  ProtocolRequirement,
  readProtocolRequirements,
  readAssociatedTypeNames,
  readRequirementSignature,
} from "./abi/protocol-descriptor.js";
export {
  GenericRequirementKind,
  GenericRequirementLayoutKind,
  GenericRequirementDescriptor,
  InvertedProtocolsRequirement,
  readGenericRequirementDescriptors,
} from "./abi/generic-requirement-descriptor.js";
export { WitnessTable } from "./abi/witness-table.js";
export { resolveAssociatedConformance } from "./abi/associated-type.js";
export {
  ConditionalRequirement,
  resolveConditionalRequirements,
} from "./abi/conditional-conformance.js";
export {
  Field,
  MangledName,
  enumerateFields,
  resolveFieldType,
  fieldTypeIn,
  resolveTypeByMangledName,
} from "./abi/field-descriptor.js";
export {
  ClassMetadata,
  FieldWithOffset,
  getClassMetadata,
  classMetadataOf,
  dynamicTypeOf,
  enumerateClassFields,
} from "./abi/class-metadata.js";
export {
  MethodDescriptorKind,
  VTableEntry,
  readVTable,
  readVTableChain,
} from "./abi/class-descriptor.js";
export {
  InstanceField,
  enumerateInstanceFields,
  enumerateClassInstanceFields,
  readValue,
  writeValue,
  readObject,
} from "./abi/instance.js";
export {
  EnumCase,
  enumTag,
  readEnumCase,
  projectEnumData,
  injectEnumTag,
  setEnumTag,
  projectBox,
} from "./abi/enum.js";
export {
  ExistentialRepresentation,
  OpaqueExistential,
  existentialRepresentation,
  projectOpaqueExistential,
  projectClassExistential,
  projectExistentialValue,
  projectErrorExistential,
  existentialProtocols,
  extendedExistentialRequirementSignature,
  extendedExistentialGeneralizationArguments,
  extendedExistentialBoundAssociatedTypes,
  BoundAssociatedType,
} from "./abi/existential.js";
export { ValueInstance } from "./abi/value.js";
export { ClassInstance, VTableInvokeSignature } from "./abi/heap-object.js";
export {
  SwiftClosure,
  SwiftThrow,
  LoadableValue,
  LoadableClosureBody,
  LoadableIndirectBody,
  ClosureSpec,
  ClosureBody,
} from "./runtime/closure.js";
export { asSwiftObject } from "./runtime/object-facade.js";
export {
  TupleElement,
  tupleNumElements,
  tupleLabels,
  enumerateTupleElements,
  getUnlabelledTupleTypeMetadata,
} from "./abi/tuple.js";
export { metatypeInstanceType } from "./abi/metatype.js";
export {
  KeyPathBuffer,
  KeyPathComponent,
  StoredKeyPathComponent,
  OptionalKeyPathComponent,
  ComputedKeyPathComponent,
  KeyPathComputedArguments,
  KeyPathComputedArgumentWitnesses,
  readKeyPathBuffer,
  resolveKeyPathNames,
  hashKeyPathArguments,
  keyPathArgumentsEqual,
} from "./abi/keypath.js";
export { readFunctionType } from "./abi/function-type.js";
export {
  ValueWitnessTable,
  NUM_WORDS_VALUE_BUFFER,
  allocateValueBuffer,
} from "./abi/value-witness.js";
export {
  shouldPassIndirectly,
  isResilientValueType,
  markResilientModule,
  markFrozenType,
  indirect,
  AbstractIndirect,
  makeSwiftNativeFunction,
  SwiftNativeFunction,
  SwiftNativeFunctionOptions,
  SwiftArgType,
  GenericRef,
  ClosureRef,
} from "./runtime/calling-convention.js";
export { SwiftError } from "./runtime/thrown-error.js";
export { readString } from "./abi/string.js";
export {
  TypeExpr,
  TypeExprParam,
  SwiftFunctionSignature,
  GenericRequirement,
  SwiftAccessorSignature,
  ParsedSwiftSignature,
  ResolvedFunctionSignature,
  parseTypeExpr,
  parseSwiftSignature,
  resolveFunctionSignature,
  resolveType,
  metadataFor,
} from "./runtime/symbolication.js";
export {
  resolveMethod,
  enumerateMethods,
  enumerateProperties,
  bindValueMethod,
  bindStaticMethod,
  bindValueInitializer,
  bindGenericMethod,
  bindGenericValueMethod,
  resolveWitnessMethod,
  bindWitnessMethod,
  bindWitnessMethodAt,
  WitnessMethodSignature,
  WitnessOrigin,
  classifyWitnessOrigin,
  NamedRequirement,
  SwiftFunction,
  SwiftAsyncFunction,
  AsyncReceiver,
  resolveFunction,
  resolveAsyncFunction,
} from "./runtime/method.js";

// Companion types naming the parameters and returns of the raw exports above.
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
  TupleTypeElement,
  ParameterConvention,
  FunctionTypeParameter,
  FunctionTypeSignature,
  typeOf,
  typeFromDescriptor,
  metadataOf,
  descriptorOf,
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
export { typeName, mangledTypeName } from "./runtime/type-name.js";
export { Protocol, ProtocolComposition } from "./runtime/protocol.js";
export {
  FunctionType as FunctionSignature,
  FunctionParameter,
  FunctionMetadataConvention,
  ParameterOwnership,
  FunctionMetadataDifferentiabilityKind,
  FunctionIsolation,
} from "./abi/function-type.js";
export {
  BoundMethod,
  Binding,
  bindResolved,
  SwiftBoundMethod,
  SwiftBoundInitializer,
  SelfRouting,
  CallPlan,
  ArgPlan,
  CallResult,
  CallArg,
  ResolvedMethod,
  MethodInfo,
  MethodKind,
  MethodResolveOptions,
  ValueMethodResolveOptions,
  FunctionResolveOptions,
  SelfOwnership,
  RawMethodResolveOptions,
  RawValueMethodResolveOptions,
  PropertyInfo,
  AccessorKind,
  isSwiftObject,
} from "./runtime/method.js";
export {
  SwiftObject,
  SwiftClassObject,
  SwiftValueObject,
  SwiftField,
  SwiftClassBoundMethod,
  SwiftValueBoundMethod,
} from "./runtime/object-facade.js";
