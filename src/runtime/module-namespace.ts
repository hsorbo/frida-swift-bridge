import { ContextDescriptor, ContextDescriptorKind } from "../abi/context-descriptor.js";
import { protocolDescriptors, protocolsNamedUnder } from "../abi/protocol-conformance.js";
import { findType, swiftTypes, typesNamedUnder } from "../reflection/registry.js";
import { typeFromDescriptor } from "./swift-type.js";
import { SwiftTypeFacade } from "./type-facade.js";
import { Protocol, StableProtocol } from "./protocol.js";
import { POISON } from "./facade-members.js";

export type ModuleMember = SwiftTypeFacade | StableProtocol;
export type ModuleNamespace = { readonly [name: string]: ModuleMember };
export type ModuleRegistry = { readonly [module: string]: ModuleNamespace };

const ENUMERABLE = { writable: false, configurable: true, enumerable: true };

function* declarations(moduleName?: string): Generator<ContextDescriptor> {
  if (moduleName === undefined) {
    yield* swiftTypes();
    yield* protocolDescriptors();
    return;
  }
  yield* typesNamedUnder(moduleName);
  yield* protocolsNamedUnder(moduleName);
}

// A private declaration sits under an anonymous context between it and its module.
function topLevelModuleName(descriptor: ContextDescriptor): string | null {
  let parent = descriptor.parent;
  while (parent !== null && parent.kind === ContextDescriptorKind.Anonymous) {
    parent = parent.parent;
  }
  return parent !== null && parent.kind === ContextDescriptorKind.Module ? parent.name : null;
}

// Never caches a miss: a module loaded later can declare it.
const knownModules = new Set<string>();

function moduleExists(name: string): boolean {
  if (knownModules.has(name)) {
    return true;
  }
  for (const descriptor of declarations(name)) {
    if (descriptor.moduleName === name) {
      knownModules.add(name);
      return true;
    }
  }
  return false;
}

function findMember(moduleName: string, name: string): ModuleMember | null {
  const qualified = `${moduleName}.${name}`;
  const type = findType(qualified);
  return type !== null ? typeFromDescriptor(type).facade : Protocol.find(qualified);
}

function lazyNamespace<T>(
  label: string,
  find: (key: string) => T | null,
  keys: () => Iterable<string>
): { readonly [key: string]: T } {
  return new Proxy({} as { readonly [key: string]: T }, {
    has(_, key) {
      return typeof key === "string" && !POISON.has(key) && find(key) !== null;
    },
    get(_, key) {
      if (typeof key !== "string" || POISON.has(key)) {
        return undefined;
      }
      if (key === "toString") {
        return () => label;
      }
      // Serializers (the REPL, JSON.stringify) would otherwise read every member and recurse into it.
      if (key === "toJSON") {
        return () => [...new Set(keys())];
      }
      return find(key) ?? undefined;
    },
    set() {
      return false;
    },
    ownKeys() {
      return [...new Set(keys())];
    },
    getOwnPropertyDescriptor() {
      return ENUMERABLE;
    },
  });
}

function moduleNamespace(moduleName: string): ModuleNamespace {
  return lazyNamespace(
    `Swift.modules.${moduleName}`,
    (name) => findMember(moduleName, name),
    function* () {
      for (const descriptor of declarations(moduleName)) {
        const name = descriptor.name;
        if (name !== null && topLevelModuleName(descriptor) === moduleName) {
          yield name;
        }
      }
    }
  );
}

let registry: ModuleRegistry | null = null;

export function moduleRegistry(): ModuleRegistry {
  if (registry === null) {
    const namespaces = new Map<string, ModuleNamespace>();
    registry = lazyNamespace(
      "Swift.modules",
      (name) => {
        let namespace = namespaces.get(name);
        if (namespace === undefined) {
          if (!moduleExists(name)) {
            return null;
          }
          namespace = moduleNamespace(name);
          namespaces.set(name, namespace);
        }
        return namespace;
      },
      function* () {
        for (const descriptor of declarations()) {
          const name = descriptor.moduleName;
          if (name !== null) {
            yield name;
          }
        }
      }
    );
  }
  return registry;
}
