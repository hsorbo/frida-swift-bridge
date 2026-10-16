import { Metadata } from "./metadata.js";

const OFFSETOF_FLAGS = Process.pointerSize;
const OFFSETOF_RESULT_TYPE = 2 * Process.pointerSize;
const OFFSETOF_TRAILING_OBJECTS = 3 * Process.pointerSize;

const NUM_PARAMETERS_MASK = 0x0000ffff;
const CONVENTION_MASK = 0x00ff0000;
const CONVENTION_SHIFT = 16;
const THROWS_BIT = 0x01000000;
const PARAMETER_FLAGS_BIT = 0x02000000;
const ESCAPING_BIT = 0x04000000;
const DIFFERENTIABLE_BIT = 0x08000000;
const GLOBAL_ACTOR_BIT = 0x10000000;
const ASYNC_BIT = 0x20000000;
const SENDABLE_BIT = 0x40000000;
const EXTENDED_FLAGS_BIT = 0x80000000;

const OWNERSHIP_MASK = 0x7f;
const VARIADIC_BIT = 0x80;
const AUTOCLOSURE_BIT = 0x100;
const NO_DERIVATIVE_BIT = 0x200;
const ISOLATED_BIT = 0x400;
const SENDING_BIT = 0x800;

const TYPED_THROWS_BIT = 0x1;
const ISOLATION_MASK = 0xe;
const ISOLATION_ISOLATED_ANY = 0x2;
const ISOLATION_NONISOLATED_NONSENDING = 0x4;
const SENDING_RESULT_BIT = 0x10;

const PARAMETER_FLAGS_SIZE = 4;
const EXTENDED_FLAGS_SIZE = 4;

export enum FunctionMetadataConvention {
  Swift = 0,
  Block = 1,
  Thin = 2,
  CFunctionPointer = 3,
}

export enum ParameterOwnership {
  Default = 0,
  InOut = 1,
  Shared = 2,
  Owned = 3,
}

export enum FunctionMetadataDifferentiabilityKind {
  NonDifferentiable = 0,
  Forward = 1,
  Reverse = 2,
  Normal = 3,
  Linear = 4,
}

export enum FunctionIsolation {
  NonIsolated = 0,
  IsolatedAny = 1,
  NonIsolatedNonsending = 2,
}

export interface FunctionParameter {
  type: Metadata;
  ownership: ParameterOwnership;
  isVariadic: boolean;
  isAutoClosure: boolean;
  isNoDerivative: boolean;
  isIsolated: boolean;
  isSending: boolean;
}

export interface FunctionType {
  numParameters: number;
  convention: FunctionMetadataConvention;
  isAsync: boolean;
  isThrowing: boolean;
  isEscaping: boolean;
  isSendable: boolean;
  isDifferentiable: boolean;
  differentiabilityKind: FunctionMetadataDifferentiabilityKind;
  resultType: Metadata;
  parameters: FunctionParameter[];
  globalActor: Metadata | null;
  isolation: FunctionIsolation;
  hasSendingResult: boolean;
  thrownError: Metadata | null;
  invertedProtocols: number; // InvertibleProtocolSet bits; see generic-requirement-descriptor.ts
}

function alignUp(value: number, alignment: number): number {
  return (value + alignment - 1) & ~(alignment - 1);
}

function readParameterFlags(raw: number): Omit<FunctionParameter, "type"> {
  return {
    ownership: raw & OWNERSHIP_MASK,
    isVariadic: (raw & VARIADIC_BIT) !== 0,
    isAutoClosure: (raw & AUTOCLOSURE_BIT) !== 0,
    isNoDerivative: (raw & NO_DERIVATIVE_BIT) !== 0,
    isIsolated: (raw & ISOLATED_BIT) !== 0,
    isSending: (raw & SENDING_BIT) !== 0,
  };
}

