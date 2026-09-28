import { demangle } from "./demangle.js";
import { findType } from "../reflection/registry.js";
import { findProtocol } from "../abi/protocol-conformance.js";
import { ContextDescriptor, ContextDescriptorKind } from "../abi/context-descriptor.js";
import { getMetadata, Metadata } from "../abi/metadata.js";
import { buildGenericMetadata } from "../abi/generic-instantiation.js";
import { getExistentialTypeMetadata } from "../abi/existential.js";
import { resolveTypeByMangledName } from "../abi/field-descriptor.js";
import { getUnlabelledTupleTypeMetadata } from "../abi/tuple.js";

export interface SwiftSymbol {
  address: NativePointer;
  name: string;
  demangled: string;
}

export interface SwiftFunctionSignature {
  kind: "function";
  context: string;
  name: string;
  genericParams: string[];
  // false for same-type / pack / shape signatures: metadata count != genericParams.length
  simpleGenerics: boolean;
  async: boolean;
  throws: boolean;
  argTypeNames: string[];
  argLabels: (string | null)[]; // null = unlabelled
  returnTypeName: string | null;
  selector: string; // e.g. "greet(name:to:)"
  conformanceRequirements: GenericRequirement[];
}

export interface GenericRequirement {
  subject: string;
  protocol: string;
}

export interface SwiftAccessorSignature {
  kind: "getter" | "setter" | "modify";
  context: string;
  member: string;
  typeName: string;
}

export type ParsedSwiftSignature = SwiftFunctionSignature | SwiftAccessorSignature;

export interface ResolvedFunctionSignature {
  throws: boolean;
  argTypes: Metadata[];
  returnType: Metadata | null;
}

const exportsByModule = new Map<string, Map<string, string>>();

export function symbolicate(address: NativePointer): SwiftSymbol | null {
  address = address.strip();
  const module = Process.findModuleByAddress(address);
  if (module === null) {
    return null;
  }

  let names = exportsByModule.get(module.path);
  if (names === undefined) {
    names = new Map<string, string>();
    for (const e of module.enumerateExports()) {
      if (e.type === "function") {
        names.set(e.address.strip().toString(), e.name);
      }
    }
    exportsByModule.set(module.path, names);
  }

  const name = names.get(address.toString());
  if (name === undefined) {
    return null;
  }
  const demangled = demangle(name);
  if (demangled === null) {
    return null;
  }
  return { address, name, demangled };
}

export function parseSwiftSignature(demangled: string): ParsedSwiftSignature | null {
  // A cross-module extension member is prefixed `(extension in Module):`; drop it so the leading paren
  // is not mistaken for the argument list and the context is the bare receiver type.
  const s = demangled.replace(/^\(extension in [^)]+\):/, "");
  const accessor = parseAccessor(s);
  if (accessor !== null) {
    return accessor;
  }
  return parseFunction(s);
}

function parseAccessor(s: string): SwiftAccessorSignature | null {
  for (const kind of ["getter", "setter", "modify"] as const) {
    const marker = `.${kind} : `;
    const at = s.indexOf(marker);
    if (at === -1) {
      continue;
    }
    const path = s.slice(0, at);
    const typeName = s.slice(at + marker.length).trim();
    const dot = lastTopLevelDot(path);
    if (dot === -1) {
      return null;
    }
    return { kind, context: path.slice(0, dot), member: path.slice(dot + 1), typeName };
  }
  return null;
}

function parseFunction(s: string): SwiftFunctionSignature | null {
  const open = topLevelIndexOf(s, "(");
  if (open === -1) {
    return null;
  }
  const close = matchingBracket(s, open);
  if (close === -1) {
    return null;
  }

  const path = s.slice(0, open);
  const dot = lastTopLevelDot(path);
  if (dot === -1) {
    return null;
  }

  const inner = s.slice(open + 1, close);
  const parsedArgs = splitTopLevel(inner, ",").map(argLabelAndType);
  const argTypeNames = parsedArgs.map((a) => a.type);
  const argLabels = parsedArgs.map((a) => a.label);

  const tail = s.slice(close + 1);
  const arrow = tail.indexOf("->");
  if (arrow === -1) {
    return null;
  }
  const returnTypeName = tail.slice(arrow + 2).trim();

  const { name: declName, genericParams, simpleGenerics, conformanceRequirements } = splitGenericClause(
    path.slice(dot + 1)
  );
  const name = stripOperatorFixity(declName);
  const selector = `${name}(${argLabels.map((l) => `${l ?? "_"}:`).join("")})`;

  return {
    kind: "function",
    context: path.slice(0, dot),
    name,
    genericParams,
    simpleGenerics,
    async: /\basync\b/.test(tail.slice(0, arrow)),
    throws: /\b(?:re)?throws\b/.test(tail.slice(0, arrow)),
    argTypeNames,
    argLabels,
    returnTypeName: returnTypeName === "()" ? null : returnTypeName,
    selector,
    conformanceRequirements,
  };
}

