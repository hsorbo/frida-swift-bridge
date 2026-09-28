// Controlled Swift module the bridge introspects in tests. Grown per pillar;
// keep additions minimal and named for what they exercise.

import resilient
import Distributed
import Dispatch

// 4 words: at the calling-convention loadable boundary, but already out-of-line
// for value-buffer storage (> 3 words).
public struct LoadableStruct {
    public let a: Int
    public let b: Int
    public let c: Int
    public let d: Int
}

// A heap-backed String ahead of a narrow int: writing an out-of-range level must be rejected
// before the String is materialized.
public struct Badge {
    public let title: String
    public let level: UInt8
}

// 5 words: passed indirectly by the calling convention, stored out-of-line.
public struct BigStruct {
    public let a: Int
    public let b: Int
    public let c: Int
    public let d: Int
    public let e: Int
}

// Move-only (SE-0390): its VWT sets IsNonCopyable; copy witnesses are illegal.
#if compiler(>=5.9)
public struct NoncopyableStruct: ~Copyable {
    public let a: Int
    public init(a: Int) { self.a = a }
}
#endif

extension LoadableStruct {
    public func dot(_ k: Int) -> Int { (a + b + c + d) * k }
    public func weighted(_ p: Int, _ q: Int, _ r: Int, _ s: Int, _ t: Int, _ u: Int) -> Int {
        a + 10 * b + 100 * c + 1000 * d + 10000 * (p + q + r + s + t + u)
    }
}

extension BigStruct {
    public func total() -> Int { a + b + c + d + e }
}

public func makeLoadableStruct() -> LoadableStruct {
    return LoadableStruct(a: 1, b: 2, c: 3, d: 4)
}

public func makeBigStruct() -> BigStruct {
    return BigStruct(a: 1, b: 2, c: 3, d: 4, e: 5)
}

public func addInts(_ a: Int, _ b: Int) -> Int {
    return a + b
}

public func sumLoadable(_ s: LoadableStruct) -> Int {
    return s.a + s.b + s.c + s.d
}

public func sumBig(_ s: BigStruct) -> Int {
    return s.a + s.b + s.c + s.d + s.e
}

public func makeString() -> String {
    return "New Cairo"
}

public func stringLength(_ s: String) -> Int { s.count }
public func repeatString(_ s: String, _ n: Int) -> Int { s.count * n }
public func renameRobot(_ r: Robot, _ name: String) { r.name = name }

// Nested in a generic-extension context; its extended mangling demangles to Swift.Optional,
// so the full name is Swift.Optional.ExtensionProbe.
extension Optional { public struct ExtensionProbe { public var x: Int } }

// Value-type methods. self routing: mutating/large → x20 pointer; small non-mutating → trailing arg.
public struct Accumulator {
    public var total: Int
    public mutating func add(_ amount: Int) {
        total += amount
    }
    public func peek(_ x: Int) -> Int { total + x }
    public mutating func addEight(_ a: Int, _ b: Int, _ c: Int, _ d: Int, _ e: Int, _ f: Int, _ g: Int, _ h: Int) {
        total += a + b + c + d + e + f + g + h
    }
    public func peekAsync(_ x: Int) async -> Int {
        await Task.yield()
        return total + x
    }
    public mutating func depositAsync(_ amount: Int) async {
        await Task.yield()
        total += amount
    }
    public func describe(_ prefix: String) -> String { "\(prefix): \(total)" }
    public static func zero() -> Accumulator { Accumulator(total: 0) }
    public static func summing(_ a: Int, _ b: Int) -> Int { a + b }
    public static func sumStaticAsync(_ a: Int, _ b: Int) async -> Int {
        await Task.yield()
        return a + b
    }
}

public struct Ledger {
    public var entry: Accumulator
    public var id: Int
}

// Nested type; full name fixture.Outer.Inner.
public struct Outer {
    public var tag: Int
    // Protocols nested in types need SE-0404.
#if compiler(>=5.10)
    public protocol Marker {}
#endif
    public struct Inner {
        public var value: Int
        public func doubled() -> Int { value * 2 }
    }
}

// Nested type declared in an extension; full name fixture.Outer.FromExt.
extension Outer {
    public struct FromExt {
        public var mark: Int
        public func tripled() -> Int { mark * 3 }
    }
}

public enum FixtureError: Error {
    case boom
}

public func mightThrow(_ code: Int) throws -> Int {
    if code != 0 {
        throw FixtureError.boom
    }
    return 99
}

public func scaleDouble(_ x: Double) -> Double {
    return x * 2
}

public func scaleFloat(_ x: Float) -> Float {
    return x * 2
}

public func combine(_ i: Int, _ d: Double) -> Double {
    return Double(i) + d
}

public struct Point {
    public var x: Int
    public var doubled: Int { x * 2 }
    public var tracked: Int {
        get { x }
        _modify { yield &x }
    }
}

public struct Rect {
    public var width: Int
    public var scaled: Int {
        get { width * 2 }
        set { width = newValue / 2 }
    }
}

public struct Ranged {
    public var lo: Int
    public var hi: Int
    public init(lo: Int) { self.lo = lo; self.hi = lo }
    public init(lo: Int, hi: Int) { self.lo = lo; self.hi = hi }
}

// A computed property whose type is generic (`Int?`): its accessor spells the type as
// `Swift.Optional<Swift.Int>`, which only a desugaring type resolver can resolve.
public struct Halver {
    public var n: Int
    public var half: Int? { n % 2 == 0 ? n / 2 : nil }
}

public final class Gadget {
    public var value: Int
    public init(value: Int) { self.value = value }
}

public struct Line {
    public var start: Point
    public var end: Point
}

private let keyPathPointXValue: AnyKeyPath = \Point.x
private let keyPathPointDoubledValue: AnyKeyPath = \Point.doubled
private let keyPathRectScaledValue: AnyKeyPath = \Rect.scaled
private let keyPathGadgetValueValue: AnyKeyPath = \Gadget.value
private let keyPathLineEndXValue: AnyKeyPath = \Line.end.x

public func keyPathPointX() -> UnsafeRawPointer { unsafeBitCast(keyPathPointXValue, to: UnsafeRawPointer.self) }
public func keyPathPointDoubled() -> UnsafeRawPointer { unsafeBitCast(keyPathPointDoubledValue, to: UnsafeRawPointer.self) }
public func keyPathRectScaled() -> UnsafeRawPointer { unsafeBitCast(keyPathRectScaledValue, to: UnsafeRawPointer.self) }
public func keyPathGadgetValue() -> UnsafeRawPointer { unsafeBitCast(keyPathGadgetValueValue, to: UnsafeRawPointer.self) }
public func keyPathLineEndX() -> UnsafeRawPointer { unsafeBitCast(keyPathLineEndXValue, to: UnsafeRawPointer.self) }

