import { swiftMatches, nameQuery, NameFilter } from "./swift-resolver.js";
import { parseSwiftSignature, SwiftAccessorSignature } from "./type-expr.js";
import { SwiftMemberSignature, memberSignature, withHookTarget, PRIVATE_DECL_NAME } from "./method.js";
import { ContextDescriptor, ContextDescriptorKind } from "../abi/context-descriptor.js";
import { MethodDescriptorKind, readOverrides, readVTable } from "../abi/class-descriptor.js";
import { enumerateProtocolConformances, readWitnesses } from "../abi/protocol-conformance.js";
import { ProtocolRequirement, ProtocolRequirementKind, readProtocolRequirements } from "../abi/protocol-descriptor.js";
import { AsyncFunctionPointer } from "../abi/async-function-pointer.js";
import { enumerateTypeContextDescriptors } from "../image/sections.js";
import { enumerateSwiftModules } from "../reflection/registry.js";
import { demangle } from "./demangle.js";

type FunctionKind = "function" | "getter" | "setter" | "modify" | "read";

// A function with a Swift symbol, private declarations spelled by their plain name. Hookable as it is.
export interface SwiftFunctionMatch {
  readonly address: NativePointer;
  readonly module: string;
  readonly name: string;
  readonly kind: FunctionKind;
  readonly signature: SwiftMemberSignature;
}

// A vtable or witness slot no symbol names, as `Module.Type.vtable#<offset>` or
// `Module.Type.Protocol#<index>`. Without a signature it is hooked by address. A witness slot's
// requirement is spelled `Protocol.selector` when the protocol's module exports its method
// descriptors, null for a vtable slot or a protocol built without library evolution.
export interface SwiftFunctionSlot {
  readonly address: NativePointer;
  readonly module: string;
  readonly name: string;
  readonly kind: FunctionKind;
  readonly signature: null;
  readonly requirement: string | null;
}

export interface FunctionListingOptions {
  slots?: boolean;
}

const METHOD_KINDS: Record<number, FunctionKind> = {
  [MethodDescriptorKind.Method]: "function",
  [MethodDescriptorKind.Init]: "function",
  [MethodDescriptorKind.Getter]: "getter",
  [MethodDescriptorKind.Setter]: "setter",
  [MethodDescriptorKind.ModifyCoroutine]: "modify",
  [MethodDescriptorKind.ReadCoroutine]: "read",
};

const REQUIREMENT_KINDS: Record<number, FunctionKind> = {
  [ProtocolRequirementKind.Method]: "function",
  [ProtocolRequirementKind.Init]: "function",
  [ProtocolRequirementKind.Getter]: "getter",
  [ProtocolRequirementKind.Setter]: "setter",
  [ProtocolRequirementKind.ModifyCoroutine]: "modify",
  [ProtocolRequirementKind.ReadCoroutine]: "read",
};

// A getter, modify or read yields the property's type and a setter takes it, as the hook's callbacks see them.
function accessorSignature(accessor: SwiftAccessorSignature): SwiftMemberSignature {
  const isSetter = accessor.kind === "setter";
  return {
    labels: isSetter ? [null] : [],
    argTypeNames: isSetter ? [accessor.typeName] : [],
    returnTypeName: isSetter ? null : accessor.typeName,
    throws: false,
    thrownTypeName: null,
    isAsync: false,
    genericParams: [],
  };
}

function functionMatch(match: ApiResolverMatch): SwiftFunctionMatch | null {
  const split = match.name.indexOf("!");
  const name = match.name.substring(split + 1).replace(PRIVATE_DECL_NAME, "$1");
  const parsed = parseSwiftSignature(name);
  if (parsed === null) {
    return null;
  }
  const path = match.name.substring(0, split);
  return withHookTarget(
    {
      address: match.address,
      module: path.substring(path.search(/[^\\/]*$/)),
      name,
      kind: parsed.kind,
      signature: parsed.kind === "function" ? memberSignature(parsed) : accessorSignature(parsed),
    },
    { address: match.address, signature: parsed, witnessDispatched: false }
  );
}

