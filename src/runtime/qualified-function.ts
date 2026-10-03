import { nominalTypeNamed } from "./swift-type.js";
import {
  CallArg,
  CallResult,
  FoundMember,
  MemberOrigin,
  SwiftAsyncFunction,
  SwiftFunction,
  ValueMethodResolveOptions,
  findMember,
  isSwiftObject,
  lowerResolveOptions,
  resolveAsyncFunction,
  resolveFunction,
  splitSelector,
} from "./method.js";

// A member named by its qualified selector, as a demangled symbol spells it. Like Swift's own
// unapplied method references, a type member is called directly and an instance member takes self
// as its first argument.
export interface SwiftMemberFunction {
  readonly address: NativePointer;
  readonly selector: string;
  readonly isStatic: boolean;
  readonly isAsync: boolean;
  readonly origin: MemberOrigin;
  call(...args: CallArg[]): CallResult | Promise<CallResult>;
}

export interface SwiftAsyncMemberFunction extends SwiftMemberFunction {
  call(...args: CallArg[]): Promise<CallResult>;
}

// The member is the last dot-separated segment outside brackets; nested types and generic
// arguments keep their own dots.
function splitQualifiedSelector(qualified: string): { typeName: string; selector: string } {
  let depth = 0;
  let split = -1;
  for (let i = 0; i < qualified.length; i++) {
    const c = qualified[i];
    if (c === "<" || c === "(") {
      depth++;
    } else if (c === ">" || c === ")") {
      depth--;
    } else if (c === "." && depth === 0) {
      split = i;
    }
  }
  if (split <= 0 || split === qualified.length - 1) {
    throw new Error(`${qualified} is not a qualified selector (Module.Type.member(labels:))`);
  }
  return { typeName: qualified.slice(0, split), selector: qualified.slice(split + 1) };
}

function findMemberOfKind(
  typeName: string,
  selector: string,
  options: ValueMethodResolveOptions
): FoundMember {
  const { name, options: split } = splitSelector(selector, options);
  const raw = lowerResolveOptions(split);
  if (raw.static !== undefined) {
    const found = findMember(typeName, name, raw);
    if (found === null) {
      throw new Error(`no ${raw.static ? "type" : "instance"} member ${selector} on ${typeName}`);
    }
    return found;
  }
  const typeMember = findMember(typeName, name, { ...raw, static: true });
  const instanceMember = findMember(typeName, name, { ...raw, static: false });
  if (typeMember !== null && instanceMember !== null) {
    throw new Error(
      `${typeName}.${selector} names both a type and an instance member; pick one with { static: true } or { static: false }`
    );
  }
  const found = typeMember ?? instanceMember;
  if (found === null) {
    throw new Error(`no member ${selector} on ${typeName}`);
  }
  return found;
}

export function qualifiedFunction(qualified: string, options: ValueMethodResolveOptions = {}): SwiftMemberFunction {
  const { typeName, selector } = splitQualifiedSelector(qualified);
  const type = nominalTypeNamed(typeName);
  if (type === null) {
    throw new Error(`unknown type: ${typeName}`);
  }
  const found = findMemberOfKind(type.name, selector, options);
  const { static: _, ...lookup } = options;
  const call = found.isStatic
    ? (...args: CallArg[]) => type.facade.$typeMethod(selector, lookup).call(...args)
    : (...args: CallArg[]) => {
        const self = args.shift() as CallResult | undefined;
        if (self === undefined || !isSwiftObject(self)) {
          throw new Error(`${type.name}.${found.selector} is an instance method; pass self as the first argument`);
        }
        return self.$method(selector, { ...lookup, static: false }).call(...args);
      };
  return {
    address: found.address,
    selector: found.selector,
    isStatic: found.isStatic,
    isAsync: found.async,
    origin: found.origin,
    call,
  };
}

export function qualifiedAsyncFunction(
  qualified: string,
  options: ValueMethodResolveOptions = {}
): SwiftAsyncMemberFunction {
  const fn = qualifiedFunction(qualified, options);
  if (!fn.isAsync) {
    throw new Error(`${fn.selector} is not async; use Swift.function`);
  }
  return fn as SwiftAsyncMemberFunction;
}

export function resolveSwiftFunction<Ret = CallResult | Promise<CallResult>, Args extends CallArg[] = CallArg[]>(
  module: Module,
  mangled: string
): SwiftFunction<Ret, Args>;
export function resolveSwiftFunction(qualified: string, options?: ValueMethodResolveOptions): SwiftMemberFunction;
export function resolveSwiftFunction(
  target: Module | string,
  spec?: string | ValueMethodResolveOptions
): SwiftFunction | SwiftMemberFunction {
  return typeof target === "string"
    ? qualifiedFunction(target, spec as ValueMethodResolveOptions | undefined)
    : resolveFunction(target, spec as string);
}

export function resolveSwiftAsyncFunction<Ret = CallResult, Args extends CallArg[] = CallArg[]>(
  module: Module,
  mangled: string
): SwiftAsyncFunction<Ret, Args>;
export function resolveSwiftAsyncFunction(
  qualified: string,
  options?: ValueMethodResolveOptions
): SwiftAsyncMemberFunction;
export function resolveSwiftAsyncFunction(
  target: Module | string,
  spec?: string | ValueMethodResolveOptions
): SwiftAsyncFunction | SwiftAsyncMemberFunction {
  return typeof target === "string"
    ? qualifiedAsyncFunction(target, spec as ValueMethodResolveOptions | undefined)
    : resolveAsyncFunction(target, spec as string);
}
