import { AsyncContext } from "./async-context.js";

const OFFSETOF_FLAGS = 0x20;
const OFFSETOF_ID = 0x24;
const OFFSETOF_RESUME_FUNCTION = 0x38;
const OFFSETOF_RESUME_CONTEXT = 0x40;

const KIND_MASK = 0xff;
const PRIORITY_SHIFT = 8;
const PRIORITY_MASK = 0xff;
const TASK_IS_CHILD = 1 << 24;
const TASK_IS_FUTURE = 1 << 25;
const TASK_IS_GROUP_CHILD = 1 << 26;
const TASK_IS_ASYNC_LET = 1 << 28;

export enum JobKind {
  Task = 0,
  DefaultActorInline = 192,
  DefaultActorSeparate = 193,
  DefaultActorOverride = 194,
  NullaryContinuation = 195,
  IsolatedDeinit = 196,
}

export enum JobPriority {
  Unspecified = 0x00,
  Background = 0x09,
  Utility = 0x11,
  Default = 0x15,
  UserInitiated = 0x19,
  UserInteractive = 0x21,
}

export class Job {
  constructor(readonly handle: NativePointer) {}

  get rawFlags(): number {
    return this.handle.readU32(OFFSETOF_FLAGS);
  }

  get kind(): JobKind {
    return this.rawFlags & KIND_MASK;
  }

  get priority(): JobPriority {
    return (this.rawFlags >>> PRIORITY_SHIFT) & PRIORITY_MASK;
  }

  get isAsyncTask(): boolean {
    return this.kind === JobKind.Task;
  }

  // Non-zero low 32 bits of the task id (Task.cpp setTaskId loops off zero).
  get id(): number {
    return this.handle.readU32(OFFSETOF_ID);
  }

  get resumeFunction(): NativePointer {
    return this.handle.readPointer(OFFSETOF_RESUME_FUNCTION).strip();
  }
}

export class AsyncTask extends Job {
  get resumeContext(): AsyncContext | null {
    const p = this.handle.readPointer(OFFSETOF_RESUME_CONTEXT).strip();
    return p.isNull() ? null : new AsyncContext(p);
  }

  get isChildTask(): boolean {
    return (this.rawFlags & TASK_IS_CHILD) !== 0;
  }

  get isFuture(): boolean {
    return (this.rawFlags & TASK_IS_FUTURE) !== 0;
  }

  get isGroupChildTask(): boolean {
    return (this.rawFlags & TASK_IS_GROUP_CHILD) !== 0;
  }

  get isAsyncLetTask(): boolean {
    return (this.rawFlags & TASK_IS_ASYNC_LET) !== 0;
  }
}
