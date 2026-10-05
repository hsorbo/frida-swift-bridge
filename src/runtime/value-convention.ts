import { swiftExportsOfTokens } from "./symbol-index.js";
import { demangle } from "./demangle.js";
import { resolveType } from "./symbolication.js";
import { SWIFTCC } from "./swiftcc.js";

export type ValueConvention = "direct" | "indirect";

interface ConventionEvidence {
  convention: ValueConvention;
  passthrough: boolean;
}

interface OwnMember {
  name: string;
  address: NativePointer;
  demangled: string;
}

interface Getter extends OwnMember {
  resultType: string;
}

type RegisterUse = "read" | "written";

type TraceOutcome = "returned" | "trapped" | "unknown";

type Flow =
  | { kind: "next" }
  | { kind: "return" }
  | { kind: "stop" }
  | { kind: "jump" | "call"; target: NativePointer };

interface Constant {
  value: NativePointer;
  loaded: boolean;
}

type Constants = Map<string, Constant>;

interface RegisterAccess {
  read: string[];
  written: string[];
}

interface ArchProbe {
  selfRegister: string;
  asyncContextRegister: string;
  indirectResultRegister: string;
  argumentRegisters: string[];
  calleeSavedRegisters: Set<string>;
  trapMnemonics: Set<string>;
  canonicalRegister(name: string): string;
  isFrameSave(insn: Instruction): boolean;
  quirkyAccess(insn: Instruction): RegisterAccess | null;
  controlFlow(insn: Instruction, constants: Constants): Flow;
  trackConstants(insn: Instruction, constants: Constants): void;
}

// Empty results leave no trace in the result registers; Span-returning getters borrow self by address.
const UNINFORMATIVE_RESULT = /^\(\)$|^Swift\.Never$|\.Type$|Span\b/;
const MAX_INSTRUCTIONS = 256;
const MAX_CALL_DEPTH = 2;
const MAX_PROBED = 8;

