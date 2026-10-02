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

guint
conformance_pairs (const gint32 * records, guint count, gconstpointer * pairs, guint capacity)
{
  guint found = 0;
  guint i;

  for (i = 0; i != count; i++)
  {
    const ConformanceDescriptor * conformance = resolve_indirectable (&records[i]);
    gconstpointer protocol, type;

    if (conformance == NULL)
      continue;
    protocol = resolve_indirectable (&conformance->protocol);
    type = conformance_type (conformance);
    if (protocol == NULL || type == NULL)
      continue;
    if (found < capacity)
    {
      pairs[2 * found] = type;
      pairs[2 * found + 1] = protocol;
    }
    found++;
  }

  return found;
}
`;

const RECORD_SIZE = 4;

export interface ConformancePair {
  type: NativePointer;
  protocol: NativePointer;
}

export interface ConformanceScanner {
  handle: CModule;
  pairsOf(section: SwiftSection): ConformancePair[];
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
  const conformancePairs = new NativeFunction(cm.conformance_pairs, "uint", ["pointer", "uint", "pointer", "uint"]);
  return {
    handle: cm,
    pairsOf(section) {
      const count = section.size / RECORD_SIZE;
      const pairs = Memory.alloc(count * 2 * Process.pointerSize);
      const found = conformancePairs(section.address, count, pairs, count);
      const result: ConformancePair[] = [];
      for (let i = 0; i !== found; i++) {
        const at = pairs.add(i * 2 * Process.pointerSize);
        result.push({ type: at.readPointer(), protocol: at.add(Process.pointerSize).readPointer() });
      }
      return result;
    },
  };
}
