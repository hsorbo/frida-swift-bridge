// The printed grammar of swift_demangle output: types, and the function and accessor entity lines
// the bridge reads members from. Every node keeps its spelling, so listings print what the
// demangler printed while the structure is read once.

export type ParamConvention = "borrowed" | "owned" | "inout";

export interface TypeExprParam {
  text: string;
  label: string | null;
  convention: ParamConvention;
  type: TypeExpr;
}

export type TypeExpr =
  | { kind: "nominal"; text: string; name: string; args: TypeExpr[] }
  | { kind: "param"; text: string; name: string }
  | { kind: "member"; text: string; base: TypeExpr; name: string }
  | { kind: "tuple"; text: string; elements: TypeExprParam[] }
  | { kind: "function"; text: string; params: TypeExprParam[]; result: TypeExpr; async: boolean; throws: boolean; attributes: string[] }
  | { kind: "optional"; text: string; wrapped: TypeExpr; implicitlyUnwrapped: boolean }
  | { kind: "metatype"; text: string; instance: TypeExpr; existential: boolean }
  | { kind: "existential"; text: string; members: TypeExpr[] }
  | { kind: "opaque"; text: string; constraint: TypeExpr | null }
  | { kind: "sameType"; text: string; subject: TypeExpr; type: TypeExpr }
  | { kind: "variadic"; text: string; element: TypeExpr }
  | { kind: "pack"; text: string; element: TypeExpr };

// The types a type is spelled from, in order: generic arguments, elements, params then result.
export function childTypes(type: TypeExpr): TypeExpr[] {
  switch (type.kind) {
    case "nominal":
      return type.args;
    case "member":
      return [type.base];
    case "tuple":
      return type.elements.map((e) => e.type);
    case "function":
      return [...type.params.map((p) => p.type), type.result];
    case "optional":
      return [type.wrapped];
    case "metatype":
      return [type.instance];
    case "existential":
      return type.members;
    case "opaque":
      return type.constraint === null ? [] : [type.constraint];
    case "sameType":
      return [type.subject, type.type];
    case "variadic":
    case "pack":
      return [type.element];
    case "param":
      return [];
  }
}

export function mentionsParam(type: TypeExpr, params: string[]): boolean {
  return type.kind === "param" ? params.includes(type.name) : childTypes(type).some((t) => mentionsParam(t, params));
}

export interface GenericRequirement {
  subject: string;
  protocol: string;
}

export interface SwiftFunctionSignature {
  kind: "function";
  context: string;
  name: string;
  genericParams: string[];
  // false when the metadata count differs from genericParams.length: a pack, a shape, or a same-type
  // constraint on a parameter itself (A == B, A == Int); one on an associated type (A.Element == X)
  // leaves every parameter's metadata in place.
  simpleGenerics: boolean;
  async: boolean;
  throws: boolean;
  params: TypeExprParam[];
  result: TypeExpr | null;
  argTypeNames: string[];
  argLabels: (string | null)[]; // null = unlabelled
  returnTypeName: string | null;
  selector: string; // e.g. "greet(name:to:)"
  conformanceRequirements: GenericRequirement[];
  // A constrained extension's context demangles as `P< where A: Q>`; the clauses, context bare.
  contextConstraints: string[];
}

export interface SwiftAccessorSignature {
  kind: "getter" | "setter" | "modify";
  context: string;
  member: string;
  type: TypeExpr;
  typeName: string;
  contextConstraints: string[];
}

export type ParsedSwiftSignature = SwiftFunctionSignature | SwiftAccessorSignature;

const IDENT_START = /[A-Za-z_$ -￿]/;
const IDENT_CHAR = /[A-Za-z0-9_$ -￿]/;
const OPERATOR_CHAR = /[/=\-+!*%<>&|^~?.]/;
const PARAM_NAME = /^[A-Z]{1,2}\d*$/;
const CONVENTIONS: Record<string, ParamConvention> = {
  inout: "inout",
  __owned: "owned",
  consuming: "owned",
  __shared: "borrowed",
  borrowing: "borrowed",
  sending: "borrowed",
  isolated: "borrowed",
};