function splitGenericClause(name: string): {
  name: string;
  genericParams: string[];
  simpleGenerics: boolean;
  conformanceRequirements: GenericRequirement[];
} {
  const lt = topLevelIndexOf(name, "<");
  if (lt === -1 || !name.endsWith(">")) {
    return { name, genericParams: [], simpleGenerics: true, conformanceRequirements: [] };
  }
  const inner = name.slice(lt + 1, name.length - 1);
  const segments = splitTopLevel(inner, " where ");
  const params = splitTopLevel(segments[0], ",");
  const whereClause = segments.length > 1 ? segments[1] : "";
  const simpleGenerics = params.every((p) => /^[A-Za-z_]\w*$/.test(p)) && !/==/.test(whereClause);
  return {
    name: name.slice(0, lt),
    genericParams: params.map((p) => p.split(/\s+/)[0]),
    simpleGenerics,
    conformanceRequirements: parseConformanceRequirements(whereClause),
  };
}

function parseConformanceRequirements(whereClause: string): GenericRequirement[] {
  if (whereClause === "") {
    return [];
  }
  const requirements: GenericRequirement[] = [];
  for (const clause of splitTopLevel(whereClause, ",")) {
    const colon = topLevelIndexOf(clause, ":");
    if (colon === -1) {
      continue; // same-type (==) or layout requirement: no witness table
    }
    const subject = clause.slice(0, colon).trim();
    for (const protocol of splitTopLevel(clause.slice(colon + 1), " & ")) {
      requirements.push({ subject, protocol });
    }
  }
  return requirements;
}

// "== infix" → "=="
function stripOperatorFixity(name: string): string {
  return name.replace(/ (?:infix|prefix|postfix)$/, "");
}

function argLabelAndType(item: string): { label: string | null; type: string } {
  const colon = topLevelIndexOf(item, ": ");
  if (colon === -1) {
    return { label: null, type: item.trim() };
  }
  const label = item.slice(0, colon).trim();
  return { label: label === "_" ? null : label, type: item.slice(colon + 2).trim() };
}

export function resolveFunctionSignature(
  signature: SwiftFunctionSignature
): ResolvedFunctionSignature | null {
  const argTypes: Metadata[] = [];
  for (const name of signature.argTypeNames) {
    const metadata = resolveType(name);
    if (metadata === null) {
      return null;
    }
    argTypes.push(metadata);
  }

  let returnType: Metadata | null = null;
  if (signature.returnTypeName !== null) {
    returnType = resolveType(signature.returnTypeName);
    if (returnType === null) {
      return null;
    }
  }

  return { throws: signature.throws, argTypes, returnType };
}

export function resolveType(name: string): Metadata | null {
  if (name.startsWith("__C.")) {
    return resolveObjCType(name);
  }
  const descriptor = findType(name);
  if (descriptor !== null) {
    try {
      return getMetadata(descriptor);
    } catch {
      return null;
    }
  }
  return resolveProtocolExistential(name);
}

// A __C type has no Swift descriptor; resolve it through its `So<len><name>C` (class) or
// `So<len><name>_p` (protocol existential) mangling.
function resolveObjCType(name: string): Metadata | null {
  const ident = name.slice("__C.".length);
  if (!/^[A-Za-z_]\w*$/.test(ident)) {
    return null;
  }
  const prefix = `So${ident.length}${ident}`;
  return resolveMangled(`${prefix}C`) ?? resolveMangled(`${prefix}_p`);
}

function resolveMangled(mangled: string): Metadata | null {
  return resolveTypeByMangledName({ address: Memory.allocUtf8String(mangled), length: mangled.length });
}

function resolveProtocolExistential(name: string): Metadata | null {
  const stripped = name.startsWith("any ") ? name.slice(4).trim() : name;
  const parts = splitTopLevel(stripped, " & ");
  if (parts.length === 0) {
    return null;
  }
  const protocols: ContextDescriptor[] = [];
  for (const part of parts) {
    const protocol = findProtocol(part);
    if (protocol === null) {
      return null;
    }
    protocols.push(protocol);
  }
  return getExistentialTypeMetadata(protocols);
}