// A reabstracted (function-typed) stored property can't be a direct-offset component, so it lowers
// to a computed component keyed by stored-property index (idKind storedPropertyIndex); label stays a
// plain byte-offset stored component.
public struct Handler {
    public var action: () -> Int
    public var label: String
}
private let keyPathHandlerActionValue: AnyKeyPath = \Handler.action
private let keyPathHandlerLabelValue: AnyKeyPath = \Handler.label
public func keyPathHandlerAction() -> UnsafeRawPointer { unsafeBitCast(keyPathHandlerActionValue, to: UnsafeRawPointer.self) }
public func keyPathHandlerLabel() -> UnsafeRawPointer { unsafeBitCast(keyPathHandlerLabelValue, to: UnsafeRawPointer.self) }

// Class analogue of Handler: a reabstracted stored property on a class also lowers to a
// storedPropertyIndex computed component, this time with a class container.
public final class Sink {
    public var onEvent: () -> Int
    public var count: Int
    public init(onEvent: @escaping () -> Int, count: Int) { self.onEvent = onEvent; self.count = count }
}
private let keyPathSinkOnEventValue: AnyKeyPath = \Sink.onEvent
public func keyPathSinkOnEvent() -> UnsafeRawPointer { unsafeBitCast(keyPathSinkOnEventValue, to: UnsafeRawPointer.self) }

// A subscript keypath captures its index into the computed component's argument buffer; two paths
// with the same index compare equal through the argument witnesses, a different index does not.
private let keyPathArrayIndex2Value: AnyKeyPath = \Array<Int>[2]
private let keyPathArrayIndex2AgainValue: AnyKeyPath = \Array<Int>[2]
private let keyPathArrayIndex5Value: AnyKeyPath = \Array<Int>[5]
public func keyPathArrayIndex2() -> UnsafeRawPointer { unsafeBitCast(keyPathArrayIndex2Value, to: UnsafeRawPointer.self) }
public func keyPathArrayIndex2Again() -> UnsafeRawPointer { unsafeBitCast(keyPathArrayIndex2AgainValue, to: UnsafeRawPointer.self) }
public func keyPathArrayIndex5() -> UnsafeRawPointer { unsafeBitCast(keyPathArrayIndex5Value, to: UnsafeRawPointer.self) }

// Protocol-requirement keypaths lower to a vtableOffset computed component; start() precedes
// speed/wheels so their negated-index id is non-zero and steps over the interposed setter.
public protocol Vehicle {
    func start()
    var speed: Int { get set }
    var wheels: Int { get }
}
public struct Car: Vehicle {
    public var speed: Int
    public let wheels: Int
    public init(speed: Int, wheels: Int) { self.speed = speed; self.wheels = wheels }
    public func start() {}
}
private let keyPathVehicleSpeedValue: AnyKeyPath = \Vehicle.speed
private let keyPathVehicleWheelsValue: AnyKeyPath = \Vehicle.wheels
private let keyPathNamedLabelValue: AnyKeyPath = \Named.label
public func keyPathVehicleSpeed() -> UnsafeRawPointer { unsafeBitCast(keyPathVehicleSpeedValue, to: UnsafeRawPointer.self) }
public func keyPathVehicleWheels() -> UnsafeRawPointer { unsafeBitCast(keyPathVehicleWheelsValue, to: UnsafeRawPointer.self) }
public func keyPathNamedLabel() -> UnsafeRawPointer { unsafeBitCast(keyPathNamedLabelValue, to: UnsafeRawPointer.self) }
public func vehicleType() -> UnsafeRawPointer { unsafeBitCast((any Vehicle).self as Any.Type, to: UnsafeRawPointer.self) }

// Generic value args pass indirectly; wrappers drive them so the hook side can observe a call.
@inline(never)
public func genericIdentity<T>(_ x: T) -> T {
    return x
}

public func makeGenericInt() -> Int {
    return genericIdentity(7)
}

public func makeGenericStruct() -> LoadableStruct {
    return genericIdentity(LoadableStruct(a: 5, b: 6, c: 7, d: 8))
}

@inline(never)
public func genericFirst<A, B>(_ a: A, _ b: B) -> A {
    return a
}

public func makeGenericPair() -> Int {
    return genericFirst(11, "ignored")
}

@inline(never)
public func genericDoubled<T>(_ xs: [T]) -> [T] {
    return xs + xs
}

public func makeGenericDoubled() -> Int {
    return genericDoubled([3, 4]).count
}

public final class Cell<T> {
    public let value: T
    public init(_ value: T) { self.value = value }
}

@inline(never)
public func genericCellIdentity<T>(_ cell: Cell<T>) -> Cell<T> {
    return cell
}

public func makeGenericCell() -> Int {
    return genericCellIdentity(Cell(5)).value
}

// Constrained generic: the requirement dispatches through the appended witness table.
public protocol Scalable {
    func scaled(by factor: Int) -> Int
}

extension Int: Scalable {
    public func scaled(by factor: Int) -> Int { self * factor }
}

extension Scalable {
    public func scaledTwice() -> Int { scaled(by: 2) }
    public func scaledTwice(_ factor: Int) -> Int { scaled(by: factor * 2) }
    public func scaledTwice(by factor: Int) -> Int { scaled(by: factor * 2) + 1 }
}
public struct NarrowScalar: Scalable {
    public var n: Int
    public func scaled(by factor: Int) -> Int { n * factor }
}

@inline(never)
public func scaleGeneric<T: Scalable>(_ x: T, by factor: Int) -> Int {
    return x.scaled(by: factor)
}

// Generic instance methods: self in x20, generic args indirect, type metadata + witness tables trail the args.
public final class Box {
    public init() {}
    public func echo<T>(_ x: T) -> T { x }
    public func pick<A, B>(_ a: A, _ b: B) -> A { a }
    public func scaled<T: Scalable>(_ x: T, by k: Int) -> Int { x.scaled(by: k) }
    // [T] is a fixed-layout buffer (direct); T? is address-only in the generic callee (indirect).
    public func tripled<T>(_ x: T) -> [T] { [x, x, x] }
    public func roundOpt<T>(_ x: T?) -> T? { x }
    // Non-generic [Int] param: opaque to the JS writers, so a high-level call must byte-copy the Value.
    public func sumInts(_ xs: [Int]) -> Int { xs.reduce(0, +) }
    // A non-POD (Wrapper) prefix ahead of a second arg: a failure marshalling the second must not
    // leak the first's temp. Covers the sync-generic, async-generic, and plain-async marshalling paths.
    public func mix<T>(_ w: Wrapper, _ x: T) -> Int { w.a }
    public func mixAsync<T>(_ w: Wrapper, _ x: T) async -> Int { await Task.yield(); return w.a }
    public func combineAsync(_ w: Wrapper, _ x: Int) async -> Int { await Task.yield(); return w.a + x }
}

public func firstGeneric<T>(_ xs: [T]) -> T { xs[0] }