const arm64: ArchProbe = {
  selfRegister: SWIFTCC.self,
  asyncContextRegister: SWIFTCC.asyncContext,
  indirectResultRegister: SWIFTCC.indirectResult,
  argumentRegisters: ["x0", "x1", "x2", "x3", "x4", "x5", "x6", "x7", "v0", "v1", "v2", "v3", "v4", "v5", "v6", "v7"],
  calleeSavedRegisters: new Set(["x19", "x20", "x21", "x22", "x23", "x24", "x25", "x26", "x27", "x28"]),
  trapMnemonics: new Set(["brk", "udf", "hlt"]),
  canonicalRegister(name) {
    const match = /^([wxbhsdqv])(\d+)$/.exec(name);
    return match === null ? name : `${"wx".includes(match[1]) ? "x" : "v"}${match[2]}`;
  },
  isFrameSave(insn) {
    return /^st(r|p|ur)$/.test(insn.mnemonic) && /\[(sp|x29)\b/.test(insn.opStr);
  },
  quirkyAccess(insn) {
    // Capstone reports the first operand of the compare aliases as written, and movk as reading its
    // destination although compilers only emit it after a full write.
    if (/^(tst|cmp|cmn|ccmp|ccmn|fcmp|fcmpe|fccmp|fccmpe)$/.test(insn.mnemonic) && !insn.opStr.includes("[")) {
      return { read: registerOperands(insn), written: [] };
    }
    if (insn.mnemonic === "movk") {
      return { read: [], written: (insn as Arm64Instruction).regsAccessed.written };
    }
    return undetailedMoveAccess(insn as Arm64Instruction);
  },
  controlFlow(insn, constants) {
    if (insn.groups.includes("return")) {
      return { kind: "return" };
    }
    const branch = /^(b|bl|br[a-z]*|blr[a-z]*)$/.exec(insn.mnemonic);
    if (branch === null) {
      return insn.groups.includes("call") ? { kind: "stop" } : { kind: "next" };
    }
    const kind = insn.mnemonic.startsWith("bl") ? "call" : "jump";
    const operand = (insn as Arm64Instruction).operands[0];
    if (operand?.type === "imm") {
      return { kind, target: ptr(operand.value.toString()) };
    }
    return operand?.type === "reg" ? resolvedFlow(kind, insn, constants.get(operand.value)) : { kind: "stop" };
  },
  trackConstants(insn, constants) {
    if (!/^(adrp|add|ldr)$/.test(insn.mnemonic) || !/^x\d+,/.test(insn.opStr)) {
      return;
    }
    const [dest, source, addend] = (insn as Arm64Instruction).operands;
    if (dest?.type !== "reg") {
      return;
    }
    let constant: Constant | undefined;
    if (insn.mnemonic === "adrp" && source?.type === "imm") {
      constant = { value: ptr(source.value.toString()), loaded: false };
    } else if (insn.mnemonic === "add" && source?.type === "reg" && addend?.type === "imm") {
      const base = constants.get(source.value);
      constant = base && { value: base.value.add(addend.value.toString()), loaded: base.loaded };
    } else if (insn.mnemonic === "ldr" && source?.type === "mem" && source.value.base !== undefined) {
      const base = constants.get(source.value.base);
      constant = base && !base.loaded ? { value: base.value.add(source.value.disp).readPointer().strip(), loaded: true } : undefined;
    }
    if (constant !== undefined) {
      constants.set(dest.value, constant);
    } else {
      constants.delete(dest.value);
    }
  },
};

const x64: ArchProbe = {
  selfRegister: SWIFTCC.self,
  asyncContextRegister: SWIFTCC.asyncContext,
  indirectResultRegister: SWIFTCC.indirectResult,
  argumentRegisters: ["rdi", "rsi", "rdx", "rcx", "r8", "r9", "xmm0", "xmm1", "xmm2", "xmm3", "xmm4", "xmm5", "xmm6", "xmm7"],
  calleeSavedRegisters: new Set(["rbx", "rbp", "r12", "r13", "r14", "r15"]),
  trapMnemonics: new Set(["ud0", "ud1", "ud2", "int3", "hlt"]),
  canonicalRegister(name) {
    let match = /^r(\d+)[dwb]?$/.exec(name);
    if (match !== null) {
      return `r${match[1]}`;
    }
    match = /^[xyz]mm(\d+)$/.exec(name);
    if (match !== null) {
      return `xmm${match[1]}`;
    }
    match = /^[re]?([abcd])[xlh]$/.exec(name);
    if (match !== null) {
      return `r${match[1]}x`;
    }
    match = /^[re]?(si|di|bp|sp)l?$/.exec(name);
    return match === null ? name : `r${match[1]}`;
  },
  isFrameSave(insn) {
    return insn.mnemonic === "push" || (insn.mnemonic === "mov" && /^qword ptr \[r[sb]p\b/.test(insn.opStr));
  },
  quirkyAccess(insn) {
    if (insn.mnemonic === "push" && insn.opStr === "rax") {
      return { read: [], written: [] };
    }
    const operands = insn.opStr.split(", ");
    const isZeroIdiom =
      /^v?(xor|sub|pxor|xorps|xorpd)$/.test(insn.mnemonic) && operands.length >= 2 && operands.every((o) => o === operands[0]);
    return isZeroIdiom ? { read: [], written: [operands[0]] } : null;
  },
  controlFlow(insn) {
    if (insn.groups.includes("ret")) {
      return { kind: "return" };
    }
    const mnemonic = insn.mnemonic.replace(/^(bnd|notrack) /, "");
    if (mnemonic !== "jmp" && mnemonic !== "call") {
      return insn.groups.includes("call") ? { kind: "stop" } : { kind: "next" };
    }
    const kind = mnemonic === "call" ? "call" : "jump";
    const operand = (insn as X86Instruction).operands[0];
    if (operand?.type === "imm") {
      return { kind, target: ptr(operand.value.toString()) };
    }
    if (operand?.type === "mem" && operand.value.base === "rip" && operand.value.index === undefined) {
      const slot = insn.next.add(operand.value.disp);
      return resolvedFlow(kind, insn, { value: slot.readPointer(), loaded: true });
    }
    return { kind: "stop" };
  },
  trackConstants() {},
};

const ARCH_PROBES: Partial<Record<Architecture, ArchProbe>> = { arm64, x64 };

// Whether a struct crosses its module boundary directly is compiled into its callers, not its
// metadata. A struct self passed indirectly arrives in swiftself, a direct one in the argument
// registers (IRGen hasSelfContextParameter); an indirect result arrives as the sret pointer.
export function probeValueConvention(image: Module, token: string): ValueConvention | null {
  if (ARCH_PROBES[Process.arch] === undefined) {
    return null;
  }
  const fullName = demangledTypeName(token);
  if (fullName === null) {
    return null;
  }
  const members = ownMembers(image, token);
  const passthroughGetters: Getter[] = [];
  for (const getter of instanceGetters(members, fullName).slice(0, MAX_PROBED)) {
    const evidence = guarded(() => classifySelfConvention(getter.address));
    if (evidence?.passthrough === false) {
      return evidence.convention;
    }
    if (evidence !== null) {
      passthroughGetters.push(getter);
    }
  }
  for (const producers of [() => resultProducers(members, fullName), () => foreignResultProducers(image, token, fullName)]) {
    for (const producer of producers().slice(0, MAX_PROBED)) {
      const convention = guarded(() => classifyResultConvention(producer.address));
      if (convention !== null) {
        return convention;
      }
    }
  }
  return passthroughGetters.some((g) => (resolveType(g.resultType)?.valueWitnesses.size ?? 0) > 0) ? "direct" : null;
}

export interface RegisterRange {
  gp: [number, number];
  fp: [number, number];
}

// A small loadable self goes by address in swiftself when the method mutates, else as the last formal
// argument, which pushes the generic arguments into registers a mutating callee never receives.
export function probeSelfOwnership(method: NativePointer, directOnly: RegisterRange): "mutating" | "borrowing" | null {
  const arch = ARCH_PROBES[Process.arch];
  if (arch === undefined) {
    return null;
  }
  const uses = new Map<string, RegisterUse>();
  guarded(() => traceEntryRegisterUses(arch, method, uses, 0, { left: MAX_INSTRUCTIONS }));
  if (uses.get(arch.asyncContextRegister) === "read") {
    return null;
  }
  const fpRegisters = arch.argumentRegisters.filter((r) => /^(v|xmm)\d/.test(r));
  const gpRegisters = arch.argumentRegisters.filter((r) => !fpRegisters.includes(r));
  const directOnlyRegisters = [
    ...gpRegisters.slice(directOnly.gp[0], directOnly.gp[1]),
    ...fpRegisters.slice(directOnly.fp[0], directOnly.fp[1]),
  ];
  const readsSelfRegister = uses.get(arch.selfRegister) === "read";
  const readsDirectOnly = directOnlyRegisters.some((r) => uses.get(r) === "read");
  if (readsSelfRegister === readsDirectOnly) {
    return null;
  }
  return readsSelfRegister ? "mutating" : "borrowing";
}

// A callee built before Swift 6.1 takes a buffer for a loadable typed error in the argument register
// past its formal and generic arguments and stores the error through it; one returning the error in
// the result registers never reads that register. null when the trace cannot tell, or the register
// is on the stack.
export function probeTypedErrorBuffer(fn: NativePointer, slotRegister: number): boolean | null {
  const arch = ARCH_PROBES[Process.arch];
  if (arch === undefined) {
    return null;
  }
  const register = arch.argumentRegisters.filter((r) => !/^(v|xmm)\d/.test(r))[slotRegister];
  if (register === undefined) {
    return null;
  }
  const uses = new Map<string, RegisterUse>();
  const outcome = guarded(() => traceEntryRegisterUses(arch, fn, uses, 0, { left: MAX_INSTRUCTIONS }));
  if (uses.get(register) === "read") {
    return true;
  }
  return outcome === "returned" ? false : null;
}

function demangledTypeName(token: string): string | null {
  return demangle(`$s${token}Mn`)?.replace(/^nominal type descriptor for /, "") ?? null;
}

function ownMembers(image: Module, token: string): OwnMember[] {
  return swiftExportsOfTokens(image, [token])[0].map((e) => ({ ...e, demangled: demangle(e.name) ?? "" }));
}

function instanceGetters(members: OwnMember[], fullName: string): Getter[] {
  const ownGetter = new RegExp(`^${escapeRegExp(fullName)}\\.[^.(]+\\.getter : (.*)$`);
  return members.flatMap((m) => {
    const resultType = m.name.endsWith("vg") ? ownGetter.exec(m.demangled)?.[1] : undefined;
    return resultType !== undefined && !UNINFORMATIVE_RESULT.test(resultType) ? [{ ...m, resultType }] : [];
  });
}

// Throwing and async functions can return without writing a result, or take it elsewhere.
function resultProducers(members: OwnMember[], fullName: string): OwnMember[] {
  const name = escapeRegExp(fullName);
  const producer = new RegExp(`^(static )?${name}\\.[^.(]+\\(.*\\) -> ${name}$|^static ${name}\\.[^.(]+\\.getter : ${name}$`);
  return members.filter((m) => producer.test(m.demangled) && !/ (throws|async)\b/.test(m.demangled));
}

function foreignResultProducers(image: Module, token: string, fullName: string): OwnMember[] {
  const ownPrefix = `$s${token}`;
  const identifier = /\d+[^\d]+[VO]$/.exec(token)?.[0];
  if (identifier === undefined) {
    return [];
  }
  const producer = new RegExp(`(\\) -> |\\.getter : )${escapeRegExp(fullName)}$`);
  return image
    .enumerateExports()
    .filter((e) => e.name.includes(identifier) && !e.name.startsWith(ownPrefix))
    .map((e) => ({ name: e.name, address: e.address, demangled: demangle(e.name) ?? "" }))
    .filter((m) => producer.test(m.demangled) && !/ (throws|async)\b/.test(m.demangled));
}

function guarded<T>(classify: () => T | null): T | null {
  try {
    return classify();
  } catch {
    return null;
  }
}

function classifySelfConvention(getter: NativePointer): ConventionEvidence | null {
  const arch = ARCH_PROBES[Process.arch]!;
  const uses = new Map<string, RegisterUse>();
  const returned = traceEntryRegisterUses(arch, getter, uses, 0, { left: MAX_INSTRUCTIONS }) === "returned";
  if (uses.get(arch.asyncContextRegister) === "read") {
    return null;
  }
  if (uses.get(arch.selfRegister) === "read") {
    return { convention: "indirect", passthrough: false };
  }
  if (arch.argumentRegisters.some((r) => uses.get(r) === "read")) {
    return { convention: "direct", passthrough: false };
  }
  if (returned && !uses.has(arch.indirectResultRegister) && arch.argumentRegisters.every((r) => !uses.has(r))) {
    return { convention: "direct", passthrough: true };
  }
  return null;
}

function classifyResultConvention(producer: NativePointer): ValueConvention | null {
  const arch = ARCH_PROBES[Process.arch]!;
  const uses = new Map<string, RegisterUse>();
  const returned = traceEntryRegisterUses(arch, producer, uses, 0, { left: MAX_INSTRUCTIONS }) === "returned";
  if (uses.get(arch.asyncContextRegister) === "read") {
    return null;
  }
  if (uses.get(arch.indirectResultRegister) === "read") {
    return "indirect";
  }
  return returned ? "direct" : null;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function traceEntryRegisterUses(
  arch: ArchProbe,
  start: NativePointer,
  uses: Map<string, RegisterUse>,
  depth: number,
  budget: { left: number },
): TraceOutcome {
  let cursor = start;
  const constants: Constants = new Map();
  const saved = new Set<string>();
  while (budget.left-- > 0) {
    const insn = Instruction.parse(cursor);
    if (arch.trapMnemonics.has(insn.mnemonic)) {
      return "trapped";
    }
    recordRegisterUses(arch, insn, uses, saved);
    const flow = arch.controlFlow(insn, constants);
    arch.trackConstants(insn, constants);
    switch (flow.kind) {
      case "return":
        return "returned";
      case "stop":
        return "unknown";
      case "jump":
        cursor = flow.target;
        continue;
      case "call": {
        if (depth === MAX_CALL_DEPTH) {
          return "unknown";
        }
        // Past a callee that never returns lies the next function; past an untraced one, the
        // callee may have consumed self or the result pointer unseen.
        const callee = traceEntryRegisterUses(arch, flow.target, uses, depth + 1, budget);
        if (callee !== "returned") {
          return callee;
        }
        for (const r of arch.argumentRegisters) {
          if (!uses.has(r)) {
            uses.set(r, "written");
          }
        }
        break;
      }
    }
    cursor = insn.next;
  }
  return "unknown";
}

// An unbound lazy-binding slot points back into its own image's PLT, whose resolver saves every
// argument register; only a slot already bound to another image is followed.
// -Onone code on x86-64 Darwin calls memset before its first use of self. Like any C function it
// returns with the callee-saved registers intact; it is known by the address imports bind to, which
// Darwin reaches through a resolver stub in the same image.
function resolvedFlow(kind: "jump" | "call", insn: Instruction, constant: Constant | undefined): Flow {
  if (kind === "jump" && constant !== undefined && memoryFills().has(constant.value.strip().toString())) {
    return { kind: "return" };
  }
  const targetImage = constant && Process.findModuleByAddress(constant.value);
  if (!targetImage || (constant!.loaded && targetImage.base.equals(Process.findModuleByAddress(insn.address)?.base ?? NULL))) {
    return { kind: "stop" };
  }
  return { kind, target: constant!.value };
}

let memoryFillAddresses: Set<string> | null = null;

function memoryFills(): Set<string> {
  if (memoryFillAddresses === null) {
    const addresses = Process.platform === "windows" ? [Module.findGlobalExportByName("memset") ?? NULL] : dlsymMemoryFills();
    memoryFillAddresses = new Set(addresses.filter((a) => !a.isNull()).map((a) => a.strip().toString()));
  }
  return memoryFillAddresses;
}

function dlsymMemoryFills(): NativePointer[] {
  const dlsym = new NativeFunction(Module.getGlobalExportByName("dlsym"), "pointer", ["pointer", "pointer"]);
  const defaultHandle = Process.platform === "darwin" ? NULL.sub(2) : NULL;
  return ["memset", "bzero"].map((name) => dlsym(defaultHandle, Memory.allocUtf8String(name)) as NativePointer);
}

// A frame saves each callee-saved register once; storing its entry value again spills it as data
// (-Onone keeps swiftself in a debug slot).
function recordRegisterUses(arch: ArchProbe, insn: Instruction, uses: Map<string, RegisterUse>, saved: Set<string>): void {
  const { read, written } = arch.quirkyAccess(insn) ?? (insn as Arm64Instruction | X86Instruction).regsAccessed;
  const frameSave = arch.isFrameSave(insn);
  for (const r of read.map(arch.canonicalRegister)) {
    if (uses.has(r)) {
      continue;
    }
    if (frameSave && arch.calleeSavedRegisters.has(r) && !saved.has(r)) {
      saved.add(r);
    } else {
      uses.set(r, "read");
    }
  }
  for (const r of written.map(arch.canonicalRegister)) {
    if (!uses.has(r)) {
      uses.set(r, "written");
    }
  }
}

function registerOperands(insn: Instruction): string[] {
  return (insn as Arm64Instruction).operands.flatMap((o) => (o.type === "reg" ? [o.value] : []));
}

// Capstone attaches no register detail to some lane and half-precision moves (smov x8, v0.b[0];
// fmov h0, w8); their destination is the first operand and the sources follow.
function undetailedMoveAccess(insn: Arm64Instruction): RegisterAccess | null {
  const { read, written } = insn.regsAccessed;
  const operands = insn.operands;
  if (read.length > 0 || written.length > 0 || operands.length < 2 || !operands.every((o) => o.type === "reg")) {
    return null;
  }
  return { read: registerOperands(insn).slice(1), written: [operands[0].value] };
}