class ParseError extends Error {}

class Parser {
  pos = 0;

  constructor(readonly s: string) {}

  private peek(offset = 0): string {
    return this.s[this.pos + offset] ?? "";
  }

  private at(text: string): boolean {
    return this.s.startsWith(text, this.pos);
  }

  skipSpaces(): void {
    while (this.peek() === " ") {
      this.pos++;
    }
  }

  private expect(text: string): void {
    if (!this.at(text)) {
      throw new ParseError(`expected ${text} at ${this.pos} in ${this.s}`);
    }
    this.pos += text.length;
  }

  word(word: string): boolean {
    if (this.at(word) && !IDENT_CHAR.test(this.peek(word.length))) {
      this.pos += word.length;
      this.skipSpaces();
      return true;
    }
    return false;
  }

  private identifier(): string {
    const start = this.pos;
    if (!IDENT_START.test(this.peek())) {
      throw new ParseError(`expected an identifier at ${this.pos} in ${this.s}`);
    }
    while (IDENT_CHAR.test(this.peek())) {
      this.pos++;
    }
    return this.s.slice(start, this.pos);
  }

  private text(start: number): string {
    return this.s.slice(start, this.pos).trim();
  }

  type(): TypeExpr {
    const start = this.pos;
    this.skipSpaces();
    const attributes: string[] = [];
    while (this.peek() === "@") {
      const attrStart = this.pos;
      this.pos++;
      this.identifier();
      if (this.peek() === "(") {
        this.balanced();
      }
      attributes.push(this.s.slice(attrStart, this.pos));
      this.skipSpaces();
    }
    if (this.word("any")) {
      const members = this.conjunction();
      return { kind: "existential", text: this.text(start), members };
    }
    if (this.word("some")) {
      const constraint = this.atTypeStart() ? this.postfixed() : null;
      return { kind: "opaque", text: this.text(start), constraint };
    }
    if (this.word("repeat") || this.word("each")) {
      this.word("each");
      const element = this.postfixed();
      return { kind: "pack", text: this.text(start), element };
    }
    const members = this.conjunction();
    if (members.length > 1) {
      return { kind: "existential", text: this.text(start), members };
    }
    const type = members[0];
    if (attributes.length > 0 && type.kind === "function") {
      return { ...type, text: this.text(start), attributes };
    }
    return type;
  }

  private conjunction(): TypeExpr[] {
    const members = [this.postfixed()];
    while (this.at(" & ")) {
      this.pos += 3;
      members.push(this.postfixed());
    }
    return members;
  }

  private atTypeStart(): boolean {
    const ch = this.peek();
    return ch === "(" || ch === "[" || IDENT_START.test(ch);
  }

  private atMetatypeSuffix(): boolean {
    return (this.at(".Type") && !IDENT_CHAR.test(this.peek(5))) || (this.at(".Protocol") && !IDENT_CHAR.test(this.peek(9)));
  }

  private postfixed(): TypeExpr {
    const start = this.pos;
    let type = this.primary();
    for (;;) {
      if (this.peek() === "?") {
        this.pos++;
        type = { kind: "optional", text: this.text(start), wrapped: type, implicitlyUnwrapped: false };
      } else if (this.peek() === "!") {
        this.pos++;
        type = { kind: "optional", text: this.text(start), wrapped: type, implicitlyUnwrapped: true };
      } else if (this.at("...")) {
        this.pos += 3;
        type = { kind: "variadic", text: this.text(start), element: type };
      } else if (this.at(".Type") && !IDENT_CHAR.test(this.peek(5))) {
        this.pos += 5;
        type = { kind: "metatype", text: this.text(start), instance: type, existential: false };
      } else if (this.at(".Protocol") && !IDENT_CHAR.test(this.peek(9))) {
        this.pos += 9;
        type = { kind: "metatype", text: this.text(start), instance: type, existential: true };
      } else {
        return type;
      }
    }
  }