export function readFunctionType(metadata: Metadata): FunctionType {
  const handle = metadata.handle;
  const rawFlags = handle.readU32(OFFSETOF_FLAGS);

  const numParameters = rawFlags & NUM_PARAMETERS_MASK;
  const hasParameterFlags = (rawFlags & PARAMETER_FLAGS_BIT) !== 0;
  const isDifferentiable = (rawFlags & DIFFERENTIABLE_BIT) !== 0;
  const hasGlobalActor = (rawFlags & GLOBAL_ACTOR_BIT) !== 0;
  const hasExtendedFlags = (rawFlags & EXTENDED_FLAGS_BIT) !== 0;

  // Trailing arrays/records pack back-to-back at their natural alignment (swift/ABI/TrailingObjects.h);
  // only a narrower-then-wider transition needs padding, so re-align only before the 8-byte-aligned records.
  const ptr = Process.pointerSize;
  const parametersOffset = OFFSETOF_TRAILING_OBJECTS;
  const parameterFlagsOffset = parametersOffset + numParameters * ptr;
  const differentiabilityKindOffset = alignUp(
    parameterFlagsOffset + (hasParameterFlags ? numParameters * PARAMETER_FLAGS_SIZE : 0),
    ptr
  );
  const globalActorOffset = differentiabilityKindOffset + (isDifferentiable ? ptr : 0);
  const extendedFlagsOffset = globalActorOffset + (hasGlobalActor ? ptr : 0);
  const thrownErrorOffset = alignUp(
    extendedFlagsOffset + (hasExtendedFlags ? EXTENDED_FLAGS_SIZE : 0),
    ptr
  );

  const parameters: FunctionParameter[] = [];
  for (let i = 0; i < numParameters; i++) {
    const type = new Metadata(handle.readPointer(parametersOffset + i * ptr));
    const rawParameterFlags = hasParameterFlags
      ? handle.readU32(parameterFlagsOffset + i * PARAMETER_FLAGS_SIZE)
      : 0;
    parameters.push({ type, ...readParameterFlags(rawParameterFlags) });
  }

  const differentiabilityKind: FunctionMetadataDifferentiabilityKind = isDifferentiable
    ? handle.readU32(differentiabilityKindOffset)
    : FunctionMetadataDifferentiabilityKind.NonDifferentiable;

  const globalActor = hasGlobalActor
    ? new Metadata(handle.readPointer(globalActorOffset))
    : null;

  const rawExtendedFlags = hasExtendedFlags ? handle.readU32(extendedFlagsOffset) : 0;
  const isolationBits = rawExtendedFlags & ISOLATION_MASK;
  const isolation =
    isolationBits === ISOLATION_ISOLATED_ANY
      ? FunctionIsolation.IsolatedAny
      : isolationBits === ISOLATION_NONISOLATED_NONSENDING
        ? FunctionIsolation.NonIsolatedNonsending
        : FunctionIsolation.NonIsolated;
  const isTypedThrows = (rawExtendedFlags & TYPED_THROWS_BIT) !== 0;

  return {
    numParameters,
    convention: (rawFlags & CONVENTION_MASK) >>> CONVENTION_SHIFT,
    isAsync: (rawFlags & ASYNC_BIT) !== 0,
    isThrowing: (rawFlags & THROWS_BIT) !== 0,
    isEscaping: (rawFlags & ESCAPING_BIT) !== 0,
    isSendable: (rawFlags & SENDABLE_BIT) !== 0,
    isDifferentiable,
    differentiabilityKind,
    resultType: new Metadata(handle.readPointer(OFFSETOF_RESULT_TYPE)),
    parameters,
    globalActor,
    isolation,
    hasSendingResult: (rawExtendedFlags & SENDING_RESULT_BIT) !== 0,
    thrownError: isTypedThrows ? new Metadata(handle.readPointer(thrownErrorOffset)) : null,
    invertedProtocols: rawExtendedFlags >>> 16,
  };
}