function slot(module: Module, name: string, kind: FunctionKind, entry: NativePointer, isAsync: boolean): SwiftFunctionSlot {
  const address = isAsync ? new AsyncFunctionPointer(entry).code : entry.strip();
  const inModule = address.compare(module.base) >= 0 && address.compare(module.base.add(module.size)) < 0;
  return { address, module: inModule ? module.name : (Process.findModuleByAddress(address)?.name ?? module.name), name, kind, signature: null, requirement: null };
}

interface WalkedSlot {
  slot: SwiftFunctionSlot;
  protocol: ContextDescriptor | null;
  requirement: ProtocolRequirement | null;
}

const METHOD_DESCRIPTOR_SUFFIX = "Tq";
const METHOD_DESCRIPTOR_PREFIX = "method descriptor for ";

function requirementSelector(methodDescriptorSymbol: string): string | null {
  const demangled = demangle(methodDescriptorSymbol);
  if (demangled === null || !demangled.startsWith(METHOD_DESCRIPTOR_PREFIX)) {
    return null;
  }
  const parsed = parseSwiftSignature(demangled.slice(METHOD_DESCRIPTOR_PREFIX.length));
  return parsed === null ? null : parsed.kind === "function" ? parsed.selector : parsed.member;
}

// Read from descriptors alone, so no type's metadata is realized; a generic class has no fixed vtable
// offset. A type whose slot names cannot start with the glob's literal head is skipped unread.
class SlotWalk {
  private readonly names = new Map<string, string | null>();
  private readonly requirements = new Map<string, ProtocolRequirement[]>();
  private readonly methodDescriptors = new Map<string, Map<string, string>>();
  private readonly selectors = new Map<string, string | null>();

  constructor(private readonly head = "") {}

  *slots(module: Module): Generator<WalkedSlot> {
    for (const handle of enumerateTypeContextDescriptors(module)) {
      const descriptor = new ContextDescriptor(handle);
      if (descriptor.kind !== ContextDescriptorKind.Class || descriptor.isGeneric) {
        continue;
      }
      const prefix = `${descriptor.fullTypeName}.vtable#`;
      if (!this.couldMatch(prefix)) {
        continue;
      }
      for (const entry of [...readVTable(descriptor), ...readOverrides(descriptor)]) {
        const kind = METHOD_KINDS[entry.kind];
        if (kind !== undefined) {
          yield { slot: slot(module, `${prefix}${entry.metadataOffset}`, kind, entry.declaredImpl, entry.isAsync), protocol: null, requirement: null };
        }
      }
    }
    for (const conformance of enumerateProtocolConformances(module)) {
      const type = conformance.typeDescriptor;
      const protocol = conformance.protocol;
      const typeName = type === null ? null : this.nameOf(type);
      const protocolName = protocol === null ? null : this.nameOf(protocol.handle);
      if (protocol === null || typeName === null || protocolName === null) {
        continue;
      }
      const prefix = `${typeName}.${protocolName}#`;
      if (!this.couldMatch(prefix)) {
        continue;
      }
      for (const { requirement, entry } of readWitnesses(conformance, this.requirementsOf(protocol))) {
        const kind = REQUIREMENT_KINDS[requirement.kind];
        if (kind !== undefined) {
          yield { slot: slot(module, `${prefix}${requirement.witnessIndex}`, kind, entry, requirement.isAsync), protocol, requirement };
        }
      }
    }
  }

  // A protocol's module exports a method descriptor at each requirement record when a client may
  // need it for a resilient witness table; the export trie carries it as data, which a resolver
  // query leaves out, so it comes from the module's full export list, read once per walk.
  named({ slot, protocol, requirement }: WalkedSlot): SwiftFunctionSlot {
    if (protocol === null || requirement === null) {
      return slot;
    }
    const key = requirement.address.toString();
    let selector = this.selectors.get(key);
    if (selector === undefined) {
      const module = Process.findModuleByAddress(protocol.handle);
      const symbol = module === null ? undefined : this.methodDescriptorsOf(module).get(key);
      selector = symbol === undefined ? null : requirementSelector(symbol);
      this.selectors.set(key, selector);
    }
    return selector === null ? slot : { ...slot, requirement: `${this.nameOf(protocol.handle)}.${selector}` };
  }

