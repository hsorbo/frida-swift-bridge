import fixture

public extension Robot {
    func fly() -> String { "fly \(name)" }

    func flyRobot() -> String { "fly robot \(name)" }

    var robotWingspan: Int { name.count * 2 }

    var wingspan: Int { name.count }
}

public extension Pair {
    func labelled() -> String { "pair" }
}

public extension Ranged {
    init(span: Int) { self.init(lo: 0, hi: span) }
}

public extension Robot {
    convenience init(badge: String) { self.init(name: "R-\(badge)") }
}

public extension Labeled {
    func whisper() -> String { displayName.lowercased() }

    func whisperLabeled() -> String { "labeled " + displayName.lowercased() }
}
