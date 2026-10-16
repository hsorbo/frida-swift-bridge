import { Metadata } from "./metadata.js";

const OFFSETOF_INSTANCE_TYPE = Process.pointerSize;

export function metatypeInstanceType(metadata: Metadata): Metadata {
  return new Metadata(metadata.handle.readPointer(OFFSETOF_INSTANCE_TYPE));
}