  private primary(): TypeExpr {
    const start = this.pos;
    if (this.peek() === "(") {
      return this.parenthesized();
    }
    if (this.peek() === "[") {
      this.pos++;
      const key = this.type();
      this.skipSpaces();
      let args = [key];
      let name = "Swift.Array";
      if (this.peek() === ":") {
        this.pos++;
        args = [key, this.type()];
        name = "Swift.Dictionary";
        this.skipSpaces();
      }
      this.expect("]");
      return { kind: "nominal", text: this.text(start), name, args };
    }
    return this.path();
  }

  // `(a, b)` is a tuple, `(a) -> b` a function; a lone unlabelled `(a)` is just `a` in parentheses.
  private parenthesized(): TypeExpr {
    const start = this.pos;
    this.expect("(");
    const elements: TypeExprParam[] = [];
    this.skipSpaces();
    while (this.peek() !== ")") {
      elements.push(this.param());
      this.skipSpaces();
      if (this.peek() === ",") {
        this.pos++;
        this.skipSpaces();
      }
    }
    this.expect(")");
    const afterParen = this.pos;
    this.skipSpaces();
    const effects = this.effects();
    if (this.at("->")) {
      this.pos += 2;
      const result = this.type();
      return { kind: "function", text: this.text(start), params: elements, result, ...effects, attributes: [] };
    }
    this.pos = afterParen;
    if (elements.length === 1 && elements[0].label === null && elements[0].convention === "borrowed") {
      return elements[0].type;
    }
    return { kind: "tuple", text: this.text(start), elements };
  }

  private effects(): { async: boolean; throws: boolean } {
    let async = false;
    let throws = false;
    for (;;) {
      if (this.word("async")) {
        async = true;
      } else if (this.word("rethrows")) {
        throws = true;
      } else if (this.word("throws")) {
        throws = true;
        if (this.peek() === "(") {
          this.balanced();
          this.skipSpaces();
        }
      } else {
        return { async, throws };
      }
    }
  }

  // `label: type`, with the demangler's `_:` for an unlabelled argument of a labelled list.
  param(): TypeExprParam {
    this.skipSpaces();
    let label: string | null = null;
    if (IDENT_START.test(this.peek())) {
      const save = this.pos;
      const word = this.identifier();
      if (this.at(": ")) {
        this.pos += 2;
        label = word === "_" ? null : word;
      } else {
        this.pos = save;
      }
    }
    const start = this.pos;
    let convention: ParamConvention = "borrowed";
    for (;;) {
      const save = this.pos;
      if (!IDENT_START.test(this.peek())) {
        break;
      }
      const word = this.identifier();
      if (word in CONVENTIONS && this.peek() === " ") {
        convention = CONVENTIONS[word] === "borrowed" ? convention : CONVENTIONS[word];
        this.skipSpaces();
      } else {
        this.pos = save;
        break;
      }
    }
    const type = this.type();
    return { text: this.text(start), label, convention, type };
  }

  private path(): TypeExpr {
    const start = this.pos;
    const names: string[] = [];
    const args: TypeExpr[] = [];
    for (;;) {
      names.push(this.identifier());
      if (this.peek() === "<") {
        this.pos++;
        for (;;) {
          args.push(this.genericArgument());
          if (this.peek() !== ",") {
            break;
          }
          this.pos++;
        }
        this.expect(">");
      }
      if (this.peek() === "." && IDENT_START.test(this.peek(1)) && !this.atMetatypeSuffix()) {
        this.pos++;
        continue;
      }
      break;
    }
    const text = this.text(start);
    if (names.length === 1 && args.length === 0 && PARAM_NAME.test(names[0])) {
      return { kind: "param", text, name: names[0] };
    }
    if (args.length === 0 && PARAM_NAME.test(names[0])) {
      let base: TypeExpr = { kind: "param", text: names[0], name: names[0] };
      for (let i = 1; i < names.length; i++) {
        base = { kind: "member", text: names.slice(0, i + 1).join("."), base, name: names[i] };
      }
      return base;
    }
    const name = names.join(".");
    if (name === "Swift.Optional" && args.length === 1) {
      return { kind: "optional", text, wrapped: args[0], implicitlyUnwrapped: false };
    }
    return { kind: "nominal", text, name, args };
  }