// Array return: a non-POD struct backed by a Builtin.BridgeObject (Opaque), adopted not decoded.
public struct Bag {
    public static func ints() -> [Int] { [10, 20, 30] }
    public static func strings() -> [String] { ["a", "bb", "ccc"] }
    public static func empty() -> [Int] { [] }
    public static func intSet() -> Set<Int> { [3, 1, 2] }
    public static func intMap() -> [Int: Int] { [1: 100, 2: 200] }
}

// Generic methods on a value receiver: small explodes self as a trailing arg, the 5-Int receiver
// exceeds the loadable budget and passes self in x20. scaledBy folds self + arg + witness.
public struct SmallGenericBox {
    public var base: Int
    public func echo<T>(_ x: T) -> T { x }
    public func scaledBy<T: Scalable>(_ x: T, _ k: Int) -> Int { base + x.scaled(by: k) }
}
public struct BigGenericBox {
    public var a: Int; public var b: Int; public var c: Int; public var d: Int; public var e: Int
    public func scaledBy<T: Scalable>(_ x: T, _ k: Int) -> Int { a + b + c + d + e + x.scaled(by: k) }
}

// Methods on a generic *type*: a value type hands its instantiated Self metadata as the lone trailing
// arg (the callee derives T's metadata + Scalable witness from it); self rides indirectly in x20.
// stored() returns the type param T (address-only). WideScalar makes the box exceed loadable.
public struct WideScalar: Scalable {
    public var a: Int; public var b: Int; public var c: Int; public var d: Int; public var e: Int
    public func scaled(by factor: Int) -> Int { (a + b + c + d + e) * factor }
}
public struct ConstrainedBox<T: Scalable> {
    public var value: T
    public func scaledStored(by k: Int) -> Int { value.scaled(by: k) }
    public func stored() -> T { value }
    public func scaledStoredAsync(by k: Int) async -> Int { value.scaled(by: k) }
    public func storedAsync() async -> T { value }
    public func pick() -> T { value }
    public func pick() -> Int { -1 }
}

public func makeScaleGeneric() -> Int {
    return scaleGeneric(6, by: 7)
}

// store* fills a caller buffer (no by-value existential return); *Type exposes the unnameable
// existential metadata.
public func storeAnyInt(_ p: UnsafeMutableRawPointer) {
    p.assumingMemoryBound(to: Any.self).initialize(to: 42)
}

public func storeAnyBig(_ p: UnsafeMutableRawPointer) {
    p.assumingMemoryBound(to: Any.self).initialize(to: BigStruct(a: 1, b: 2, c: 3, d: 4, e: 5))
}

public protocol Greeter {
    func greet() -> String
}

public struct PoliteGreeter: Greeter {
    public let name: String
    public func greet() -> String { "Hello, \(name)" }
}

public func storeGreeter(_ p: UnsafeMutableRawPointer) {
    p.assumingMemoryBound(to: (any Greeter).self).initialize(to: PoliteGreeter(name: "Ada"))
}

public func makeOpaqueGreeter() -> some Greeter {
    PoliteGreeter(name: "Ada")
}

public struct Pair<T> {
    public var first: T
    public var second: T
}
extension Pair: Greeter where T: Greeter {
    public func greet() -> String { "\(first.greet()) & \(second.greet())" }
}

public protocol Named: AnyObject {
    var label: String { get }
}

public final class Widget: Named {
    public let label: String
    public init(label: String) { self.label = label }
}

public func storeNamed(_ p: UnsafeMutableRawPointer) {
    p.assumingMemoryBound(to: (any Named).self).initialize(to: Widget(label: "Bee"))
}

public func makeNamed(_ label: String) -> any Named { Widget(label: label) }

public struct CodedError: Error {
    public let code: Int
}

public func storeError(_ p: UnsafeMutableRawPointer) {
    p.assumingMemoryBound(to: (any Error).self).initialize(to: CodedError(code: 7))
}

public enum Pick {
    case empty
    case value(Int)
    public static func tag(_ n: Int) -> Int { n * 2 }
}

public final class Counter {
    public var count: Int
    public init(count: Int) { self.count = count }
}

public func makeCounter(_ n: Int) -> Counter { Counter(count: n) }

public final class ThrowingGadget {
    public let id: Int
    public init(_ id: Int) throws {
        if id < 0 { throw FixtureError.boom }
        self.id = id
    }
}

public final class FailableGadget {
    public let id: Int
    public init?(_ id: Int) {
        if id < 0 { return nil }
        self.id = id
    }
}

public final class Vec2 {
    public let a: Int
    public let b: Int
    public init(x: Int, y: Int) { self.a = x; self.b = y }
    public init(angle: Int, radius: Int) { self.a = angle * 2; self.b = radius * 3 }
}

public class Base { public let kind: Int; public init(kind: Int) { self.kind = kind } }
public final class Derived: Base { public init() { super.init(kind: 99) } }
public func makeDerivedAsBase() -> Base { Derived() }

public class Creature {
    public var legs: Int
    public init(legs: Int) { self.legs = legs }
}
public final class Pup: Creature {
    public var name: String
    public init(name: String, legs: Int) { self.name = name; super.init(legs: legs) }
}

@inline(never)
public func roundOptional<A>(_ x: A?) -> A? { x }
public func triggerRoundOptional() -> Int { roundOptional(Optional<Int>.some(9)) ?? -1 }

public final class Token {
    public let id: Int
    public init(id: Int) { self.id = id }
}
// token + 4 Ints = 40 bytes > MAX_LOADABLE → passed indirectly, and non-POD (holds a class ref).
public struct Wrapper {
    public var token: Token
    public var a: Int
    public var b: Int
    public var c: Int
    public var d: Int
}
extension Wrapper {
    public static func make(_ t: Token) -> Wrapper { Wrapper(token: t, a: 1, b: 2, c: 3, d: 4) }
}
// A non-POD (Wrapper) init parameter ahead of a scalar: a scalar marshalling failure must not leak
// the copied Wrapper temp.
public struct Keeper {
    public var w: Wrapper
    public var tag: Int
    public init(_ w: Wrapper, tag: Int) { self.w = w; self.tag = tag }
}
// A consuming class init parameter: the stored token needs an owning +1 added before transfer.
public struct TokenBox {
    public var token: Token
    public var tag: Int
    public init(_ token: Token, tag: Int) { self.token = token; self.tag = tag }
}
// Class analogue of Keeper/TokenBox, plus a class-valued var for the +1 setter path.
public final class Kennel {
    public var w: Wrapper
    public var occupant: Token
    public init(_ w: Wrapper, occupant: Token) { self.w = w; self.occupant = occupant }
}
extension TokenBox {
    public consuming func take() -> Int { token.id }
}
extension Wrapper {
    public consuming func take() -> Int { token.id }
}
public func makeToken(_ id: Int) -> Token { Token(id: id) }
public func makeWrapper(_ t: Token) -> Wrapper { Wrapper(token: t, a: 1, b: 2, c: 3, d: 4) }
@inline(never)
public func consumeWrapper(_ w: __owned Wrapper) -> Int { w.token.id }

