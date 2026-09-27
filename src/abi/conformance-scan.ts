import { SwiftSection } from "../image/sections.js";

const code = `#include <glib.h>
#include <ptrauth.h>

typedef struct _ConformanceDescriptor ConformanceDescriptor;

struct _ConformanceDescriptor
{
  gint32 protocol;
  gint32 type_ref;
  gint32 witness_table_pattern;
  guint32 flags;
};

enum
{
  DIRECT_TYPE_DESCRIPTOR,
  INDIRECT_TYPE_DESCRIPTOR,
};

static gconstpointer
resolve_direct (const gint32 * at)
{
  return (*at == 0) ? NULL : (const guint8 *) at + *at;
}

static gconstpointer
resolve_indirectable (const gint32 * at)
{
  gint32 offset = *at;
  const guint8 * address;

  if (offset == 0)
    return NULL;
  address = (const guint8 *) at + (offset & ~1);
  if ((offset & 1) == 0)
    return address;
  return ptrauth_strip (*(gconstpointer const *) address, ptrauth_key_asda);
}

static gconstpointer
conformance_type (const ConformanceDescriptor * conformance)
{
  gconstpointer const * slot;

  switch ((conformance->flags >> 3) & 7)
  {
    case DIRECT_TYPE_DESCRIPTOR:
      return resolve_direct (&conformance->type_ref);
    case INDIRECT_TYPE_DESCRIPTOR:
      slot = resolve_direct (&conformance->type_ref);
      return (slot == NULL) ? NULL : ptrauth_strip (*slot, ptrauth_key_asda);
    default:
      return NULL;
  }
}

static guint
scan (const gint32 * records, guint count, gconstpointer type, gconstpointer protocol,
    gconstpointer * matches, guint capacity)
{
  guint found = 0;
  guint i;

  for (i = 0; i != count; i++)
  {
    const ConformanceDescriptor * conformance = resolve_indirectable (&records[i]);
    gconstpointer conformance_protocol, t;

    if (conformance == NULL)
      continue;
    conformance_protocol = resolve_indirectable (&conformance->protocol);
    t = conformance_type (conformance);
    if (conformance_protocol == NULL || t == NULL)
      continue;
    if (type != NULL && t != type)
      continue;
    if (protocol != NULL && conformance_protocol != protocol)
      continue;
    if (found < capacity)
      matches[found] = (type != NULL) ? conformance_protocol : t;
    found++;
  }

  return found;
}

guint
protocols_of_type (const gint32 * records, guint count, gconstpointer type, gconstpointer * matches,
    guint capacity)
{
  return scan (records, count, type, NULL, matches, capacity);
}

guint
types_of_protocol (const gint32 * records, guint count, gconstpointer protocol, gconstpointer * matches,
    guint capacity)
{
  return scan (records, count, NULL, protocol, matches, capacity);
}
`;

const RECORD_SIZE = 4;

type ScanFunction = NativeFunction<number, [NativePointer, number, NativePointer, NativePointer, number]>;

export interface ConformanceScanner {
  handle: CModule;
  protocolsOf(section: SwiftSection, typeDescriptor: NativePointer): NativePointer[];
  typesOf(section: SwiftSection, protocol: NativePointer): NativePointer[];
}

let scanner: ConformanceScanner | null | undefined;

// Null where unsigned code must not run: gum links a CModule even when it can't make its pages
// executable, so the failure would only surface (or kill the process) on the first call.
export function conformanceScanner(): ConformanceScanner | null {
  if (scanner === undefined) {
    if (Process.codeSigningPolicy === "required") {
      scanner = null;
      return scanner;
    }
    try {
      scanner = compileScanner();
    } catch {
      scanner = null;
    }
  }
  return scanner;
}

function compileScanner(): ConformanceScanner {
  const cm = new CModule(code);
  const signature: [NativeFunctionArgumentType, NativeFunctionArgumentType, NativeFunctionArgumentType,
    NativeFunctionArgumentType, NativeFunctionArgumentType] = ["pointer", "uint", "pointer", "pointer", "uint"];
  const protocolsOfType: ScanFunction = new NativeFunction(cm.protocols_of_type, "uint", signature);
  const typesOfProtocol: ScanFunction = new NativeFunction(cm.types_of_protocol, "uint", signature);
  let capacity = 64;
  let matches = Memory.alloc(capacity * Process.pointerSize);
  const run = (fn: ScanFunction, section: SwiftSection, key: NativePointer): NativePointer[] => {
    const count = section.size / RECORD_SIZE;
    let found = fn(section.address, count, key, matches, capacity);
    if (found > capacity) {
      capacity = found;
      matches = Memory.alloc(capacity * Process.pointerSize);
      found = fn(section.address, count, key, matches, capacity);
    }
    const result: NativePointer[] = [];
    for (let i = 0; i !== found; i++) {
      result.push(matches.add(i * Process.pointerSize).readPointer());
    }
    return result;
  };
  return {
    handle: cm,
    protocolsOf: (section, typeDescriptor) => run(protocolsOfType, section, typeDescriptor),
    typesOf: (section, protocol) => run(typesOfProtocol, section, protocol),
  };
}
