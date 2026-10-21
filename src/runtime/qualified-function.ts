import { nominalTypeNamed, receiverFacade } from "./swift-type.js";
import { symbolicate } from "./symbolication.js";
import type { SwiftObject } from "./object-facade.js";
import type { SwiftFunctionMatch, SwiftFunctionSlot } from "./function-listing.js";
import {
  AsyncReceiver,
  CallArg,
  CallResult,
  FoundMember,
  FunctionResolveOptions,
  MemberOrigin,
  SwiftFunction,
  SwiftMemberSignature,
  ValueMethodResolveOptions,
  findMember,
  lowerResolveOptions,
  memberSignature,
  resolveFunction,
  splitSelector,
  withHookTarget,
} from "./method.js";

// A member named by its qualified selector, as a demangled symbol spells it. Like Swift's own
// unapplied method references, a type member is called directly and an instance member takes self
// as its first argument, or binds one as Swift.function(module, mangled) does.
export interface SwiftMemberFunction {
  readonly address: NativePointer;
  readonly selector: string;
  readonly isStatic: boolean;
  readonly isAsync: boolean;
  readonly origin: MemberOrigin;
  readonly signature: SwiftMemberSignature;
  call(...args: CallArg[]): CallResult | Promise<CallResult>;
  bind(receiver: SwiftObject | AsyncReceiver): (...args: CallArg[]) => CallResult | Promise<CallResult>;
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
  const found = findMemberOfKind(typeName, selector, options);
  const { static: _, ...lookup } = options;
  const qualifiedName = `${type.name}.${found.selector}`;
  const takesReceiver = !found.isStatic && splitSelector(selector, {}).name !== "init";
  const bind = (receiver: SwiftObject | AsyncReceiver) => {
    if (!takesReceiver) {
      throw new Error(`${qualifiedName} takes no receiver`);
    }
    const bound = receiverFacade(type, receiver, qualifiedName).$method(selector, { ...lookup, static: false });
    return (...args: CallArg[]) => bound.call(...args);
  };
  const call = found.isStatic
    ? (...args: CallArg[]) => type.facade.$typeMethod(selector, lookup).call(...args)
    : !takesReceiver
    ? (...args: CallArg[]) => type.facade.$initializer(selector, lookup).call(...args)
    : (...args: CallArg[]) => {
        const self = args.shift();
        if (typeof self !== "object" || self === null) {
          throw new Error(`${qualifiedName} is an instance method; pass self as the first argument`);
        }
        return bind(self as SwiftObject | AsyncReceiver)(...args);
      };
  return withHookTarget(
    {
      address: found.address,
      selector: found.selector,
      isStatic: found.isStatic,
      isAsync: found.async,
      origin: found.origin,
      signature: memberSignature(found.signature),
      call,
      bind,
    },
    { address: found.address, signature: found.signature, witnessDispatched: false }
  );
}

export function resolveSwiftFunction<Ret = CallResult | Promise<CallResult>, Args extends CallArg[] = CallArg[]>(
  module: Module,
  mangled: string,
  options?: FunctionResolveOptions
): SwiftFunction<Ret, Args>;
export function resolveSwiftFunction(qualified: string, options?: ValueMethodResolveOptions): SwiftMemberFunction;
export function resolveSwiftFunction<Ret = CallResult | Promise<CallResult>, Args extends CallArg[] = CallArg[]>(
  match: SwiftFunctionMatch | SwiftFunctionSlot,
  options?: FunctionResolveOptions
): SwiftFunction<Ret, Args>;
export function resolveSwiftFunction(
  target: Module | string | SwiftFunctionMatch | SwiftFunctionSlot,
  spec?: string | ValueMethodResolveOptions | FunctionResolveOptions,
  options?: FunctionResolveOptions
): SwiftFunction | SwiftMemberFunction {
  if (typeof target === "string") {
    return qualifiedFunction(target, spec as ValueMethodResolveOptions | undefined);
  }
  if ("address" in target) {
    return matchedFunction(target, spec as FunctionResolveOptions | undefined);
  }
  return resolveFunction(target, spec as string, options);
}

// A listing's match carries no mangled name; the symbol at its address names it. A slot has none.
function matchedFunction(match: SwiftFunctionMatch | SwiftFunctionSlot, options?: FunctionResolveOptions): SwiftFunction {
  if (match.kind !== "function") {
    throw new Error(`${match.name} is a ${match.kind}; Swift.function calls functions only, read the property through its type`);
  }
  const symbol = match.signature === null ? null : symbolicate(match.address);
  if (symbol === null) {
    throw new Error(`${match.name} has no symbol to call through; hook its address`);
  }
  return resolveFunction(Process.getModuleByName(match.module), symbol.name, options);
}
