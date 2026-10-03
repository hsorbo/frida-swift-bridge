import { Metadata } from "./metadata.js";
import { getUnlabelledTupleTypeMetadata } from "./tuple.js";
import { makeSwiftNativeFunction, SwiftNativeFunction } from "../runtime/calling-convention.js";
import { metadataFor } from "../runtime/symbolication.js";
import { LIBSWIFT_CORE_NAME } from "../runtime/platform.js";

// The array-literal intrinsic: storage for count uninitialized elements, returned with the address
// of the first for the elements to be written in place.
const ALLOCATE_UNINITIALIZED_ARRAY = "$ss27_allocateUninitializedArrayySayxG_BptBwlF";

const allocators = new Map<string, SwiftNativeFunction>();

function allocatorFor(arrayType: Metadata, element: Metadata): SwiftNativeFunction {
  const key = element.handle.toString();
  let allocate = allocators.get(key);
  if (allocate === undefined) {
    const address = Process.getModuleByName(LIBSWIFT_CORE_NAME).getExportByName(ALLOCATE_UNINITIALIZED_ARRAY);
    const result = getUnlabelledTupleTypeMetadata([arrayType, metadataFor("Swift.UnsafeMutableRawPointer")!]);
    allocate = makeSwiftNativeFunction(address, result, [metadataFor("Swift.Int")!], { typeArguments: [element] });
    allocators.set(key, allocate);
  }
  return allocate;
}

// A +1 Array value of arrayType, initialize having written its count elements from the first's
// address at the element stride.
export function createArray(arrayType: Metadata, count: number, initialize: (first: NativePointer) => void): NativePointer {
  const element = new Metadata(arrayType.genericArguments.readPointer());
  const allocated = allocatorFor(arrayType, element)(Memory.alloc(Process.pointerSize).writeS64(count))!;
  initialize(allocated.add(Process.pointerSize).readPointer());
  return allocated;
}
