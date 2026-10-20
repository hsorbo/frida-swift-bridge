# frida-swift-bridge2

Swift runtime interop for [Frida](https://frida.re). The bridge reads the Swift
metadata a process already carries, so a script can look up types, construct
and inspect instances, call methods (sync, async, generic, static), read and
write properties, work with protocols and existentials, pass JavaScript
callbacks as Swift closures, and intercept Swift functions with decoded
arguments and results.

## Install

```sh
npm install frida-swift-bridge2
```

The package is an ES module for Frida's GumJS runtime, bundled into an agent
with [frida-compile](https://github.com/frida/frida-compile) like any other
dependency. It needs Frida 17 and a Swift runtime in the target process, on
arm64 or x86-64 Darwin, Linux or Windows.

## Example

```js
import Swift from "frida-swift-bridge2";

if (Swift.available) {
    const Robot = Swift.type("MyApp.Robot");
    const robot = Robot.init("R2");                       // runs the Swift initializer
    console.log(robot.greet("Alice"));                   // calls a method, returns a JS string
    console.log(Robot.$type.instanceMethods());          // ["greet(_:)", "rename(to:)", ...]

    Swift.Interceptor.attach(robot.greet, {
        onEnter(args) { console.log("greet", args[0]); },
        onLeave(retval) { console.log("=>", retval); },
    });
}
```

## Documentation

[api.md](api.md) is the reference for the stable root entry point. A second
entry point, `frida-swift-bridge2/abi`, exposes the Swift ABI readers and
witness tables behind it; it is version-sensitive and documented at the end of
the reference.

## License

MIT
