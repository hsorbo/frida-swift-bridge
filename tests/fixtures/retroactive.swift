import fixture

extension Pup: fixture.Container {
    public var item: String { name }
}
