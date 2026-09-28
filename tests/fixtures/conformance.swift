import fixture

public protocol Flyable {
    func soar() -> String
}

extension Robot: Flyable {
    public func soar() -> String { "soar \(name)" }
}

extension Robot: fixture.Container {
    public var item: String { name }
}

extension Robot: fixture.AsyncMeasurable {
    public func measure() async -> Int { name.count }
}