export function metadataFor(name: string, typeArguments: Metadata[] = []): Metadata | null {
  if (name === "Swift.Void" || name === "()") {
    return voidMetadata();
  }
  const descriptor = findType(name);
  if (descriptor === null) {
    return null;
  }
  return typeArguments.length > 0
    ? buildGenericMetadata(descriptor, typeArguments)
    : getMetadata(descriptor);
}

let voidMetadataCache: Metadata | null = null;

// The empty tuple ("yt"); not a nominal type, so findType can't reach it.
export function voidMetadata(): Metadata {
  if (voidMetadataCache === null) {
    const mangled = Memory.allocUtf8String("yt");
    const metadata = resolveTypeByMangledName({ address: mangled, length: 2 });
    if (metadata === null) {
      throw new Error("cannot resolve Swift.Void metadata");
    }
    voidMetadataCache = metadata;
  }
  return voidMetadataCache;
}

export interface FunctionTypeSpelling {
  params: string[];
  result: string;
  throws: boolean;
}

// Recognizes a closure/function type spelling like "(Swift.Int) throws -> A"; null otherwise.
export function parseFunctionTypeSpelling(name: string): FunctionTypeSpelling | null {
  const t = name.trim();
  if (!t.startsWith("(")) {
    return null;
  }
  const close = matchingBracket(t, 0);
  if (close === -1) {
    return null;
  }
  const tail = t.slice(close + 1);
  const arrow = topLevelIndexOf(tail, "->");
  if (arrow === -1) {
    return null;
  }
  const inner = t.slice(1, close).trim();
  return {
    params: inner === "" ? [] : splitTopLevel(inner, ","),
    result: tail.slice(arrow + 2).trim(),
    throws: /\b(?:re)?throws\b/.test(tail.slice(0, arrow)),
  };
}

function instantiate(base: string, args: (Metadata | null)[]): Metadata | null {
  const descriptor = findType(base);
  if (descriptor === null || args.some((a) => a === null)) {
    return null;
  }
  try {
    return buildGenericMetadata(descriptor, args as Metadata[]);
  } catch {
    return null;
  }
}

// "fixture.Box<Swift.Int, Swift.String>" → { base: "fixture.Box", arguments: ["Swift.Int", "Swift.String"] };
// an unparameterized name yields no arguments.
export function splitBoundTypeName(name: string): { base: string; arguments: string[] } {
  const lt = topLevelIndexOf(name, "<");
  if (lt === -1 || !name.endsWith(">")) {
    return { base: name, arguments: [] };
  }
  return { base: name.slice(0, lt), arguments: splitTopLevel(name.slice(lt + 1, -1), ",") };
}

// Desugars A? / [A] / [K: V] / Base<...>, resolving each leaf via resolveParam (generics) or findType.
// A leading borrow modifier (init params spell a non-consuming String as `__shared String`) is not
// part of the type and is dropped; __owned/inout are rejected upstream, not here.
export function resolveTypeExpr(
  expr: string,
  resolveParam: (name: string) => Metadata | null
): Metadata | null {
  expr = expr.trim().replace(/^(?:__shared|borrowing)\s+/, "");
  if (expr.endsWith("?") || expr.endsWith("!")) {
    return instantiate("Swift.Optional", [resolveTypeExpr(expr.slice(0, -1), resolveParam)]);
  }
  // `(A) -> B` is a function type, not a tuple: its `)` is not the last character.
  if (expr.startsWith("(") && matchingBracket(expr, 0) === expr.length - 1) {
    return resolveTupleExpr(expr.slice(1, -1), resolveParam);
  }
  if (expr.startsWith("[") && matchingBracket(expr, 0) === expr.length - 1) {
    const inner = expr.slice(1, -1);
    const colon = topLevelIndexOf(inner, ":");
    if (colon !== -1) {
      return instantiate("Swift.Dictionary", [
        resolveTypeExpr(inner.slice(0, colon), resolveParam),
        resolveTypeExpr(inner.slice(colon + 1), resolveParam),
      ]);
    }
    return instantiate("Swift.Array", [resolveTypeExpr(inner, resolveParam)]);
  }
  const lt = topLevelIndexOf(expr, "<");
  if (lt !== -1 && expr.endsWith(">")) {
    const args = splitTopLevel(expr.slice(lt + 1, -1), ",").map((a) =>
      resolveTypeExpr(a, resolveParam)
    );
    return instantiate(expr.slice(0, lt), args);
  }
  return resolveParam(expr) ?? resolveType(expr);
}