  // A parameterized existential's primary associated type prints as `Self.P.A == T`.
  private genericArgument(): TypeExpr {
    const start = this.pos;
    const subject = this.type();
    this.skipSpaces();
    if (!this.at("== ")) {
      return subject;
    }
    this.pos += 3;
    const type = this.type();
    this.skipSpaces();
    return { kind: "sameType", text: this.text(start), subject, type };
  }

  // The bracketed text at the cursor, kept as is; the `>` of an arrow closes nothing.
  balanced(): string {
    const start = this.pos;
    let depth = 0;
    do {
      if (this.pos >= this.s.length) {
        throw new ParseError(`unbalanced bracket at ${start} in ${this.s}`);
      }
      const ch = this.s[this.pos];
      if (ch === "(" || ch === "<" || ch === "[") {
        depth++;
      } else if (ch === ")" || ch === "]" || (ch === ">" && this.s[this.pos - 1] !== "-")) {
        depth--;
      }
      this.pos++;
    } while (depth > 0);
    return this.s.slice(start, this.pos);
  }

  atEnd(): boolean {
    this.skipSpaces();
    return this.pos === this.s.length;
  }

  // One segment of an entity path: `name`, `name<A, B where A: P>`, or an operator with its fixity.
  segment(): { name: string; clause: string | null } {
    if (IDENT_START.test(this.peek())) {
      const name = this.identifier();
      const clause = this.peek() === "<" ? this.balanced() : null;
      return { name, clause };
    }
    const start = this.pos;
    while (OPERATOR_CHAR.test(this.peek())) {
      this.pos++;
    }
    const name = this.s.slice(start, this.pos);
    this.skipSpaces();
    if (name === "" || !(this.word("infix") || this.word("prefix") || this.word("postfix"))) {
      throw new ParseError(`expected a name at ${start} in ${this.s}`);
    }
    return { name, clause: null };
  }
}

// A parameter spelling's convention (`inout Swift.Int`) is not part of the type and is dropped.
export function parseTypeExpr(text: string): TypeExpr | null {
  const parser = new Parser(text);
  try {
    const { type } = parser.param();
    return parser.atEnd() ? type : null;
  } catch (e) {
    if (e instanceof ParseError) {
      return null;
    }
    throw e;
  }
}

const EXTENSION_PREFIX = /^((?:static |class )?)\(extension in [^)]+\):/;

export function parseSwiftSignature(demangled: string): ParsedSwiftSignature | null {
  const s = demangled.replace(EXTENSION_PREFIX, "$1");
  try {
    return parseAccessor(s) ?? parseFunction(s);
  } catch (e) {
    if (e instanceof ParseError) {
      return null;
    }
    throw e;
  }
}

interface EntityPath {
  context: string;
  name: string;
  clause: string | null;
  contextConstraints: string[];
}

// `[static |class ]A.B<…>.name<clause>`: the context keeps its receiver keyword, as listings show it.
function parseEntityPath(parser: Parser): EntityPath {
  parser.word("static") || parser.word("class");
  const segments: { start: number; name: string; clause: string | null }[] = [];
  for (;;) {
    const start = parser.pos;
    segments.push({ start, ...parser.segment() });
    if (parser.s[parser.pos] !== ".") {
      break;
    }
    parser.pos++;
  }
  const last = segments.pop()!;
  const outer = segments[segments.length - 1];
  const constrained = outer?.clause?.startsWith("< where ") === true;
  const contextConstraints = constrained ? splitRequirements(outer.clause!.slice("< where ".length, -1)) : [];
  const contextEnd = outer === undefined ? 0 : constrained ? outer.start + outer.name.length : last.start - 1;
  return { context: parser.s.slice(0, contextEnd), name: last.name, clause: last.clause, contextConstraints };
}

