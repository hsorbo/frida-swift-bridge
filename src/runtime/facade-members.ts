import { CallArg, CallResult, ValueMethodResolveOptions, enumerateMethods, enumerateProperties, memberKindsInOtherModules } from "./method.js";
import { ClosureSpec } from "./closure.js";

// A synthesized `then` would make a facade thenable and silently break `await`; never a member.
export const POISON = new Set(["then", "catch", "finally"]);

// The bridge's own members live under $; `reserved` adds the JS protocol names a facade answers itself.
export function isBridgeMember(key: string, reserved: Set<string>): boolean {
  return key.startsWith("$") || reserved.has(key);
}

export function invokeOptions(args: CallArg[]): ValueMethodResolveOptions {
  const options: ValueMethodResolveOptions = { arity: args.length };
  if (args.some((a) => a instanceof ClosureSpec)) {
    options.typeArguments = []; // generic path; planGenericMethod infers the closure-result R
  }
  return options;
}

export interface MemberIndex {
  methods: Set<string>;
  properties: Set<string>;
  writableProperties: Set<string>;
}

export interface FacadeMembers {
  own(): MemberIndex;
  including(key: string): MemberIndex;
}

// The Swift members a facade answers: the defining module's are indexed up front; one another
// module or a protocol extension adds joins the index when its name is first asked for.
export function facadeMembers(typeName: () => string, isStatic: boolean): FacadeMembers {
  let index: MemberIndex | null = null;
  const own = (): MemberIndex => {
    if (index === null) {
      const properties = enumerateProperties(typeName(), "definingModule").filter((p) => p.isStatic === isStatic);
      index = {
        methods: new Set(
          enumerateMethods(typeName(), "definingModule")
            .filter((m) => m.kind === "method" && m.isStatic === isStatic)
            .map((m) => m.name)
        ),
        properties: new Set(properties.map((p) => p.name)),
        writableProperties: new Set(properties.filter((p) => p.writable).map((p) => p.name)),
      };
    }
    return index;
  };
  const searched = new Set<string>();
  const including = (key: string): MemberIndex => {
    const members = own();
    if (members.methods.has(key) || members.properties.has(key) || searched.has(key)) {
      return members;
    }
    searched.add(key);
    const found = memberKindsInOtherModules(typeName(), key, isStatic);
    if (found.method) {
      members.methods.add(key);
    }
    if (found.property) {
      members.properties.add(key);
    }
    if (found.writable) {
      members.writableProperties.add(key);
    }
    return members;
  };
  return { own, including };
}

export type FacadeCallable = (...args: CallArg[]) => CallResult | Promise<CallResult>;

// One function per name, so a facade's method compares equal to itself across reads.
export function callableCache(invoke: (name: string, args: CallArg[]) => CallResult | Promise<CallResult>): (name: string) => FacadeCallable {
  const callables = new Map<string, FacadeCallable>();
  return (name) => {
    let fn = callables.get(name);
    if (fn === undefined) {
      fn = (...args) => invoke(name, args);
      callables.set(name, fn);
    }
    return fn;
  };
}