// A non-consuming init param demangles as `init(name: __shared Swift.String)`; resolving it exercises
// the borrow-modifier strip in the arg-type resolver.
public struct SharedName {
    public let length: Int
    public init(name: __shared String) { length = name.count }
}

public struct DoublePair { public var x: Double; public var y: Double }
public func makeDoublePair() -> DoublePair { DoublePair(x: 1.5, y: 2.5) }
public func sumDoublePair(_ p: DoublePair) -> Double { p.x + p.y }

public struct DoubleQuad {
    public var a: Double; public var b: Double; public var c: Double; public var d: Double
    public mutating func shiftAsync(_ da: Double, _ db: Double, _ dc: Double, _ dd: Double, _ scale: Double) async {
        await Task.yield()
        a = (a + da) * scale; b = (b + db) * scale; c = (c + dc) * scale; d = (d + dd) * scale
    }
}
public func makeDoubleQuad() -> DoubleQuad { DoubleQuad(a: 1, b: 2, c: 3, d: 4) }
public func sumDoubleQuad(_ q: DoubleQuad) -> Double { q.a + q.b + q.c + q.d }

public struct FloatPair { public var u: Float; public var v: Float }
public func makeFloatPair() -> FloatPair { FloatPair(u: 1.25, v: 3.75) }
public func sumFloatPair(_ p: FloatPair) -> Float { p.u + p.v }

// Enough arguments to overflow the argument registers onto the caller's stack. The narrow types
// probe per-scalar slot sizes: TaggedInt lowers to (i8, i64, i1).
public struct TaggedInt { public var tag: Int8; public var value: Int; public var flag: Bool }
public func spillInts(_ a0: Int, _ a1: Int, _ a2: Int, _ a3: Int, _ a4: Int, _ a5: Int,
                      _ split: LoadableStruct, _ flag: Bool, _ tagged: TaggedInt, _ small: Int32,
                      _ last: Int) -> Int {
    a0 + split.d + (flag ? 1 : 0) + tagged.value + Int(small) + last
}
public func driveSpillInts() -> Int {
    spillInts(1, 2, 3, 4, 5, 6, LoadableStruct(a: 7, b: 8, c: 9, d: 10), true,
              TaggedInt(tag: 11, value: 12, flag: true), -13, 14)
}
public func spillDoubles(_ i0: Int, _ i1: Int, _ i2: Int, _ i3: Int, _ i4: Int, _ i5: Int, _ i6: Int,
                         _ d0: Double, _ d1: Double, _ d2: Double, _ d3: Double, _ d4: Double,
                         _ d5: Double, _ d6: Double, _ split: DoublePair, _ f: Float, _ h: Float,
                         _ s: String, _ g: Double) -> Double {
    Double(i0) + d0 + split.y + Double(f) + Double(h) + Double(s.count) + g
}
public func driveSpillDoubles() -> Double {
    spillDoubles(1, 2, 3, 4, 5, 6, 7, 0.5, 1.5, 2.5, 3.5, 4.5, 5.5, 6.5,
                 DoublePair(x: 7.5, y: 8.5), 9.25, 10.75, "hi", 11.5)
}

// Int128 lowers to one i128: a register pair that never starts at x7, else a 16-byte-aligned stack
// slot. PaddedInt128 lowers to (i64, i128); its padding word takes no register.
#if compiler(>=6.0)
@available(macOS 15, iOS 18, *)
public struct PaddedInt128 { public var head: Int; public var wide: Int128 }
@available(macOS 15, iOS 18, *)
public func spillInt128(_ padded: PaddedInt128, _ a0: Int, _ a1: Int, _ a2: Int, _ a3: Int,
                        _ wide: Int128, _ flag: Bool, _ wider: Int128, _ last: Int) -> Int {
    padded.head + a3 + Int(truncatingIfNeeded: wide >> 64) + (flag ? 1 : 0)
        + Int(truncatingIfNeeded: wider) + last
}
@available(macOS 15, iOS 18, *)
public func driveSpillInt128() -> Int {
    spillInt128(PaddedInt128(head: 1, wide: Int128(2) << 64 | 3), 4, 5, 6, 7, Int128(8) << 64 | 9,
                true, Int128(10) << 64 | 11, 12)
}
#endif

public func boxAnyInt(_ n: Int) -> Any { n }
public func unboxAnyInt(_ x: Any) -> Int { x as! Int }
public func makeGreeterExistential() -> any Greeter { PoliteGreeter(name: "Ada") }
public func greetExistential(_ g: any Greeter) -> String { g.greet() }

public protocol Aged { var age: Int { get } }
public struct Person: Greeter, Aged {
    public let name: String
    public let age: Int
    public func greet() -> String { "Hi, \(name)" }
}
public func makeGreeterAged() -> any Greeter & Aged { Person(name: "Cy", age: 9) }
public func describeGreeterAged(_ v: any Greeter & Aged) -> String { "\(v.greet()) (\(v.age))" }

public final class LoudGreeter: Greeter {
    public let name: String
    public init(name: String) { self.name = name }
    public func greet() -> String { "HEY \(name)" }
}
public struct GreeterBox {
    public static func wrap(_ g: LoudGreeter) -> any Greeter { g }
    public static func wrapPerson(_ name: String, _ age: Int) -> any Greeter { Person(name: name, age: age) }
}

// describe() and badge have defaults; displayName never does.
public protocol Labeled {
    var displayName: String { get }
    func describe() -> String
    var badge: String { get }
}
extension Labeled {
    public func describe() -> String { "<\(displayName)>" }
    public var badge: String { "[\(displayName)]" }
    public func shout() -> String { displayName.uppercased() }
    public var initial: String { String(displayName.prefix(1)) }
}
public struct DefaultDescriber: Labeled {
    public let displayName: String
}
public struct CustomDescriber: Labeled {
    public let displayName: String
    public func describe() -> String { "custom:\(displayName)" }
}

// HiddenRanked's witness is internal, so a stripped build names it on no arch.
public protocol Ranked {
    func rank() -> Int
}
extension Ranked {
    public func rank() -> Int { 0 }
}
public struct DefaultRanked: Ranked {}
struct HiddenRanked: Ranked {
    let n: Int
    func rank() -> Int { n }
}

public protocol Vocal {
    func speak() -> String
}
public class BaseSpeaker: Vocal {
    public init() {}
    public func speak() -> String { "base" }
}
public final class SubSpeaker: BaseSpeaker {
    public override init() { super.init() }
    public override func speak() -> String { "sub" }
}
extension Vocal {
    public func speakTwice() -> String { speak() + speak() }
}

public protocol Squawker: AnyObject {
    func squawk() -> String
}
public class BaseSquawker: Squawker {
    public init() {}
    public func squawk() -> String { "base" }
}
public final class SubSquawker: BaseSquawker {
    public override init() { super.init() }
    public override func squawk() -> String { "sub" }
}
extension Squawker {
    public func squawkTwice() -> String { squawk() + squawk() }
}