// `inner` is a parenthesized body: `()` is Void, a lone unlabelled element is that bare type.
function resolveTupleExpr(
  inner: string,
  resolveParam: (name: string) => Metadata | null
): Metadata | null {
  const parts = splitTopLevel(inner, ",");
  if (parts.length === 0) {
    return voidMetadata();
  }
  const elements: Metadata[] = [];
  for (const part of parts) {
    const colon = topLevelIndexOf(part, ": ");
    const element = resolveTypeExpr(colon === -1 ? part : part.slice(colon + 2), resolveParam);
    if (element === null) {
      return null;
    }
    elements.push(element);
  }
  if (elements.length === 1 && topLevelIndexOf(parts[0], ": ") === -1) {
    return elements[0];
  }
  return getUnlabelledTupleTypeMetadata(elements);
}

export type ParamLayout = "opaque" | "reference";

export const REFERENCE_CONTAINERS = new Set(["Swift.Array", "Swift.Dictionary", "Swift.Set"]);

// Whether a type is address-only where its params are opaque, as in a protocol witness thunk or an
// unspecialized generic: an opaque param is, and so is a value type storing one inline. A tuple
// mentioning one is lowered per element, which a single verdict can't express.
export function hasOpaqueLayout(expr: string, paramLayout: (name: string) => ParamLayout | null): boolean {
  expr = expr.trim().replace(/^(?:__shared|borrowing)\s+/, "");
  if (!isTupleExpr(expr)) {
    return embedsOpaqueParam(expr, paramLayout);
  }
  const elements = tupleElementTypes(expr);
  if (elements.length === 1) {
    return hasOpaqueLayout(elements[0], paramLayout);
  }
  if (elements.some((e) => embedsOpaqueParam(e, paramLayout))) {
    throw new Error(`unsupported tuple with an opaque element: ${expr}`);
  }
  return false;
}

function embedsOpaqueParam(expr: string, paramLayout: (name: string) => ParamLayout | null): boolean {
  if (expr.endsWith("?") || expr.endsWith("!")) {
    return embedsOpaqueParam(expr.slice(0, -1), paramLayout);
  }
  if (expr.startsWith("[") || expr.endsWith(".Type") || parseFunctionTypeSpelling(expr) !== null) {
    return false;
  }
  if (isTupleExpr(expr)) {
    return tupleElementTypes(expr).some((e) => embedsOpaqueParam(e, paramLayout));
  }
  const { base, arguments: args } = splitBoundTypeName(expr);
  if (args.length === 0) {
    return paramLayout(expr) === "opaque";
  }
  if (base === "Swift.Optional") {
    return embedsOpaqueParam(args[0], paramLayout);
  }
  if (REFERENCE_CONTAINERS.has(base) || findType(base)?.kind === ContextDescriptorKind.Class) {
    return false;
  }
  return args.some((a) => embedsOpaqueParam(a, paramLayout));
}

function isTupleExpr(expr: string): boolean {
  return expr.startsWith("(") && matchingBracket(expr, 0) === expr.length - 1;
}

function tupleElementTypes(expr: string): string[] {
  return splitTopLevel(expr.slice(1, -1), ",").map((part) => {
    const colon = topLevelIndexOf(part, ": ");
    return colon === -1 ? part : part.slice(colon + 2).trim();
  });
}

const OPEN: Record<string, string> = { "(": ")", "<": ">", "[": "]" };
const CLOSE = new Set([")", ">", "]"]);

// The `>` in a `->` arrow closes nothing — skipping it keeps function-typed params (closures) intact.
function depthDelta(s: string, i: number): number {
  const ch = s[i];
  if (ch in OPEN) return 1;
  if (CLOSE.has(ch)) return ch === ">" && s[i - 1] === "-" ? 0 : -1;
  return 0;
}

function topLevelIndexOf(s: string, needle: string): number {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (depth === 0 && s.startsWith(needle, i)) {
      return i;
    }
    depth += depthDelta(s, i);
  }
  return -1;
}

function lastTopLevelDot(s: string): number {
  let depth = 0;
  let last = -1;
  for (let i = 0; i < s.length; i++) {
    if (depth === 0 && s[i] === ".") {
      last = i;
    }
    depth += depthDelta(s, i);
  }
  return last;
}

function matchingBracket(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    depth += depthDelta(s, i);
    if (depth === 0) {
      return i;
    }
  }
  return -1;
}

function splitTopLevel(s: string, sep: string): string[] {
  if (s.trim() === "") {
    return [];
  }
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (depth === 0 && s.startsWith(sep, i)) {
      parts.push(s.slice(start, i));
      i += sep.length - 1;
      start = i + 1;
      continue;
    }
    depth += depthDelta(s, i);
  }
  parts.push(s.slice(start));
  return parts.map((p) => p.trim());
}
