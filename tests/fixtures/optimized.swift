// -O inlines each tag() into its witness thunk, so a thunk's first call is not its witness.
public protocol Tagged {
    func tag() -> Int
}
extension Tagged {
    public func tag() -> Int { 0 }
}

@inline(never) public func bumped(_ x: Int) -> Int { x &+ 1 }

public struct FreeCallTagged: Tagged {
    public let x: Int
    public func tag() -> Int { bumped(x) &* 3 }
}
public struct GetterCallTagged: Tagged {
    public let x: Int
    @inline(never) public var doubled: Int { x &* 2 }
    public func tag() -> Int { doubled &* 3 }
}
struct HiddenTagged: Tagged {
    let n: Int
    func tag() -> Int { n }
}
