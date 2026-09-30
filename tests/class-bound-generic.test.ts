import { test, expect, describe, beforeEach } from "@frida/injest/agent";
import { loadFixture } from "./fixtures/load.js";
import { requireDarwin } from "./swift.js";

import { Swift, ClassType, EnumType, SwiftObject } from "../src/index.js";
import { ClassInstance, metadataFor, typeOf } from "../src/abi.js";
import { resolveType } from "../src/runtime/symbolication.js";
import { lookUpObjCClass } from "../src/runtime/objc.js";

function box(): SwiftObject {
  return (Swift.type("fixture.Box") as ClassType).init();
}

function classType(name: string): ClassType {
  return typeOf(metadataFor(name)!) as ClassType;
}

function newObjCObject(className: string): NativePointer {
  const libobjc = Process.getModuleByName("libobjc.A.dylib");
  const msgSend = new NativeFunction(libobjc.getExportByName("objc_msgSend"), "pointer", ["pointer", "pointer"]);
  const selRegisterName = new NativeFunction(libobjc.getExportByName("sel_registerName"), "pointer", ["pointer"]);
  return msgSend(lookUpObjCClass(className)!, selRegisterName(Memory.allocUtf8String("new"))) as NativePointer;
}

describe("generic method requirements that take no witness table", () => {
  beforeEach(() => { loadFixture(); });

  test("an AnyObject bound passes and returns a bare reference", () => {
    const Robot = classType("fixture.Robot");
    const robot = Robot.init("R2");
    const back = box().$method("anyIdentity", { typeArguments: [Robot] }).call(robot) as SwiftObject;
    expect(back.$handle.equals(robot.$handle)).toBe(true);
  });

  test("a superclass bound passes a subclass instance as a bare reference", () => {
    const SubSpeaker = classType("fixture.SubSpeaker");
    const speaker = SubSpeaker.init();
    expect(box().$method("speakerOf", { typeArguments: [SubSpeaker] }).call(speaker)).toBe("sub");
  });

  test("a marker protocol bound leaves the parameter address-only", () => {
    const Int = typeOf(metadataFor("Swift.Int")!);
    expect(box().$method("sendableEcho", { typeArguments: [Int] }).call(7)).toEqual(int64(7));
  });

  test("an Optional of a class-bound parameter is a nullable reference", () => {
    const Robot = classType("fixture.Robot");
    const robot = Robot.init("R2");
    const optionalObject = box().$method("optionalObject", { typeArguments: [Robot] });
    expect(optionalObject.call(null)).toBe(null);
    expect((optionalObject.call(robot) as SwiftObject).$handle.equals(robot.$handle)).toBe(true);
  });

  test("an object passed as an Optional argument is neither leaked nor over-released", () => {
    const robot = classType("fixture.Robot").init("R2");
    const view = new ClassInstance(robot.$handle);
    const optionalObject = box().$method("optionalObject", { typeArguments: [classType("fixture.Robot")] });
    const before = view.retainCount;
    (optionalObject.call(robot) as SwiftObject).$dispose();
    expect(view.retainCount).toBe(before);
  });

  test("a closure returning a class-bound parameter returns a bare reference", () => {
    const Robot = classType("fixture.Robot");
    const robot = Robot.init("R2");
    const made = box()
      .$method("madeObject", { typeArguments: [Robot], arity: 1 })
      .call(Swift.closure(() => robot)) as SwiftObject;
    expect(made.$handle.equals(robot.$handle)).toBe(true);
    expect(made.name).toBe("R2");
  });

  test("a closure taking scalars and returning a class-bound parameter returns a bare reference", () => {
    const Robot = classType("fixture.Robot");
    const made = box()
      .$method("madeObject", { typeArguments: [Robot], arity: 2 })
      .call(3, Swift.closure((n: Int64) => Robot.init(`R${n}`))) as SwiftObject;
    expect(made.name).toBe("R3");
  });
});

describe("class-bound generic parameters of Objective-C types", () => {
  beforeEach(() => { loadFixture(); });

  test("a Swift-declared @objc protocol bound takes no witness table", (ctx) => {
    requireDarwin(ctx);
    const Bat = classType("fixture.Bat");
    expect(box().$method("flaps", { typeArguments: [Bat] }).call(Bat.init())).toEqual(int64(2));
  });

  test("a method of a generic type passes its class-bound parameter as a bare reference", (ctx) => {
    requireDarwin(ctx);
    const conformer = classType("fixture.ObjCConformer").init();
    const holder = (Swift.type("fixture.ObjCBoxes") as EnumType).call("conformerRefBox", conformer) as SwiftObject;
    expect(holder.holds(conformer)).toBe(true);
    expect((holder.held() as SwiftObject).$handle.equals(conformer.$handle)).toBe(true);
  });

  test("a method of a generic struct whose only field is class-bound passes self directly", (ctx) => {
    requireDarwin(ctx);
    const conformer = classType("fixture.ObjCConformer").init();
    const other = classType("fixture.ObjCConformer").init();
    const valueBox = (Swift.type("fixture.ObjCBoxes") as EnumType).call("conformerValueBox", conformer) as SwiftObject;
    expect(valueBox.$method("holds", { self: "borrowing" }).call(conformer)).toBe(true);
    expect(valueBox.$method("holds", { self: "borrowing" }).call(other)).toBe(false);
  });

  test("a pure Objective-C class is a type argument", (ctx) => {
    requireDarwin(ctx);
    const NSObject = typeOf(resolveType("__C.NSObject")!);
    const object = newObjCObject("NSObject");
    const back = box().$method("anyIdentity", { typeArguments: [NSObject] }).call(object) as NativePointer;
    expect(back.equals(object)).toBe(true);
  });
});
