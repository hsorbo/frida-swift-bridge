import { swiftMatches, nameQuery, NameFilter } from "./swift-resolver.js";
import { parseSwiftSignature, SwiftAccessorSignature } from "./type-expr.js";
import { SwiftMemberSignature, memberSignature, withHookTarget } from "./method.js";

// A function with a Swift symbol, as the resolver spells it. Hookable as it is.
export interface SwiftFunctionMatch {
  readonly address: NativePointer;
  readonly module: string;
  readonly name: string;
  readonly kind: "function" | "getter" | "setter" | "modify";
  readonly signature: SwiftMemberSignature;
}

// A getter or modify yields the property's type and a setter takes it, as the hook's callbacks see them.
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

export function* swiftFunctions(filter?: NameFilter): Generator<SwiftFunctionMatch> {
  for (const match of swiftMatches(nameQuery("functions", filter))) {
    const split = match.name.indexOf("!");
    const name = match.name.substring(split + 1);
    const parsed = parseSwiftSignature(name);
    if (parsed === null) {
      continue;
    }
    const path = match.name.substring(0, split);
    yield withHookTarget(
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
}