// The extension's choose() shares the requirement's selector but is not its default.
public protocol Chooser {
    func choose() -> Int
}
extension Chooser {
    public func choose() -> String { "ext" }
}
public struct IntChooser: Chooser {
    public var n: Int
    public func choose() -> Int { n }
}

public protocol Perchable {
    func chirp() -> String
}
public class Perch {
    public init() {}
}
public final class PerchedBird: Perch, Perchable {
    public let call: String
    public init(call: String) {
        self.call = call
        super.init()
    }
    public func chirp() -> String { call }
}
public struct FreeBird: Perchable {
    public let wingspan: Int
    public func chirp() -> String { "caw" }
}
public protocol Banded {
    var band: Int { get }
}
public struct BandedBird: Perchable, Banded {
    public let band: Int
    public func chirp() -> String { "peep" }
}
public protocol Songbird: Perchable {}
public struct Lark: Songbird {
    public let pitch: Int
    public func chirp() -> String { "la" }
}
extension Perchable where Self: Perch {
    public func perchedChirp() -> String { "perched " + chirp() }
}
extension Perchable where Self: Banded {
    public func bandedChirp() -> String { "\(band):" + chirp() }
    public var bandLabel: String { "#\(band)" }
    public func greeting() -> String { "banded hello " + chirp() }
    public var tag: String { "banded" }
}
extension Perchable where Self: Songbird {
    public func song() -> String { chirp() + chirp() }
}
extension Perchable {
    public func greeting() -> String { "hello " + chirp() }
    public var tag: String { "plain" }
}

public class Rookery: Perchable {
    public init() {}
    public func chirp() -> String { "caw" }
}
public final class Rook: Rookery {}
extension Perchable where Self: Rookery {
    public func rookeryChirp() -> String { "rookery " + chirp() }
}

public protocol Nocturnal: AnyObject {}
public final class Nightjar: Perchable, Nocturnal {
    public init() {}
    public func chirp() -> String { "churr" }
}
extension Perchable where Self: Nocturnal {
    public func nightChirp() -> String { "night " + chirp() }
}

open class Coop<Hen> {
    public init() {}
}
public final class HenCoop: Coop<Int>, Perchable {
    public func chirp() -> String { "cluck" }
}
extension Perchable where Self: Coop<Int> {
    public func coopChirp() -> String { "coop " + chirp() }
}

#if canImport(ObjectiveC)
import ObjectiveC
public final class Starling: NSObject, Perchable {
    public func chirp() -> String { "whistle" }
}
extension Perchable where Self: NSObject {
    public func objcChirp() -> String { "objc " + chirp() }
}
#endif

public protocol Roosting {
    func roostHeight() -> Int
}
#if compiler(>=5.10)
public struct Aviary {
    public protocol Aerie {
        func aerieHeight() -> Int
    }
}
extension Roosting where Self: Aviary.Aerie {
    public func totalHeight() -> Int { roostHeight() * 10 + aerieHeight() }
}
public struct Kestrel: Roosting, Aviary.Aerie {
    public let perch: Int
    public func roostHeight() -> Int { perch }
    public func aerieHeight() -> Int { 3 }
}
#endif

public protocol Nest {
    associatedtype Egg
    var egg: Egg { get }
}
public struct IntNest: Nest {
    public let egg: Int
}
public struct WordNest: Nest {
    public let egg: String
}
extension Nest where Egg: BinaryInteger {
    public func eggCount() -> Int { Int(egg) * 2 }
}

public protocol Container {
    associatedtype Item
    var item: Item { get }
}
public struct IntBox: Container {
    public let item: Int
    public init(item: Int) { self.item = item }
}

public protocol ConstrainedContainer {
    associatedtype Item: Scalable
    var item: Item { get }
}
public struct ScalableBox: ConstrainedContainer {
    public let item: WideScalar
    public init(item: WideScalar) { self.item = item }
}

// Witness getters whose types depend on Item: address-only at protocol level unless the
// wrapper stays loadable for any element (Array) or the leaf is class-constrained.
public struct Tagged<T> {
    public var inner: T
    public var tag: Int
}
public protocol ItemSource {
    associatedtype Item
    var tagged: Tagged<Item> { get set }
    var maybe: Item? { get set }
    var items: [Item] { get }
}
public struct IntSource: ItemSource {
    public var value: Int
    public init(value: Int) { self.value = value }
    public var tagged: Tagged<Int> {
        get { Tagged(inner: value, tag: 2) }
        set { value = newValue.inner * newValue.tag }
    }
    public var maybe: Int? {
        get { value }
        set { value = newValue ?? -1 }
    }
    public var items: [Int] { [value, value] }
}

public protocol Pack: AnyObject {
    associatedtype Pet: AnyObject
    var leader: Self { get }
    var pet: Pet { get }
}
public final class TokenPack: Pack {
    public let pet: Token
    public init(pet: Token) { self.pet = pet }
    public var leader: TokenPack { self }
}

// Method invocation: String/labelled/void/static methods, a class arg, an arity overload, a computed property.
public final class Robot {
    public var name: String
    public init(name: String) { self.name = name }
    public func greet(_ who: String) -> String { "Hello \(who), I am \(name)" }
    public func rename(to newName: String) { name = newName }
    public static func make(name: String) -> Robot { Robot(name: name) }
    public func merged(with other: Robot) -> String { "\(name)+\(other.name)" }
    public func absorb(_ other: __owned Robot) -> String { other.name }
    public func alias() -> any Named { Widget(label: name) }
    public func at(_ x: Int) -> Int { x }
    public func at(_ x: Int, _ y: Int) -> Int { x + y }
    public func move(to step: Int) -> Int { step }
    public func move(by step: Int) -> Int { step * 10 }
    public func tagged(_ x: Int) -> String { "int:\(x)" }
    public func tagged(_ x: String) -> String { "str:\(x)" }
    public func pick() -> Int { 7 }
    public func pick() -> String { "seven" }
    public func pick() { name = "picked" }
    public var badge: String {
        get { "[\(name)]" }
        set { name = newValue }
    }
}

// Members named exactly like the facade's own raw spellings. The facade reserves its surface under
// $-prefixes ($handle/$get/$call/$field), so these bare Swift members stay reachable, not shadowed.
public final class Clash {
    public var handle: Int
    public init(handle: Int) { self.handle = handle }
    public func get() -> String { "got \(handle)" }
    public func call() -> Int { handle * 2 }
    public func field() -> Int { handle + 100 }
}

// Non-final so pub/hidden get vtable slots; hidden is internal (absent from the export trie).
public class Dispatcher {
    public init() {}
    public func pub(_ x: Int) -> Int { x + 1 }
    func hidden(_ x: Int) -> Int { x * 3 }
}