function parseAccessor(s: string): SwiftAccessorSignature | null {
  for (const kind of ["getter", "setter", "modify"] as const) {
    const marker = `.${kind} : `;
    const at = s.indexOf(marker);
    if (at === -1) {
      continue;
    }
    const parser = new Parser(s.slice(0, at));
    const { context, name, clause, contextConstraints } = parseEntityPath(parser);
    if (!parser.atEnd() || clause !== null || context === "") {
      return null;
    }
    const typeName = s.slice(at + marker.length).trim();
    const type = parseTypeExpr(typeName);
    if (type === null) {
      return null;
    }
    return { kind, context, member: name, type, typeName, contextConstraints };
  }
  return null;
}

function parseFunction(s: string): SwiftFunctionSignature | null {
  const parser = new Parser(s);
  const { context, name, clause, contextConstraints } = parseEntityPath(parser);
  if (context === "") {
    return null;
  }
  if (parser.s[parser.pos] !== "(") {
    return null;
  }
  const inner = parser.balanced();
  const params = parseParamList(inner.slice(1, -1));
  const tail = s.slice(parser.pos);
  const arrow = tail.indexOf("->");
  if (arrow === -1) {
    return null;
  }
  const effects = tail.slice(0, arrow);
  const returnTypeName = tail.slice(arrow + 2).trim();
  const result = returnTypeName === "()" ? null : parseTypeExpr(returnTypeName);
  if (returnTypeName !== "()" && result === null) {
    return null;
  }
  const { genericParams, simpleGenerics, conformanceRequirements } = parseGenericClause(clause);
  const argLabels = params.map((p) => p.label);
  return {
    kind: "function",
    context,
    name,
    genericParams,
    simpleGenerics,
    async: /\basync\b/.test(effects),
    throws: /\b(?:re)?throws\b/.test(effects),
    params,
    result,
    argTypeNames: params.map((p) => p.text),
    argLabels,
    returnTypeName: returnTypeName === "()" ? null : returnTypeName,
    selector: `${name}(${argLabels.map((l) => `${l ?? "_"}:`).join("")})`,
    conformanceRequirements,
    contextConstraints,
  };
}

function parseParamList(inner: string): TypeExprParam[] {
  const parser = new Parser(inner);
  const params: TypeExprParam[] = [];
  while (!parser.atEnd()) {
    params.push(parser.param());
    parser.skipSpaces();
    if (parser.s[parser.pos] === ",") {
      parser.pos++;
    }
  }
  return params;
}

function parseGenericClause(clause: string | null): {
  genericParams: string[];
  simpleGenerics: boolean;
  conformanceRequirements: GenericRequirement[];
} {
  if (clause === null) {
    return { genericParams: [], simpleGenerics: true, conformanceRequirements: [] };
  }
  const inner = clause.slice(1, -1);
  const where = inner.indexOf(" where ");
  const paramsText = where === -1 ? inner : inner.slice(0, where);
  const whereClause = where === -1 ? "" : inner.slice(where + 7);
  const params = paramsText.split(",").map((p) => p.trim()).filter((p) => p !== "");
  const genericParams = params.map((p) => p.split(/\s+/).pop()!);
  const requirements = splitRequirements(whereClause);
  const fixesParameter = (req: string): boolean =>
    req.includes("==") && req.split("==").some((side) => genericParams.includes(side.trim()));
  return {
    genericParams,
    simpleGenerics: params.every((p) => /^[A-Za-z_]\w*$/.test(p)) && !requirements.some(fixesParameter),
    conformanceRequirements: requirements.flatMap((req) => {
      const colon = req.indexOf(":");
      if (colon === -1) {
        return []; // same-type (==) or layout requirement: no witness table
      }
      const subject = req.slice(0, colon).trim();
      return req.slice(colon + 1).split(" & ").map((protocol) => ({ subject, protocol: protocol.trim() }));
    }),
  };
}

// Requirements are comma separated; a generic bound's own commas sit inside `<…>`.
function splitRequirements(clause: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < clause.length; i++) {
    const ch = clause[i];
    if (ch === "<" || ch === "(" || ch === "[") {
      depth++;
    } else if (ch === ">" || ch === ")" || ch === "]") {
      depth--;
    } else if (ch === "," && depth === 0) {
      parts.push(clause.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(clause.slice(start));
  return parts.map((p) => p.trim()).filter((p) => p !== "");
}
