# Swift bridge API reference

Swift runtime interop from Frida. The bridge reflects the Swift metadata that a
process already carries, so you can look up types, construct and inspect
instances, call methods (sync, async, generic, static), read and write
properties, work with protocols and existentials, pass JavaScript callbacks as
Swift closures, and intercept Swift functions with fully decoded arguments and
return values.

The examples are written against plausible application types (`MyApp.Robot`,
…). The tests under `tests/` exercise the same capabilities against the compiled
fixture in `tests/fixtures/`.

```js
import Swift from "frida-swift-bridge2";

if (Swift.available) {
    const NSDate = Swift.type("Foundation.Date");
    // ...
}
```

`Swift.available` is a side-effect-free presence check: reading it does not load
or initialize `libswiftCore`. Call it before touching any other member.

The package has two entry points. The root (`frida-swift-bridge2`) is the stable
facade documented here. A second subpath, `frida-swift-bridge2/abi`, exposes the
low-level Swift-ABI and reversing machinery; it is version-sensitive and not
covered by this reference — see [Going lower: the `/abi` entry point](#going-lower-the-abi-entry-point).

## Table of contents

1. [The `Swift` object](#the-swift-object)
2. [Finding types](#finding-types)
3. [Types](#types)
4. [Creating instances](#creating-instances)
5. [Objects and values](#objects-and-values)
6. [Calling methods](#calling-methods)
7. [Async and actors](#async-and-actors)
8. [Properties](#properties)
9. [Protocols](#protocols)
10. [Free functions](#free-functions)
11. [Closures](#closures)
12. [Intercepting](#intercepting)
13. [Values and marshalling](#values-and-marshalling)
14. [Errors](#errors)
15. [Ownership and lifetime](#ownership-and-lifetime)
16. [Symbols](#symbols)
17. [Known limitations](#known-limitations)
18. [Going lower: the `/abi` entry point](#going-lower-the-abi-entry-point)

---

## The `Swift` object

The default export is the whole facade. Its members:

- `Swift.available`: a boolean, `true` when a usable Swift runtime is loaded in
  the target. Reading it never loads Swift.
- `Swift.api`: the raw `libswiftCore` runtime functions (`swift_retain`,
  `swift_getTypeName`, …) as typed `NativeFunction`s. An escape hatch; ordinary
  workflows do not need it.
- `Swift.demangle(name)`: turn a mangled Swift symbol into its readable form, or
  `null` if it is not a Swift symbol. See [Symbols](#symbols).
- `Swift.symbolicate(address)`: resolve a code address to a Swift symbol.
- `Swift.images()`: a generator of the native `Module`s that carry Swift
  metadata.
- `Swift.type(name)`: look a type up by name; returns a [type facade](#types)
  or `null`. See [Finding types](#finding-types).
- `Swift.class(name)`, `Swift.struct(name)`, `Swift.enum(name)`: like
  `Swift.type`, but checked to the named kind. See
  [Finding types](#finding-types).
- `Swift.modules`: a lazy namespace per Swift module, so
  `Swift.modules.MyApp.Robot` reaches a type or protocol without a
  module-qualified string. See [Finding types](#finding-types).
- `Swift.enumerateTypes(module?)`, `Swift.enumerateClasses(module?)`,
  `Swift.enumerateStructs(module?)`, `Swift.enumerateEnums(module?)`: lazy
  generators over the types in a module (or every loaded module). Enumerating
  does not realize metadata for types you skip.
- `Swift.enumerateProtocols(module?)`: a generator of [`Protocol`](#protocols)s.
- `Swift.Protocol.find(name)`, `Swift.ProtocolComposition.fromSignature(signature)`:
  look up protocols. See [Protocols](#protocols).
- `Swift.NativeFunction(address, returnType, argTypes, options?)`: wrap a free
  Swift function as a callable. See [Free functions](#free-functions).
- `Swift.function(module, mangledName)`: wrap a Swift function, sync or
  `async`, resolved from its mangled symbol, with its types derived from the
  signature. See [Free functions](#free-functions).
- `Swift.function(qualifiedSelector, options?)`: resolve a type's member from
  its qualified selector, `"Module.Type.member(labels:)"`. See
  [Free functions](#free-functions).
- `Swift.asyncFunction(module, mangledName)`,
  `Swift.asyncFunction(qualifiedSelector, options?)`: the same for an `async`
  function, as an awaitable callable. See [Async and actors](#async-and-actors).
- `Swift.Interceptor`: attach to Swift functions. See
  [Intercepting](#intercepting).
- `Swift.closure(body)`: build a Swift closure from a JS callback. See
  [Closures](#closures).
- `Swift.borrowObject(handle)`, `Swift.adoptObject(handle)`: wrap a raw class
  pointer as an object facade. See [Ownership and lifetime](#ownership-and-lifetime).
- `Swift.markResilient(moduleName)`: treat a module as built with library
  evolution, for one the bridge can't detect as such. See
  [Known limitations](#known-limitations).
- `Swift.markFrozen(typeName)`: treat a struct in a library-evolution module as
  `@frozen`, so it keeps the direct ABI. See [Known limitations](#known-limitations).

```js
if (!Swift.available)
    throw new Error("no Swift runtime here");

for (const image of Swift.images())
    console.log(image.name);

const Date = Swift.type("Foundation.Date");
```

## Finding types

`Swift.type(name)` resolves a **qualified** name (`Module.Type`) to a
[type facade](#types) of the matching kind — a `SwiftClass`, `SwiftStruct` or
`SwiftEnum`. It returns `null` when nothing matches.

```js
const url = Swift.type("Foundation.URLComponents"); // SwiftStruct
const task = Swift.type("_Concurrency.Task");        // null if not loaded
```

A bare, unqualified name is accepted **only** when it resolves uniquely across
the loaded images. If two modules both declare `Point`, the lookup throws rather
than silently guessing:

```js
Swift.type("Point");            // throws: "ambiguous ..."
Swift.type("MyApp.Point");      // resolves
Swift.type("Geometry.Point");   // resolves
```

A generic type named with its type arguments, `Module.Name<Args>`, resolves
to that specialization: its metadata is built, so type methods and `init` can
be called. The type named without arguments is the declaration, whose members
are found and hookable but not callable. Each argument is spelled the same way;
an argument that doesn't resolve makes the whole lookup `null`.

```js
const Keyed = Swift.type("MyApp.Keyed");              // the declaration
const KeyedInt = Swift.type("MyApp.Keyed<Swift.Int>"); // a specialization
KeyedInt.echo(21);                                     // 21
Keyed.echo(21);                                        // throws: needs MyApp.Keyed's type arguments
```

When you know the kind, the singular forms return it precisely typed:
`Swift.class(name)` yields a `SwiftClass`, `Swift.struct(name)` a `SwiftStruct`,
and `Swift.enum(name)` a `SwiftEnum`. Name resolution is identical to
`Swift.type`, and `null` still means "not found" — but a name that resolves to
a different kind throws rather than silently mis-typing:

```js
const url = Swift.struct("Foundation.URL");  // SwiftStruct
Swift.class("Foundation.URL");               // throws: "'Foundation.URL' is struct, not class"
```

Each singular pairs with a generator of the same kind (`class` /
`enumerateClasses`, `struct` / `enumerateStructs`, `enum` / `enumerateEnums`).

`Swift.modules` offers the same lookups as property access, which lets the REPL
tab-complete. `Swift.modules.MyApp` is the namespace of the Swift module
`MyApp`, and its members are that module's top-level types and protocols:

```js
Swift.modules.MyApp.Robot;          // SwiftClass, same as Swift.type("MyApp.Robot")
Swift.modules.MyApp.Greeter;        // Protocol
Swift.modules.Swift.Int;            // SwiftStruct
Swift.modules.MyApp.NoSuchThing;    // undefined
"MyApp" in Swift.modules;           // true
Object.keys(Swift.modules.MyApp);   // ["Robot", "Greeter", ...]
```

Namespaces are keyed by Swift module name, not image name. One image can hold
several statically linked modules, and `libswiftCore` holds the module `Swift`.
Touching `Swift.modules` scans nothing. A lookup reads type sections only until
it finds the name. Listing keys, or looking up a module that doesn't exist,
reads every loaded image's type sections. Printing a namespace (in the REPL, or
through `JSON.stringify`) shows only its names and does not descend into them.
A nested type hangs off its parent, so `Swift.modules.MyApp.Outer.Inner` is
`Swift.type("MyApp.Outer.Inner")`.

To walk a module's types without knowing their names, use the lazy generators.
They yield facades over descriptor-backed reflection and don't parse a type you
never touch:

```js
const app = Process.getModuleByName("MyApp");
for (const cls of Swift.enumerateClasses(app))
    console.log(cls.$type.name);
```

`Swift.enumerateTypes`, `Swift.enumerateClasses`, `Swift.enumerateStructs`, and
`Swift.enumerateEnums` all accept an optional `Module`; with no argument they
span every loaded Swift image and reflect modules loaded later.

## Types

A type has two faces. Its **facade** is the receiver for everything you do
*with* the type: construct instances, call type methods, read static
properties, build enum cases, reach nested types. Its **reflection** describes
the type: name, kind, module, superclass, members, conformances. `Swift.type`,
`Swift.modules` and the enumerators hand out facades; a facade's `$type`, an
object's `$type` and every type link inside reflection are reflection objects.

A facade is a `SwiftClass`, `SwiftStruct` or `SwiftEnum`; all extend
`SwiftTypeFacade`, and the value kinds share `SwiftValueType`. Like an
[object](#objects-and-values), it is a proxy: its Swift members answer to their
bare names, and the bridge's own members are `$`-prefixed so they never collide
with one. `init` is the one bare bridge member, because it names Swift's
initializer.

```js
const Robot = Swift.modules.MyApp.Robot;
Robot.make("Zed");            // type method
Robot.fleetSize;              // static property; assignment writes a static var
Swift.modules.MyApp.Suit.hearts;        // enum case
Swift.modules.MyApp.Pick.value(42);     // enum case with a payload
Swift.modules.MyApp.Outer.Inner;        // nested type
Robot.$type.name;             // "MyApp.Robot", from the reflection
```

A name resolves when it is read, so touching a type scans nothing. A type
method resolves by arity like an object's; the `$typeMethod` and `$get` forms
below take the same names with explicit options. `Object.keys(type)` lists the
defining module's type methods, static properties, cases and nested types; a
member another module or a protocol extension adds resolves by name and joins
the listing once read, while `$type.typeMethods()` and
`$type.instanceMethods()` always span every loaded module. A Swift member
named like a reserved JS method (`toString`, `toJSON`, `valueOf`,
`hasOwnProperty`, `constructor`) stays reachable through `$call` and `$get`.

The facade's own members:

- `type.$type`: the type's reflection, a `ClassType`, `StructType` or
  `EnumType`.
- `type.$get(name)` / `type.$set(name, value)`: read a static property, write a
  static `var`.
- `type.$call(name, ...args)`, `type.init(...args)`: call a type method or an
  initializer by name. See [Calling methods](#calling-methods) and
  [Creating instances](#creating-instances).
- `type.$typeMethod(name, options?)`, `type.$initializer(options?)`: bind one
  member of that kind to call. See [Calling methods](#calling-methods).
- `type.toString()`, `type.toJSON()`: the name, and the cheap identity
  `{ kind, name, module }`.
- On a `SwiftStruct` or `SwiftEnum`: `$new(value)`, `$borrow(address)`,
  `$copy(address)` and `$adopt(address)`. See
  [Creating instances](#creating-instances).
- On a `SwiftEnum`: `$case(name, payload?)`.

### Reflection

Reflection is strict: it has no index signature, so a misspelled member is a
TypeScript error, and no member realizes metadata it doesn't need. Reading a
name, kind or module does not realize the type's metadata; neither does listing
or finding members, which works for a generic type named without its arguments.

Every reflection object extends `SwiftType`:

- `info.name`: the fully-qualified name, including every enclosing context
  (`MyApp.Outer.Inner`).
- `info.kind`: `"class"`, `"struct"`, `"enum"`, `"tuple"`, `"metatype"`,
  `"function"`, `"existential"`, `"objc-class"`, `"foreign-class"` or
  `"foreign-reference"`.
- `info.moduleName`: the logical Swift module name.
- `info.superClass`: the parent's reflection, or `null`.
- `info.toJSON()`: cheap identity `{ kind, name, module }`.

A class, struct or enum is a `NominalType` (`ClassType`, `StructType`,
`EnumType`), which adds the members and the way back to the facade:

- `info.facade`: the type facade.
- `info.instanceMethods(query?)` / `info.typeMethods(query?)`: the selectors
  of its instance methods and of its type methods, e.g. `["greet(_:)", …]`.
  `query` is `{ inherited? }`.
- `info.instanceMethod(name, options?)`, `info.typeMethod(name, options?)`,
  `info.initializer(options?)`: find one member of that kind by name, without
  an instance or type arguments. See [Calling methods](#calling-methods).
- `info.properties`: the properties as `{ name, typeName, isStatic, writable }`.
- `info.protocols()`: a `{ [name]: Protocol }` map of declared conformances.

The lists span every loaded module: they include members that other modules
add in extensions, and members a conformed-to protocol provides through a
protocol extension, stdlib protocols such as `Sequence` included. A constrained extension (`extension P where Self: Base`,
`where Item: Numeric`) contributes only to types that meet its `where` clause,
and its members shadow the same members of a less constrained extension. An
extension whose clause the bridge can't check is left out: one with a same-type
(`==`), `AnyObject`, marker or `@objc` protocol requirement, or with a
requirement on a nested associated type (`Item.Index`).

Kind-specific members:

- `StructType.fields`: stored members as `{ name, type, isVar }`, `type` being
  the field type's reflection.
- `EnumType.cases`: the cases as `{ name, type, isVar }`.
- `ClassType.isActor` / `ClassType.isDefaultActor`: actor classification.

```js
const Robot = Swift.type("MyApp.Robot");
Robot.$type.name;                 // "MyApp.Robot"
Robot.$type.kind;                 // "class"
Robot.$type.moduleName;           // "MyApp"
Robot.$type.instanceMethods();    // ["greet(_:)", "rename(to:)", ...]
Robot.$type.superClass;           // null, or a SwiftType
Robot.$type.facade === Robot;     // true

Swift.type("MyApp.Rect").$type.fields.map(f => f.name);   // ["width", "height"]
Swift.type("MyApp.Suit").$type.cases.map(c => c.name);    // ["hearts", "spades", ...]
Swift.type("MyApp.Session").$type.isActor;                // true for `actor Session`
```

Other reflection you may encounter: `TupleType` (`elements`, each
`{ label, type }`), `MetatypeType` (`instanceType`), `FunctionType`
(`signature`), and the foreign/ObjC bridging wrappers `ObjCClassWrapperType`
(`objcClass`), `ForeignClassType`, `ForeignReferenceType`. These describe types
with no Swift members of their own, so they have no facade.

One type is one reflection object and one facade: `Swift.type`, `Swift.modules`,
an instance's `$type` and `typeOf` under `/abi` all meet at the same objects,
and each specialization of a generic type is its own. Wherever the bridge takes
a type as input (`Swift.NativeFunction`, `typeArguments`, `metadataOf` and
`descriptorOf` under `/abi`), a facade and its reflection are interchangeable.

### Moved members

The reflection split moved these members outright; there are no aliases.

| Before | Now |
| --- | --- |
| `type.$name`, `$kind`, `$moduleName`, `$superClass` | `type.$type.name`, `.kind`, `.moduleName`, `.superClass` |
| `type.$protocols()`, `$properties`, `$fields`, `$cases` | `type.$type.protocols()`, `.properties`, `.fields`, `.cases` |
| `type.$isActor`, `$isDefaultActor` | `type.$type.isActor`, `.isDefaultActor` |
| `type.$instanceMethods()`, `$typeMethods()` | `type.$type.instanceMethods()`, `.typeMethods()` |
| `type.$instanceMethod(name, options?)` | `type.$type.instanceMethod(name, options?)` |
| `tuple.$elements`, `metatype.$instanceType`, `fn.$signature`, `objc.$objcClass` | `.elements`, `.instanceType`, `.signature`, `.objcClass` |
| `object.$className` | `object.$type.name` |
| `object.$instanceMethods`, `$typeMethods` | `object.$type.instanceMethods()`, `.typeMethods()` |
| `ClassType`, `StructType`, `EnumType` as the result of `Swift.type` | `SwiftClass`, `SwiftStruct`, `SwiftEnum`; the old names are the reflection |
| `/abi` `BoundAsyncMethod`, `BoundStaticMethod`, `BoundValueMethod`, `BoundValueInitializer`, `GenericBoundMethod`, `GenericBoundAsyncMethod` | one `BoundMethod` over a `CallPlan`; `isAsync` tells the two apart |
| `/abi` `GenericMethodPlan` | `CallPlan` |
| `ValueType` | gone: `SwiftValueType` is the facade base of struct and enum |

## Creating instances

Construct instances from a type wrapper.

Classes — `SwiftClass.init(...args)` runs a Swift initializer and hands back a
live [object facade](#objects-and-values):

```js
const robot = Swift.type("MyApp.Robot").init("R2");
robot.greet("Alice");   // "Hello Alice, I am R2"
```

Positional arguments select an initializer by arity. To select a **labeled**
initializer, pass a single `{ label: value }` object — the keys map to the
argument labels in order, so the call reads like the Swift original:

```js
Swift.type("MyApp.Vec2").init({ x: 1, y: 2 });            // init(x:y:)
Swift.type("MyApp.Vec2").init({ angle: 1, radius: 2 });   // init(angle:radius:)

const url = Swift.struct("Foundation.URL").init({ string: "https://frida.re" });
```

The object form works on value types too — `init` on a struct or enum runs a
real Swift initializer when its symbol is resolvable, and a failable
initializer that returns nil yields `null`. A lone object whose keys match no
initializer falls back to being a single positional argument, so
dictionary-like arguments still pass through unchanged. For what an object
cannot express — mixed labeled and unlabeled arguments, or overloads that
differ only in argument type — resolve explicitly with
`$initializer({ labels, argTypes })`, which returns a bound initializer to
`.call(...)`.

Value types — `$new(value)` on a `SwiftStruct` or `SwiftEnum` builds a value
from a plain JS object. Enum cases are members of the enum: a case without a
payload is a value, a case with one is called with it.
`SwiftEnum.$case(name, payload?)` is the string-keyed form:

```js
const rect = Swift.type("MyApp.Rect").$new({ width: 3, height: 4 });

const Pick = Swift.type("MyApp.Pick");
const empty = Pick.empty;
const some  = Pick.value(42);
Pick.$case("value", 42);         // the same, by name
```

Value types also offer storage-oriented constructors that mirror the underlying
Swift operations — `$borrow(address)`, `$copy(address)`, `$adopt(address)` —
see [Ownership and lifetime](#ownership-and-lifetime).

To wrap a class pointer you already hold (e.g. from an interceptor or another
call), use `Swift.borrowObject(handle)` for a non-owning view or
`Swift.adoptObject(handle)` to take over an existing +1 reference:

```js
const view = Swift.borrowObject(handle);
view.$type.name;    // "MyApp.Robot"
```

## Objects and values

Both class and value instances are represented by a facade — a JS proxy that
exposes Swift members directly and reserves the whole `$` prefix for its own
controls, so an unknown `$` name reads as `undefined` without a lookup. A
property wrapper's projected value, Swift's own `$`-name, is read with
`$get("$x")`.
`$kind` discriminates the two: `"object"` for classes, `"value"` for
structs/enums.

Swift members are reached by their bare name:

```js
const robot = Swift.type("MyApp.Robot").init("R2");
robot.greet("Alice");   // call a method
robot.name;             // read a property
```

The control surface (never shadowed by Swift members of the same spelling):

- `$type`: [reflection](#reflection) on the dynamic type: a `ClassType` for an
  object, a `StructType` or `EnumType` for a value. Its `name` is the dynamic
  type name, its `instanceMethods()` and `typeMethods()` the selectors, and its
  `facade` the type facade.
- `$handle`: the underlying `NativePointer`.
- `$kind`: `"object"` or `"value"`.
- `$owned`: whether the facade owns its reference/storage.
- `$call(name, ...args)`: invoke a method by name.
- `$method(name, options?)`: resolve a bound method for overload/generic/mutating
  control (see [Calling methods](#calling-methods)).
- `$get(name)` / `$set(name, value)`: read/write a property by name.
- `$field(name)`: a live borrowed [field view](#properties).
- `$container()`: on a value facade wrapping a bridged `Array`/`Set`/`Dictionary`,
  the decoded JS value.
- `$dispose()` and `[Symbol.dispose]()`: release (idempotent); works with `using`.
- `equals(other)`, `toString()`.

```js
robot.$type.name;                       // "MyApp.Robot"
robot.$call("greet", "Alice");          // same as robot.greet("Alice")
robot.$get("badge");                    // "[R2]"
robot.$set("badge", "D2");
robot.equals(Swift.borrowObject(robot.$handle));   // true
```

Because the controls live under `$`, a Swift member literally named `call`,
`field`, or `handle` is still reachable as `robot.call()` while the bridge's own
invoker stays at `robot.$call(...)`.

A bare name reaches members declared anywhere: in the type's own module, in an
extension from another loaded module, or in an extension of a protocol the type
conforms to. The facade looks in the defining module first and searches the
other modules only for a name it did not find there, filtering symbols by name
before demangling anything. Listing a facade (`Object.keys(robot)`, `in`)
shows the defining module's members plus names already looked up; use
`robot.$type.instanceMethods()` for the full list.

## Calling methods

The bare-name and `$call` forms cover the common case and dispatch overloads by
argument count:

```js
robot.at(5);        // calls at(_:)
robot.at(5, 6);     // calls at(_:_:)
```

When bare-name resolution is ambiguous — same arity, different labels; or a
generic method — use `$method(name, options)` to get an explicit bound method.
Options: `arity`, `labels`, `argTypes`, `returnType`, `static`, `typeArguments`,
and (value types only) `self`: `"borrowing"`, `"mutating"` or `"consuming"`,
how the method takes `self`. `argTypes` and `returnType` match the demangled
type names exactly; `returnType: null` selects the overload returning `Void`.

```js
robot.$method("move", { labels: ["to"] }).call(5);   // move(to:)
robot.$method("move", { labels: ["by"] }).call(5);   // move(by:)
robot.$method("pick", { returnType: "Swift.Int" }).call();   // pick() -> Int
```

A bound method has `address`, `call(...)`, and `origin`, which says where the
member was found. A type's own member wins over one another module adds, and
both win over a protocol extension's:

```js
robot.$method("greet").origin;   // { kind: "own", type: "MyApp.Robot", module: "MyApp" }
robot.$method("fly").origin;     // { kind: "extension", type: "MyApp.Robot", module: "Wings" }
robot.$method("tally").origin;   // { kind: "protocolExtension", protocol: "Swift.Sequence", module: "Wings" }
```

`module` is the image's name. An ambiguity error between extensions in
different modules names each overload's module.

Type methods are called on the type wrapper by their bare name, or with
`$call(name, ...args)`; `$typeMethod(name, options)` looks one up as an
explicit bound method:

```js
const Robot = Swift.type("MyApp.Robot");
const made = Robot.make("Zed");
made.greet("X");    // "Hello X, I am Zed"
Robot.$call("make", "Zed");      // the same, by name

const Int = Swift.type("Swift.Int");
Int.$call("*", 6, 7);          // 42: operators are static methods; both operands are arguments
Int.$typeMethod("*").call(6, 7);
```

`$type.instanceMethod(name, options)` finds an instance method through its
type's reflection, without an instance. It has an `address` to hook, and
`bind(instance)` returns the bound method to call:

```js
const greet = Swift.type("MyApp.Robot").$type.instanceMethod("greet");
Swift.Interceptor.attach(greet.address, { /* ... */ });
greet.bind(robot).call("X");    // "Hello X, I am R2"
```

`$type.typeMethod(name, options)` and `$type.initializer(options)` find a type
method or an initializer the same way. They describe the member they find:
`address`, `selector`, `isGeneric` and `origin`, with no receiver and no
`call`. The facade's `$typeMethod` and `$initializer` find the same member and
bind it to call, so a hook target never depends on being able to call it.

Generic methods take their type arguments explicitly as types, facades or
their reflection:

```js
const box = Swift.type("MyApp.Box").init();
box.$method("echo", { typeArguments: [Swift.type("Swift.Int")] }).call(21);   // 21
```

Witness tables for the method's protocol requirements are resolved from the
type arguments. A class-bound parameter (`T: AnyObject`, a superclass, an
Objective-C protocol) is passed as a bare reference, as is `T?` and a closure
result of that type. A pure Objective-C class such as `NSObject` can be a type
argument; its objects are passed and returned as raw pointers.

Value methods, sync or async, work the same whether or not they are
`mutating`; a mutating one writes back into the value:

```js
const acc = Swift.type("MyApp.Accumulator").$new({ total: 5 });
acc.peek(10);    // 15
acc.add(3);      // writes back through self
acc.total;       // 8
```

For a generic method on a small value type (`String`, `Int`, small structs),
and for any method of a small generic value type whose layout doesn't depend on
its type arguments (every stored property is class-bound or non-generic), the
bridge can't pass `self` both ways. It reads the method's code instead: a
mutating method takes `self` through the self register, and a borrowing one
reads the arguments that a trailing `self` pushes further along. When the code
shows neither, the call throws and asks for `{ self: "borrowing" }` or
`{ self: "mutating" }`. An async method's entry never shows it, so async ones
always need the option:

```js
box.$method("echo", { typeArguments: [Swift.type("Swift.Int")], self: "borrowing" }).call(7);
```

A `consuming` method takes ownership of `self` and destroys it. Pass
`{ self: "consuming" }` so the bridge hands it a copy and the value stays usable:

```js
box.$method("take", { self: "consuming" }).call();
```

An `inout` parameter takes a value facade and writes the result back into it. A
`$field` view works too, and writes into its parent:

```js
const n = Swift.type("Swift.Int").$new(21);
robot.doubled(n);        // func doubled(_ n: inout Int)
n.$fields;               // 42
robot.doubled(acc.$field("total"));
```

A consuming (`__owned`) parameter takes any argument; the callee gets its own
copy.

**Sync and async share one call site.** A call returns a decoded value for a
synchronous method and a `Promise` for an `async` one — same syntax, you just
`await` the async case. See [Async and actors](#async-and-actors).

## Async and actors

Awaiting an async method looks exactly like a sync call, with `await`:

```js
const calc = Swift.type("MyApp.AsyncCalc").init(100);
await calc.addAsync(5);     // 105
```

Actor-isolated async methods run on the actor's executor; concurrent calls are
serialized, and state persists between them:

```js
const session = Swift.type("MyApp.Session").init();   // `actor Session`
await session.advance();    // 1
await session.advance();    // 2
```

An `async throws` method rejects its promise on failure:

```js
await calc.divideBaseBy(2);   // 50
await calc.divideBaseBy(0);   // rejects
```

Global-actor and custom-executor actors are handled the same way; the bridge
observes completion regardless of which executor resumes the continuation.

Facade methods are one route to async code. When you hold a **symbol** instead,
`Swift.asyncFunction(module, mangledName)` builds an awaitable callable
directly from it — argument and return types are derived from the demangled
signature, so there is nothing to annotate. A free function is invoked with
`.call(...)`:

```js
const app = Process.getModuleByName("MyApp");

const computeAsync = Swift.asyncFunction(app, "$s5MyApp12computeAsyncyS2iYaF");
await computeAsync.call(21);    // 42
```

An instance method binds its receiver first: `.bind(self)` accepts a Swift
object facade, a raw pointer, or an ObjC object, and returns a plain async
function. Receiver binding is supported for class receivers.

```js
const calc = Swift.type("MyApp.AsyncCalc").init(100);
const addAsync = Swift.asyncFunction(app, "$s5MyApp9AsyncCalcC8addAsyncyS2iYaF").bind(calc);
await addAsync(5);    // 105
```

An `async throws` function rejects its promise with a `SwiftError` (see
[Errors](#errors)); a tuple return decodes to a destructurable array. Misuse
fails fast: a non-async symbol is rejected (use `Swift.function`),
calling an unbound instance method throws, as does binding a receiver to a
free function. Generic async functions and methods of generic types are not
supported.

In TypeScript the wrapper is generic like `NativeFunction<Ret, Args>`: annotate
the marshalled return (and optionally argument) types once and the call site is
typed without casting.

```ts
const makeTuple = Swift.asyncFunction<[Int64, string], [number, number]>(app, MAKE_TUPLE);
const [sum, label] = await makeTuple.call(3, 4);   // Promise<[Int64, string]>
```

The symbol may also be a cross-module extension method on an imported ObjC
class — for example Foundation's `URLSession.data(from:)`. Bind the receiver
from frida-objc-bridge, pass `null` where Swift expects an Optional `.none`,
and an ObjC-class return arrives as a raw pointer ready to wrap in
`ObjC.Object`:

```js
const DATA_FROM =
    "$sSo12NSURLSessionC10FoundationE4data4from8delegateAC4DataV_So13NSURLResponseCtAC3URLV_So0A12TaskDelegate_pSgtYaKF";

const foundation = Process.getModuleByName("Foundation");
const url = Swift.struct("Foundation.URL").init({ string: "https://example.com/" });

const dataFrom = Swift
    .asyncFunction(foundation, DATA_FROM)
    .bind(ObjC.classes.NSURLSession.sharedSession());

const [data, response] = await dataFrom(url, null);
new ObjC.Object(response).statusCode();   // 200
```

## Properties

Stored and computed properties read and write through the bare-name sugar or
`$get` / `$set`:

```js
robot.badge;                // computed getter -> "[R2]"
robot.badge = "D2";         // computed setter, same as robot.$set("badge", "D2")
robot.badge;                // "[D2]"
```

Assigning a property without a setter, or a name that is not a property,
throws.

`type.$type.properties` enumerates the declared members:

```js
Swift.type("MyApp.Robot").$type.properties.map(p => p.name);   // ["name", "badge"]
```

Static properties, including those a protocol extension provides, read through
the type by their bare name or with `$get`; assigning a static `var` runs its
setter, and a `let` or a computed property without one throws:

```js
const Robot = Swift.type("MyApp.Robot");
Robot.fleetSize;              // 12
Robot.$get("fleetSize");      // the same, by name
Robot.fleetSize = 13;
Robot.$set("fleetSize", 13);  // the same, by name
```

For direct access to a stored field's storage, `$field(name)` returns a live
borrowed view with `.read()`, `.write(value)`, and `.handle`. Reads and writes
go through the parent instance's storage:

```js
const f = robot.$field("name");
f.read();           // "R2"
f.write("C3");
robot.greet("X");   // "Hello X, I am C3"
```

A field view is borrowed: its lifetime is bounded by the parent instance. It is
not itself a full facade — for owning/ABI operations on a field value, go
through `/abi`.

## Protocols

`Swift.Protocol.find(name)` looks a protocol up by name and returns `null` when
nothing matches. Name resolution follows the same rules as
[`Swift.type`](#finding-types): a qualified name matches the protocol's full
name, including one nested in a type (`MyApp.Outer.Delegate`), and a bare name
is accepted only when it is unique across the loaded images.

```js
const greeter = Swift.Protocol.find("MyApp.Greeter");
greeter.name;               // "Greeter"
greeter.moduleName;         // "MyApp"
greeter.fullName;           // "MyApp.Greeter"
greeter.isClassOnly;        // false; true for `: AnyObject` protocols

Swift.Protocol.find("Greeter");   // throws if two modules declare Greeter
```

Relate types and protocols in both directions:

```js
Swift.Protocol.find("MyApp.Scalable").conformingTypes().map(t => t.name);   // ["Swift.Int", ...]: reflection

Swift.type("MyApp.Person").$type.protocols();   // { "MyApp.Greeter": Protocol, "MyApp.Aged": Protocol }
```

`ProtocolComposition` models an `any P & Q` existential, built from a signature:

```js
const ga = Swift.ProtocolComposition.fromSignature("MyApp.Greeter & MyApp.Aged");
ga.numProtocols;    // 2
ga.protocols;       // [Protocol, Protocol]
ga.isClassOnly;     // false
```

Requirements, witness tables, and the existential metadata of a composition are
not part of the stable root; they live under [`/abi`](#going-lower-the-abi-entry-point).

Calling a protocol requirement on a concrete instance is just a normal method
call — the facade dispatches through the value's witness. When a function takes
or returns an existential (`any Greeter`), the bridge projects the dynamic value
for you inside [interceptors](#intercepting).

## Free functions

`Swift.NativeFunction(address, returnType, argTypes, options?)` wraps a free
Swift function. `returnType` and each of `argTypes` is a type, as a facade or
its reflection (use `null` as the return type for `Void`). The returned callable marshals JS values in and
decodes the Swift return out:

```js
const Int = Swift.type("Swift.Int");
const addr = Module.getGlobalExportByName("$s5MyApp7addIntsyS2i_SitF");

const addInts = Swift.NativeFunction(addr, Int, [Int, Int]);
addInts(20, 22);    // 42
```

Strings and other non-POD types round-trip:

```js
const String = Swift.type("Swift.String");
const stringLength = Swift.NativeFunction(lenAddr, Int, [String]);
stringLength("frida");    // 5
```

A `Void` function passes `null` as the return type:

```js
const rename = Swift.NativeFunction(renameAddr, null, [Robot, String]);
rename(robot, "new");     // null
```

The only option the stable wrapper accepts is `{ throws: true }` for a Swift
`throws` function (see [Errors](#errors)). Consuming (`__owned`) and `inout`
parameters are handled as for methods when the address has a symbol; without
one, every parameter is assumed to be borrowed. Generics, witness tables, and
other lowering controls are not supported here — reach for the raw primitive
under `/abi` when you need them.

Finding an address is ordinary Frida work: `Module.getGlobalExportByName` with a
mangled symbol, a scan of `module.enumerateExports()` filtered through
`Swift.demangle`, or `Swift.symbolicate` on an address you already have.

When you hold the mangled symbol, `Swift.function(module, mangledName)` looks
it up in `module` and derives the argument and return types, and `throws`,
from the demangled signature, so there is nothing to annotate. A free function
is invoked with `.call(...)`:

```js
const app = Process.getModuleByName("MyApp");

const addInts = Swift.function(app, "$s5MyApp7addIntsyS2i_SitF");
addInts.call(20, 22);     // 42

const mightThrow = Swift.function(app, "$s5MyApp10mightThrowyS2iKF");
mightThrow.call(1);       // throws SwiftError
```

It has the same shape as `Swift.asyncFunction` (see
[Async and actors](#async-and-actors)): an instance method binds a class
receiver with `.bind(self)` and returns a plain function, and the TypeScript
wrapper is generic over the return and argument types. It also accepts an
`async` symbol, whose calls return a `Promise`: sync and async share one call
site, as with methods.

```js
const robot = Swift.type("MyApp.Robot").init("R2");
const greet = Swift.function(app, "$s5MyApp5RobotC5greetyS2SF").bind(robot);
greet("X");               // "Hello X, I am R2"

const computeAsync = Swift.function(app, "$s5MyApp12computeAsyncyS2iYaF");
await computeAsync.call(21);    // 42
```

Generic functions and methods of generic types are rejected; reach for `/abi`
for those. An initializer consumes its arguments, so it is rejected too:
construct through `Swift.type(...).init`.

A type's member can also be named by its qualified selector, the spelling a
demangled symbol prints: `Swift.function("Module.Type.member(labels:)")`. The
type is found by name and the member by the same lookup `$typeMethod` and
`$method` use, so no symbol scan runs. The result follows Swift's own unapplied
method references: a type method is called directly, and an instance method is
an unbound function that takes `self` as its first argument. The second
argument is the usual options object (`{ argTypes }`, `{ returnType }`,
`{ self }`, `{ typeArguments }`); when a type declares a type member and an
instance member with the same selector, `{ static: true }` or
`{ static: false }` picks one. `.address` is hookable whether or not the type
is generic; a call then needs what the member needs.

```js
const robot = Swift.type("MyApp.Robot").init("R2");
Swift.function("MyApp.Robot.move(to:)").call(robot, 5);        // 5
Swift.function("MyApp.Robot.make(name:)").call("R3");          // a Robot

const deriveKey = Swift.function("CryptoKit.HKDF.deriveKey(inputKeyMaterial:outputByteCount:)");
Swift.Interceptor.attach(deriveKey.address, { ... });

await Swift.asyncFunction("MyApp.AsyncCalc.addAsync(_:)").call(calc, 5);   // 105
```

Free module-level functions are not reachable this way yet; use the mangled
form for those.

## Closures

`Swift.closure(body)` turns a JS function into a Swift closure argument. Pass it
where a Swift API expects a closure; the bridge marshals the closure's
parameters into JS and its return value back into Swift.

```js
const source = /* a value or object facade with a closure-taking method */;
source
    .$method("map", { typeArguments: [] })
    .call(7, Swift.closure(n => Number(n) * 6));    // 42
```

Loadable parameters (integers, booleans, pointers, `Double`), `String`, and
buffer-style `(UnsafeRawBufferPointer) -> …` closures are supported. To throw
out of a closure body, return a `SwiftThrow` (exported from
`frida-swift-bridge2/abi`).

> Closure synthesis is platform-specific — it requires an arm64 or x86-64 Swift
> host. On other architectures `Swift.closure` is unavailable.

## Intercepting

`Swift.Interceptor.attach(target, callbacks)` hooks a Swift function and hands
your callbacks the **decoded** Swift arguments and return value — structs
exploded to objects, strings as JS strings, class returns and values holding
references (an Array, say) as live facades, existentials projected to their
dynamic value.

```js
const listener = Swift.Interceptor.attach(addr, {
    onEnter(args) {
        // args: SwiftValue[]
        console.log("addInts", args[0], args[1]);
    },
    onLeave(retval, error) {
        // retval: the decoded return; error is set instead when the call threw
        console.log("=>", retval);
    },
});
// ... later
listener.detach();
```

When the target `throws` and does throw, `onLeave` receives `retval === null`
and the decoded Swift error as its second argument, instead of a bogus return:

```js
Swift.Interceptor.attach(addr, {
    onLeave(retval, error) {
        if (error !== undefined)
            console.log("threw:", error);   // e.g. "boom"
    },
});
```

A method's or accessor's receiver is `this.self` in both callbacks: a facade
for a class, and decoded like an argument for a value. For a mutating method,
`onLeave` sees the updated value:

```js
Swift.Interceptor.attach(acc.$method("add").address, {
    onEnter(args) { console.log("before", this.self.total); },
    onLeave() { console.log("after", this.self.total); },
});
```

A small value type's `self` goes by address when the method mutates it and in
the argument registers otherwise, and the symbol doesn't say which. The bridge
reads the method's code as for [calls](#calling-methods). When the code doesn't
tell, `this.self` is `undefined`. A hook that decodes a generic method's
arguments throws at `attach` instead, because the type arguments come after
`self`. Pass `{ self: "borrowing" | "mutating" }` as a third argument to say
which. `self` is decoded only when read.

`this.typeArguments` names the type arguments of the call in both callbacks: the
enclosing generic type's first, then the function's own, and `[]` when nothing
is generic. A static member of a generic type has no `self`, so this is where
its type's arguments show:

```js
// static HKDF<H>.deriveKey<A1, B1>(inputKeyMaterial:salt:info:outputByteCount:)
Swift.Interceptor.attach(deriveKey, {
    onEnter(args) {
        console.log(this.typeArguments);   // ["CryptoKit.SHA256", "Foundation.Data", "Swift.Array<Swift.UInt8>"]
    },
});
```

A hook on a static member of a generic type doesn't need the mangled name. Every
specialization shares the member's unspecialized code, so the type named without
its arguments still hands out the address. The hook fires for every `H`, and
`this.typeArguments` says which. Calling needs the type arguments, so `call`
throws; name the type with them to call it:

```js
const deriveKey = Swift.struct("CryptoKit.HKDF")
    .$typeMethod("deriveKey", { labels: ["inputKeyMaterial", "outputByteCount"] });

Swift.Interceptor.attach(deriveKey.address, { /* ... */ });
deriveKey.call(key, 32);   // throws: "... needs CryptoKit.HKDF's type arguments"
Swift.struct("CryptoKit.HKDF<CryptoKit.SHA256>").deriveKey(key, 32);   // a SymmetricKey
```

A generic member is found the same way, by `$typeMethod`, `$initializer` or
`$type.instanceMethod`. Calling it through its type throws, so hook it or call
it another way:

```js
// init<D: ContiguousBytes>(data: D)
const initData = Swift.struct("CryptoKit.SymmetricKey").$initializer({ labels: ["data"] });
Swift.Interceptor.attach(initData.address, { /* ... */ });
```

A non-mutating method of a generic struct whose layout doesn't depend on its
type arguments passes `self` by value ahead of them, where the bridge can't find
them. Decoding its arguments throws at `attach`, and reading
`this.typeArguments` throws.

For async functions, `Swift.Interceptor.attachAsync(target, callbacks)` provides
`onEnter(args, context)` (with `this.self` and `this.typeArguments`), `onFirstSuspend()`, and
`onComplete(retval, error?)` (with `this.typeArguments`),
so you observe the real completion after the continuation resumes rather than
the initial suspend. See `tests/async-interceptor.test.ts`.

## Values and marshalling

Swift values cross the boundary as a `SwiftValue`: JS numbers, booleans,
`NativePointer`s, strings, arrays, and plain objects for aggregates. Integer
decoding preserves precision on 64-bit hosts:

- `Int` / `Int64` decode as Frida `Int64`.
- `UInt` / `UInt64` decode as Frida `UInt64`.
- 32-bit and smaller integers decode as JS numbers.

Readers always return the same representation for a given type — never a number
for small values and a wrapper for large ones.

Where Swift expects an `Optional`, JS `null` marshals to `.none`.

```js
addInts(20, 22);    // int64(42), not 42
```

A struct decodes to an object keyed by field name; a bridged `Array`, `Set`, or
`Dictionary` decodes to the corresponding JS value. A container returned from a
call arrives as a value facade; `$container()` projects it:

```js
const ints = Swift.type("MyApp.Bag").$call("ints");   // a value facade
ints.$container();    // [int64(10), int64(20), int64(30)]
```

## Errors

A `throws` free function wrapped with `{ throws: true }` raises a
`SwiftError` (exported from the root) when Swift throws; its `.error`
property is the thrown error's pointer:

```js
import Swift, { SwiftError } from "frida-swift-bridge2";

const mightThrow = Swift.NativeFunction(addr, Int, [Int], { throws: true });
mightThrow(0);    // 99
try {
    mightThrow(1);
} catch (e) {
    e instanceof SwiftError;   // true
}
```

`Swift.function` reads `throws` from the symbol, so it raises the same
`SwiftError` without the option. An `async throws` call — a facade method,
`Swift.function` or `Swift.asyncFunction` — rejects its promise with the same
`SwiftError`.

Inside an [interceptor](#intercepting), a thrown error surfaces as the second
argument to `onLeave` (sync) or `onComplete` (async) instead of a return value.
To throw from a JS-provided [closure](#closures) body, return a `SwiftThrow`
from `/abi`.

## Ownership and lifetime

A facade tracks whether it owns its reference or storage via `$owned`.
Constructing an instance produces an owned facade; borrowing a handle produces a
non-owning view:

```js
const robot = Swift.type("MyApp.Robot").init("R2");
robot.$owned;                               // true
Swift.borrowObject(robot.$handle).$owned;   // false
```

The acquisition names encode the reference contract:

- `Swift.borrowObject(handle)` — a view; does not retain or consume.
- `Swift.adoptObject(handle)` — takes over an existing +1 reference.
- For value types: `$new(value)` initializes owned storage, `$borrow(address)`
  is a non-owning view, `$copy(address)` makes an independent owned copy, and
  `$adopt(address)` takes responsibility for already-initialized storage.

An owned facade releases when it is garbage-collected. To release
deterministically, call `$dispose()` (idempotent) or use a `using` binding:

```js
{
    using tmp = Swift.type("MyApp.Robot").init("scratch");
    tmp.greet("X");
}   // released here
```

Raw `retain`/`release` are deliberately absent from the facade — mismatched
counts cause double releases. Low-level reference-count operations live under
`/abi`.

## Symbols

`Swift.symbolicate(address)` resolves a code address to
`{ address, name, demangled }`, and `Swift.demangle(mangled)` turns a mangled
symbol into its readable Swift form (or `null` for a non-Swift symbol):

```js
const sym = Swift.symbolicate(addr);
sym.demangled;                  // "MyApp.addInts(...) -> ..."
Swift.demangle(sym.name);       // same readable form
```

`isSwiftSymbol(name)` (exported from the root) reports whether a raw symbol is a
Swift mangled name.

## Known limitations

The bridge works from what the process carries: type metadata, witness tables
and symbol names. Some facts about Swift code are not in any of these. Where a
fact is missing, the bridge throws rather than guessing, because a wrong guess
corrupts memory instead of failing cleanly.

**Things you have to state**

- **Whether a generic value-type method is `mutating`.** The mangled name does
  not record it. For a small loadable receiver (`String`, `Int`, small structs),
  it decides whether `self` is passed as a pointer or in registers. Plain
  methods, sync or async, don't need it, because the bridge passes `self` both
  ways, unless an async method's arguments leave `self` no register; for those
  pass `{ self: "borrowing" | "mutating" }` to `$method` (see
  [Calling methods](#calling-methods)). Generic ones (including methods of a
  generic type with a fixed layout) need it only when the bridge can't tell
  from the method's code, which is always the case for async ones. Large
  receivers are unaffected.
- **Whether a value-type method is `consuming`.** The mangled name does not
  record it either, and here the bridge can't detect it and throw: without
  `{ self: "consuming" }`, the callee destroys `self` while the value still owns
  it, which is a double free for any value holding a reference.
- **Generic type arguments.** A JavaScript value does not identify a Swift type
  (`5` could be `Int`, `Int32` or `Double`), so a generic method needs
  `{ typeArguments }`. The one exception: a type parameter that appears only as
  the result of a closure argument is inferred as `Void`.
- **Whether a struct is `@frozen`.** A public struct in a module built with
  library evolution is passed by address unless it is `@frozen`, and `@frozen`
  leaves no trace in metadata or symbols. The bridge reads the convention from
  the struct's own exported code: its getters, and functions that return it.
  When that gives no verdict, and for generic structs, it falls back to the
  module: library evolution is detected from the module's exports and a
  non-frozen enum from its case symbols, and every public struct in such a
  module is treated as resilient. The Swift standard library is the exception:
  nearly all its public structs are `@frozen`, so only its few non-frozen ones
  (`CodingUserInfoKey`, `RangeSet`, `Mirror`, ...) are passed by address. Mark
  frozen structs the bridge misses (e.g.
  `System.FileDescriptor`, which exports no getters) with
  `Swift.markFrozen("Module.Type")`, including frozen structs they store. A
  module whose exports show no sign of library evolution (only structs and
  frozen enums) needs `Swift.markResilient("Module")`.

**Things the bridge cannot recover**

- **Code with no symbol.** Methods and free functions are found by name through
  the export trie and the symbol table. If a binary is stripped and a function
  is not exported, it can't be found by name, and `Swift.symbolicate` returns
  `null` for it. Its address can still be bound through `/abi`.
  This is worse on Linux. In ELF, a struct's memberwise initializers are local
  symbols that disappear with `.symtab`, so a stripped `.so` still has the type
  but not its initializer: `init` throws `no method init`. On Mach-O the same
  initializers are external and survive stripping. `new({ field: value, … })`
  still works, because it writes the fields directly without calling `init`.
- **Code that was never emitted as a function.** Inlined, specialized or
  dead-stripped code has no entry point to call. Hooking a function doesn't see
  call sites where it was inlined.
- **Protocol requirement or extension method.** To decide whether a
  protocol-extension member is a requirement (dispatched through the witness
  table) or an extension method (called directly), the bridge symbolicates the
  witnesses. If it can't, it throws
  `cannot tell whether … is a requirement of …`.
- **Closure captures.** Capture layout comes from the closure's capture
  descriptor. Escaping closures wrapped in a reabstraction thunk are unwrapped
  by their structure. When a capture's type can't be resolved, the bridge
  doesn't expose the captures.

## Going lower: the `/abi` entry point

Everything above is the stable facade. When you need to reverse the Swift ABI
directly — read metadata and context descriptors, walk `__swift5_*` sections,
resolve witness tables, instantiate generic metadata, project enum tags, drive
the raw calling convention, bind witness methods, or work with async task
records — import the second entry point:

```js
import { Metadata, ValueInstance, makeSwiftNativeFunction } from "frida-swift-bridge2/abi";
```

`/abi` is an explicit allowlist of low-level types and helpers. It is
**version-sensitive**: it tracks Swift's internal ABI and is not covered by the
root's compatibility promise. Reach for it only when the stable facade cannot
express what you need, and expect to revisit that code across Swift releases.
This reference does not document `/abi` member by member; read the exports in
`src/abi.ts`.
