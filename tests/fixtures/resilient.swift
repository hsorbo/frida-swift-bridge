// Built with -enable-library-evolution so its types use resilient layout
// (runtime field-offset resolution), which libswiftCore can't reliably provide.
// Seed for the deferred resilient-superclass / resilient-field-offset work.

public struct ResilientPoint {
    public var x: Int
    public var y: Int

    public init(x: Int, y: Int) {
        self.x = x
        self.y = y
    }
}

// non-frozen ⇒ passed @in / returned @out across the resilience boundary, despite its 16-byte size
public func translate(_ p: ResilientPoint, dx: Int, dy: Int) -> ResilientPoint {
    return ResilientPoint(x: p.x + dx, y: p.y + dy)
}

// @frozen ⇒ visible layout ⇒ direct ABI even in a resilient module; leaves no trace, so it must be marked
@frozen public struct FrozenPoint {
    public var x: Int
    public var y: Int

    public init(x: Int, y: Int) {
        self.x = x
        self.y = y
    }
}

public func translateFrozen(_ p: FrozenPoint, dx: Int, dy: Int) -> FrozenPoint {
    return FrozenPoint(x: p.x + dx, y: p.y + dy)
}

// fixture.ConcreteSub subclasses this cross-module, which is what sets hasResilientSuperclass.
open class ResilientBase {
    public var tag: Int
    public init(tag: Int) { self.tag = tag }
    open func greeting() -> String { "base" }
}

// Resilient struct wrapping a class ref (like Foundation.URL wraps NSURL): address-only ABI yet
// non-POD, so Optional<ResilientHolder> is returned indirectly and destroyed through its payload.
public final class ResilientToken {
    public let id: Int
    public init(id: Int) { self.id = id }
}
public struct ResilientHolder {
    public var token: ResilientToken
    public init?(id: Int) {
        if id < 0 { return nil }
        self.token = ResilientToken(id: id)
    }
}
public func makeHolder(_ id: Int) -> ResilientHolder? { ResilientHolder(id: id) }
public func holderTokenId(_ h: ResilientHolder) -> Int { h.token.id }

public enum ResilientMode { case first, second }
@frozen public enum FrozenMode { case first, second }
public func modeIndex(_ m: ResilientMode) -> Int { m == .first ? 1 : 2 }
public func flipMode(_ m: ResilientMode) -> ResilientMode { m == .first ? .second : .first }

struct InternalPoint {
    var x: Int
    var y: Int
}