// Generic class: Self metadata (hence T's metadata + Scalable witness) is recovered from the instance
// isa, so its methods take no trailing type args. Still trips readVTable's not-fixed-offset guard.
public class GenericHolder<T: Scalable> {
    public var value: T
    public init(value: T) { self.value = value }
    public func stored() -> T { value }
    public func scaledStored(by k: Int) -> Int { value.scaled(by: k) }
    public func storedAsync() async -> T { value }
    public func scaledStoredAsync(by k: Int) async -> Int { value.scaled(by: k) }
}
public func makeHolder(_ n: Int) -> GenericHolder<Int> { GenericHolder(value: n) }
public final class LabeledHolder: GenericHolder<Int> {
    public let label: String
    public init(value: Int, label: String) { self.label = label; super.init(value: value) }
}
public func makeLabeledHolder(_ n: Int) -> LabeledHolder { LabeledHolder(value: n, label: "L") }

// Inheritance + live polymorphic dispatch. Animal is non-final so speak/legs take vtable slots;
// Cat overrides speak (filling Animal's slot in Cat's metadata) and inherits legs unchanged.
public class Animal {
    public init() {}
    public func speak() -> Int { 1 }
    public func legs() -> Int { 4 }
}
public final class Cat: Animal {
    public override init() { super.init() }
    public override func speak() -> Int { 9 }
}

public func describeAnimal(_ a: Animal) -> Int { a.legs() }

// Subclassing ResilientBase cross-module sets hasResilientSuperclass on ConcreteSub itself.
public final class ConcreteSub: ResilientBase {
    public var extra: Int
    public init(tag: Int, extra: Int) {
        self.extra = extra
        super.init(tag: tag)
    }
    public override func greeting() -> String { "sub" }
}
public func makeConcreteSub(_ tag: Int, _ extra: Int) -> ConcreteSub {
    ConcreteSub(tag: tag, extra: extra)
}

// Metatype argument in a generic: `T.Type` lowers to a single metadata pointer (loadable, one GP).
@inline(never)
public func metatypeIdentity<T>(_ t: T.Type, _ x: T) -> T { x }
public func makeMetatypeInt() -> Int { metatypeIdentity(Int.self, 5) }

public func anyType() -> UnsafeRawPointer { unsafeBitCast(Any.self as Any.Type, to: UnsafeRawPointer.self) }
public func greeterType() -> UnsafeRawPointer { unsafeBitCast((any Greeter).self as Any.Type, to: UnsafeRawPointer.self) }
public func greeterAgedType() -> UnsafeRawPointer { unsafeBitCast((any Greeter & Aged).self as Any.Type, to: UnsafeRawPointer.self) }
public func namedType() -> UnsafeRawPointer { unsafeBitCast((any Named).self as Any.Type, to: UnsafeRawPointer.self) }
public func errorType() -> UnsafeRawPointer { unsafeBitCast((any Error).self as Any.Type, to: UnsafeRawPointer.self) }

#if canImport(CoreGraphics)
import CoreGraphics
public func foreignClassType() -> UnsafeRawPointer { unsafeBitCast(CGColor.self, to: UnsafeRawPointer.self) }
#endif

#if canImport(ObjectiveC)
import ObjectiveC
public final class ObjCConformer: NSObject {}
public struct ObjCProtocolBox<T: NSObjectProtocol> {
    public var value: T
}
#endif

public protocol Holder<Item> {
    associatedtype Item
    var item: Item { get }
}
public struct IntHolder: Holder {
    public var item: Int
    public init(item: Int) { self.item = item }
}
public func holderIntType() -> UnsafeRawPointer { unsafeBitCast((any Holder<Int>).self as Any.Type, to: UnsafeRawPointer.self) }
public func storeHolderInt(_ p: UnsafeMutableRawPointer) {
    p.assumingMemoryBound(to: (any Holder<Int>).self).initialize(to: IntHolder(item: 42))
}
public func makeHolderInt() -> any Holder<Int> { IntHolder(item: 42) }
public func holderMetatypeType() -> UnsafeRawPointer {
    unsafeBitCast((any Holder<Int>.Type).self as Any.Type, to: UnsafeRawPointer.self)
}
public func storeHolderMetatype(_ p: UnsafeMutableRawPointer) {
    let v: any Holder<Int> = IntHolder(item: 42)
    p.assumingMemoryBound(to: (any Holder<Int>.Type).self).initialize(to: type(of: v))
}

public protocol Ref<T>: AnyObject {
    associatedtype T
    var value: T { get }
}
public final class IntRef: Ref {
    public let value: Int
    public init(_ value: Int) { self.value = value }
}
public func refIntType() -> UnsafeRawPointer { unsafeBitCast((any Ref<Int>).self as Any.Type, to: UnsafeRawPointer.self) }
public func storeRefInt(_ p: UnsafeMutableRawPointer) {
    p.assumingMemoryBound(to: (any Ref<Int>).self).initialize(to: IntRef(7))
}

open class HashedBox<Key: Hashable> {
    public init() {}
}
public func hashedBoxHolderType() -> UnsafeRawPointer {
    unsafeBitCast((any HashedBox<Int> & Holder<String>).self as Any.Type, to: UnsafeRawPointer.self)
}

public protocol Consumable: ~Copyable {}
public func noncopyableConsumableType() -> UnsafeRawPointer {
    unsafeBitCast((any Consumable & ~Copyable).self, to: UnsafeRawPointer.self)
}

// Method-name rendering: an operator and a generic return.
public struct Selectors {
    public var n: Int
    public init(n: Int) { self.n = n }
    public static func == (lhs: Selectors, rhs: Selectors) -> Bool { lhs.n == rhs.n }
    public func echo<T>(_ x: T) -> T { x }
}

// Closure-taking helpers: a JS callback marshalled as a Swift thick closure and invoked by Swift.
// Plain arm64 (blr, no ptrauth) like the rest of this fixture; the arm64e/blraa authentication path
// lives in arm64e.swift, exercised out-of-suite.
public func invokeWithBytes(_ base: UnsafeRawPointer, _ count: Int, _ body: (UnsafeRawBufferPointer) -> Void) {
    body(UnsafeRawBufferPointer(start: base, count: count))
}

public func invokeGeneric<R>(_ base: UnsafeRawPointer, _ count: Int, _ body: (UnsafeRawBufferPointer) throws -> R) rethrows {
    _ = try body(UnsafeRawBufferPointer(start: base, count: count))
}

public func invokeReturning<R>(_ base: UnsafeRawPointer, _ count: Int, _ body: (UnsafeRawBufferPointer) throws -> R) rethrows -> R {
    return try body(UnsafeRawBufferPointer(start: base, count: count))
}

public func invokeMapping(_ n: Int, _ body: (Int) -> Int) -> Int {
    return body(n)
}

public func invokeCombine(_ a: Int, _ b: Int, _ body: (Int, Int) -> Int) -> Int {
    return body(a, b)
}

public func invokePredicate(_ n: Int, _ body: (Int) -> Bool) -> Bool {
    return body(n)
}

public func invokeScale(_ x: Double, _ body: (Double) -> Double) -> Double {
    return body(x)
}

