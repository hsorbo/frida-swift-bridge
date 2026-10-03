import { swiftMatches, nameQuery, NameFilter } from "./swift-resolver.js";
import { parseSwiftSignature } from "./type-expr.js";
import { SwiftMemberSignature, memberSignature, withHookTarget } from "./method.js";

// A function with a Swift symbol, as the resolver spells it. Hookable as it is; an accessor's name
// spells its type, and only a function carries a signature.
export interface SwiftFunctionMatch {
  readonly address: NativePointer;
  readonly module: string;
  readonly name: string;
  readonly kind: "function" | "getter" | "setter" | "modify";
  readonly signature: SwiftMemberSignature | null;
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
        module: path.substring(path.lastIndexOf("/") + 1),
        name,
        kind: parsed.kind,
        signature: parsed.kind === "function" ? memberSignature(parsed) : null,
      },
      { address: match.address, signature: parsed, witnessDispatched: false }
    );
  }
}