  private methodDescriptorsOf(module: Module): Map<string, string> {
    const key = module.path;
    let byAddress = this.methodDescriptors.get(key);
    if (byAddress === undefined) {
      byAddress = new Map();
      for (const e of module.enumerateExports()) {
        if (e.name.endsWith(METHOD_DESCRIPTOR_SUFFIX)) {
          byAddress.set(e.address.toString(), e.name);
        }
      }
      this.methodDescriptors.set(key, byAddress);
    }
    return byAddress;
  }

  private couldMatch(prefix: string): boolean {
    return prefix.startsWith(this.head) || this.head.startsWith(prefix);
  }

  private nameOf(descriptor: NativePointer): string | null {
    const key = descriptor.toString();
    let name = this.names.get(key);
    if (name === undefined) {
      name = new ContextDescriptor(descriptor).fullTypeName;
      this.names.set(key, name);
    }
    return name;
  }

  private requirementsOf(protocol: ContextDescriptor): ProtocolRequirement[] {
    const key = protocol.handle.toString();
    let requirements = this.requirements.get(key);
    if (requirements === undefined) {
      requirements = readProtocolRequirements(protocol);
      this.requirements.set(key, requirements);
    }
    return requirements;
  }
}

function globPattern(glob: string): RegExp {
  return new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
}

export function swiftFunctions(filter?: NameFilter): Generator<SwiftFunctionMatch>;
export function swiftFunctions(filter: NameFilter | undefined, options: FunctionListingOptions): Generator<SwiftFunctionMatch | SwiftFunctionSlot>;
export function* swiftFunctions(filter?: NameFilter, { slots = false }: FunctionListingOptions = {}): Generator<SwiftFunctionMatch | SwiftFunctionSlot> {
  const named = new Set<string>();
  for (const match of swiftMatches(nameQuery("functions", filter))) {
    const found = functionMatch(match);
    if (found === null) {
      continue;
    }
    if (slots) {
      named.add(found.address.strip().toString());
    }
    yield found;
  }
  if (!slots) {
    return;
  }
  const glob = typeof filter === "string" ? globPattern(filter) : null;
  const modules = filter === undefined || typeof filter === "string" ? enumerateSwiftModules() : [filter];
  const walk = new SlotWalk(typeof filter === "string" ? filter.split(/[*?]/)[0] : "");
  for (const module of modules) {
    for (const found of walk.slots(module)) {
      if ((glob === null || glob.test(found.slot.name)) && !named.has(found.slot.address.toString())) {
        yield walk.named(found);
      }
    }
  }
}

// The function an address lies in, named by its Swift symbol or else by the slot it fills. Windows
// is refused: a leaf thunk there has no unwind entry, and the fallback range is wrong and slow.
export function findSwiftFunction(address: NativePointer): SwiftFunctionMatch | SwiftFunctionSlot | null {
  if (Process.platform === "windows") {
    throw new Error("Swift.findFunctionByAddress is not supported on Windows");
  }
  const range = Process.findFunctionRange(address);
  const module = range === null ? null : Process.findModuleByAddress(range.base);
  if (range === null || module === null) {
    return null;
  }
  const start = range.base.strip();
  for (const match of swiftMatches(nameQuery("functions", module))) {
    const found = match.address.strip().equals(start) ? functionMatch(match) : null;
    if (found !== null) {
      return found;
    }
  }
  const walk = new SlotWalk();
  for (const found of walk.slots(module)) {
    if (found.slot.address.equals(start)) {
      return walk.named(found);
    }
  }
  return null;
}