public func invokeThrowing(_ n: Int, _ body: (Int) throws -> Bool) rethrows -> Bool {
    return try body(n)
}

public func invokeProducing<R>(_ n: Int, _ body: (Int) -> R) -> R {
    return body(n)
}

public func invokeI32(_ n: Int32, _ body: (Int32) -> Int32) -> Int32 {
    return body(n)
}

public func invokeRawPtr(_ p: UnsafeRawPointer, _ body: (UnsafeRawPointer) -> UnsafeRawPointer) -> UnsafeRawPointer {
    return body(p)
}

public struct ByteSource {
    let base: UnsafeRawPointer
    let count: Int
    public func withBytes<R>(_ body: (UnsafeRawBufferPointer) throws -> R) rethrows -> R {
        return try body(UnsafeRawBufferPointer(start: base, count: count))
    }
    public func eachByte(_ body: (UnsafeRawBufferPointer) -> Void) {
        body(UnsafeRawBufferPointer(start: base, count: count))
    }
    public func run(_ body: () -> Void) {
        body()
    }
    public func apply(_ n: Int, _ body: (Int) -> Int) -> Int {
        return body(n)
    }
    public func check(_ n: Int, _ body: (Int) -> Bool) -> Bool {
        return body(n)
    }
    public func produce<R>(_ n: Int, _ body: (Int) -> R) -> R {
        return body(n)
    }
    public func mapI32(_ n: Int32, _ body: (Int32) -> Int32) -> Int32 {
        return body(n)
    }
    public func tryCheck(_ n: Int, _ body: (Int) throws -> Bool) rethrows -> Bool {
        return try body(n)
    }
    public func mapStr(_ s: String, _ body: (String) -> String) -> String {
        return body(s)
    }
    public func strLen(_ s: String, _ body: (String) -> Int) -> Int {
        return body(s)
    }
    public func label(_ n: Int, _ body: (Int) -> String) -> String {
        return body(n)
    }
}

var escapingBody: (() -> Void)?
public func storeEscaping(_ body: @escaping () -> Void) { escapingBody = body }
public func fireEscaping() { escapingBody?() }
public func releaseEscaping() { escapingBody = nil }

var capturingBody: (Int) -> Int = { $0 }
public func storeCapturing(_ x: Int) {
    let suffix = "-fixture"
    capturingBody = { y in x + y + suffix.count }
}
public func capturingContext() -> UnsafeMutableRawPointer {
    return withUnsafePointer(to: &capturingBody) { p in
        UnsafeRawPointer(p).load(fromByteOffset: MemoryLayout<Int>.size, as: UnsafeMutableRawPointer.self)
    }
}
public func invokeCapturing(_ y: Int) -> Int { capturingBody(y) }

var structCapturingBody: () -> Int = { 0 }
public func storeStructCapturing(_ a: Int, _ b: Int, _ c: Int, _ d: Int) {
    let s = LoadableStruct(a: a, b: b, c: c, d: d)
    structCapturingBody = { s.a + s.b + s.c + s.d }
}
public func structCapturingContext() -> UnsafeMutableRawPointer {
    return withUnsafePointer(to: &structCapturingBody) { p in
        UnsafeRawPointer(p).load(fromByteOffset: MemoryLayout<Int>.size, as: UnsafeMutableRawPointer.self)
    }
}

var classCapturingBody: () -> Int = { 0 }
public func storeClassCapturing(_ kind: Int) {
    let t = Base(kind: kind)
    classCapturingBody = { t.kind }
}
public func classCapturingContext() -> UnsafeMutableRawPointer {
    return withUnsafePointer(to: &classCapturingBody) { p in
        UnsafeRawPointer(p).load(fromByteOffset: MemoryLayout<Int>.size, as: UnsafeMutableRawPointer.self)
    }
}

var mixedCapturingBody: () -> Int = { 0 }
public func storeMixedCapturing(_ flagValue: Int, _ n: Int, _ kind: Int) {
    let flag = flagValue != 0
    let t = Base(kind: kind)
    mixedCapturingBody = { (flag ? 1 : 0) + n + t.kind }
}
public func mixedCapturingContext() -> UnsafeMutableRawPointer {
    return withUnsafePointer(to: &mixedCapturingBody) { p in
        UnsafeRawPointer(p).load(fromByteOffset: MemoryLayout<Int>.size, as: UnsafeMutableRawPointer.self)
    }
}

public enum Tint { case red, green, blue }
public enum OwnerSlot { case primary(Base), backup(Base) }

var spareBitsCapturingBody: () -> Int = { 0 }
public func storeSpareBitsCapturing(_ kind: Int, _ n: Int) {
    let owner = Base(kind: kind)
    let flag: Bool? = true
    let tint = Tint.blue
    let slot = OwnerSlot.backup(owner)
    let count: Int? = n
    let last = true
    spareBitsCapturingBody = {
        guard owner.kind > 0, flag == true, tint == .blue, case .backup = slot else { return 0 }
        return (count ?? 0) + (last ? 1 : 0)
    }
}
public func spareBitsCapturingContext() -> UnsafeMutableRawPointer {
    return withUnsafePointer(to: &spareBitsCapturingBody) { p in
        UnsafeRawPointer(p).load(fromByteOffset: MemoryLayout<Int>.size, as: UnsafeMutableRawPointer.self)
    }
}

var genericCapturingBody: () -> Void = {}
public func storeGenericCapturing<T>(_ value: T) {
    genericCapturingBody = { _ = value }
}
public func triggerGenericCapturing() { storeGenericCapturing(42) }
public func genericCapturingContext() -> UnsafeMutableRawPointer {
    return withUnsafePointer(to: &genericCapturingBody) { p in
        UnsafeRawPointer(p).load(fromByteOffset: MemoryLayout<Int>.size, as: UnsafeMutableRawPointer.self)
    }
}

public actor Ticker {
    public var count = 0
    public init() {}
    public func tick() { count += 1 }
    public func advance() async -> Int {
        count += 1
        return count
    }
    public func advance(by n: Int) async -> Int {
        count += n
        return count
    }
    public func scaledCountAsync(_ factor: Double) async -> Double {
        return Double(count) * factor
    }
    public func labelAsync() async -> String {
        return "tick-\(count)"
    }
    public func advanceOrThrowAsync(by n: Int) async throws -> Int {
        if n == 0 { throw TickError.zero }
        count += n
        return count
    }
}

enum TickError: Error { case zero }

final class TickerSerialExecutor: SerialExecutor {
    private let queue = DispatchQueue(label: "fixture.custom-ticker")
#if compiler(>=5.9)
    func enqueue(_ job: consuming ExecutorJob) {
        let unowned = UnownedJob(job)
        let executor = asUnownedSerialExecutor()
        queue.async { unowned.runSynchronously(on: executor) }
    }
#else
    func enqueue(_ job: UnownedJob) {
        let executor = asUnownedSerialExecutor()
        queue.async { job._runSynchronously(on: executor) }
    }
#endif
    func asUnownedSerialExecutor() -> UnownedSerialExecutor {
        UnownedSerialExecutor(ordinary: self)
    }
}

public actor CustomExecutorTicker {
    public var count = 0
    private let executor = TickerSerialExecutor()
    public init() {}
    public nonisolated var unownedExecutor: UnownedSerialExecutor {
        executor.asUnownedSerialExecutor()
    }
    public func advance() async -> Int {
        count += 1
        return count
    }
}

@globalActor public actor FixtureGA {
    public static let shared = FixtureGA()
}

@FixtureGA public func gaFreeAsync(_ x: Int) async -> Int { return x + 1 }

public final class GAHolder {
    public var v: Int
    public init(_ v: Int) { self.v = v }
    @FixtureGA public func gaMethodAsync(_ x: Int) async -> Int { v += x; return v }
    public func plainMethodAsync(_ x: Int) async -> Int { v += x; return v }
}

@FixtureGA public final class WholeGAHolder {
    public var v: Int
    public init(_ v: Int) { self.v = v }
    public func bumpAsync(_ x: Int) async -> Int { v += x; return v }
}

// @MainActor isolation hops to the main dispatch queue, serviceable only by the main thread's runloop;
// the bridge cannot drive this from a Frida worker thread. See global-actor-async-call.test.ts.
public final class MainHolder {
    public var v: Int
    public init(_ v: Int) { self.v = v }
    @MainActor public func mainMethodAsync(_ x: Int) async -> Int { v += x; return v }
}

public func computeAsync(_ x: Int) async -> Int {
    await Task.yield()
    return x * 2
}

final class AsyncResultBox: @unchecked Sendable { var value = 0 }

public final class AsyncBox: @unchecked Sendable {
    public var value = 0
    public init() {}
}
public func makeAsyncBox() -> AsyncBox { AsyncBox() }
public func readAsyncBox(_ box: AsyncBox) -> Int { box.value }
public func storeDoubleAsync(_ box: AsyncBox, _ n: Int) async {
    await Task.yield()
    box.value = n * 2
}
public func storeDoubleNow(_ box: AsyncBox, _ n: Int) async {
    box.value = n * 2
}
public final class AsyncCalc {
    public let base: Int
    public init(base: Int) { self.base = base }
    public func addAsync(_ n: Int) async -> Int {
        await Task.yield()
        return base + n
    }
    public func divideBaseBy(_ d: Int) async throws -> Int {
        await Task.yield()
        if d == 0 { throw AsyncDivideError.divideByZero }
        return base / d
    }
    public func scaleAsync(_ x: Double) async -> Double {
        await Task.yield()
        return Double(base) * x
    }
    public func quadAsync() async -> AsyncQuad {
        await Task.yield()
        return AsyncQuad(a: base, b: base + 1, c: base + 2, d: base + 3, e: base + 4)
    }
    public func echoAsync<T>(_ x: T) async -> T {
        await Task.yield()
        return x
    }
    public func pickLargerAsync<T: Comparable>(_ a: T, _ b: T) async -> T {
        await Task.yield()
        return a >= b ? a : b
    }
    public static func combineAsync(_ a: Int, _ b: Int) async -> Int {
        await Task.yield()
        return a * 10 + b
    }
}
public func makeAsyncCalc(_ base: Int) -> AsyncCalc { AsyncCalc(base: base) }

public enum AsyncDivideError: Error { case divideByZero }
public func divideAsync(_ a: Int, _ b: Int) async throws -> Int {
    await Task.yield()
    if b == 0 { throw AsyncDivideError.divideByZero }
    return a / b
}

public struct AsyncPair { public let a: Int; public let b: Int }
public func makePairAsync(_ a: Int, _ b: Int) async -> AsyncPair {
    await Task.yield()
    return AsyncPair(a: a, b: b)
}

public func makeTupleAsync(_ a: Int, _ b: Int) async -> (Int, String) {
    await Task.yield()
    return (a + b, "sum")
}

public protocol AsyncScaler {
    func scaled(_ x: Int) async -> Int
    func scaledTwice(_ x: Int) async -> Int
}
extension AsyncScaler {
    public func scaledTwice(_ x: Int) async -> Int { await scaled(await scaled(x)) }
}
public struct TripleScaler: AsyncScaler {
    public let factor: Int
    public func scaled(_ x: Int) async -> Int {
        await Task.yield()
        return x * factor
    }
}
public func asyncScalerType() -> UnsafeRawPointer { unsafeBitCast((any AsyncScaler).self as Any.Type, to: UnsafeRawPointer.self) }
public func storeAsyncScaler(_ p: UnsafeMutableRawPointer) {
    p.assumingMemoryBound(to: (any AsyncScaler).self).initialize(to: TripleScaler(factor: 3))
}

public func computeDoubleAsync(_ x: Double) async -> Double {
    await Task.yield()
    return x * 2
}
public func addViaDoubleAsync(_ x: Double) async -> Double {
    return await computeDoubleAsync(x) + 1
}

public struct AsyncQuad {
    public let a: Int; public let b: Int; public let c: Int; public let d: Int; public let e: Int
}
public func makeQuadAsync(_ n: Int) async -> AsyncQuad {
    await Task.yield()
    return AsyncQuad(a: n, b: n + 1, c: n + 2, d: n + 3, e: n + 4)
}
public func sumQuadAsync(_ n: Int) async -> Int {
    let q = await makeQuadAsync(n)
    return q.a + q.b + q.c + q.d + q.e
}

public func driveComputeAsync(_ x: Int) -> Int {
    let sem = DispatchSemaphore(value: 0)
    let box = AsyncResultBox()
    Task {
        box.value = await computeAsync(x)
        sem.signal()
    }
    sem.wait()
    return box.value
}

public func spillIntsAsync(_ a0: Int, _ a1: Int, _ a2: Int, _ a3: Int, _ a4: Int, _ a5: Int,
                           _ a6: Int, _ a7: Int, _ small: Int32, _ last: Int) async -> Int {
    await Task.yield()
    return a0 + Int(small) + last
}
public func driveSpillIntsAsync() -> Int {
    let sem = DispatchSemaphore(value: 0)
    let box = AsyncResultBox()
    Task {
        box.value = await spillIntsAsync(1, 2, 3, 4, 5, 6, 7, 8, -9, 10)
        sem.signal()
    }
    sem.wait()
    return box.value
}

// Distributed thunks are the only emitter of __swift5_acfuncs records: one per distributed func.
public distributed actor Calculator {
    public typealias ActorSystem = LocalTestingDistributedActorSystem

    public distributed func add(_ a: Int, _ b: Int) -> Int { a + b }
    public distributed func greet(_ name: String) -> String { "Hi, \(name)" }
}

public struct CodableCard: Codable {
    public var title: String

    private struct Hidden {
        let n: Int
        init(n: Int) { self.n = n }
    }

    public var hiddenDoubled: Int { Hidden(n: 21).n * 2 }
}
