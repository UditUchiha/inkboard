declare class Buffer extends Uint8Array {
  static from(data: string | Uint8Array | ArrayBuffer, encoding?: string): Buffer;
  static from(data: ArrayBuffer, byteOffset?: number, length?: number): Buffer;
  toString(encoding?: string): string;
}

declare module "node:assert/strict" {
  type AssertPredicate = RegExp | Function | object | Error | ((thrown: unknown) => boolean);

  const assert: {
    (value: unknown, message?: string | Error): asserts value;
    equal(actual: unknown, expected: unknown, message?: string | Error): void;
    notEqual(actual: unknown, expected: unknown, message?: string | Error): void;
    deepEqual(actual: unknown, expected: unknown, message?: string | Error): void;
    notDeepEqual(actual: unknown, expected: unknown, message?: string | Error): void;
    ok(value: unknown, message?: string | Error): asserts value;
    match(value: string, regExp: RegExp, message?: string | Error): void;
    doesNotMatch(value: string, regExp: RegExp, message?: string | Error): void;
    throws(fn: () => unknown, expected?: AssertPredicate, message?: string): void;
    doesNotThrow(fn: () => unknown, message?: string): void;
    rejects(
      asyncFn: (() => Promise<unknown>) | Promise<unknown>,
      expected?: AssertPredicate,
      message?: string,
    ): Promise<void>;
    doesNotReject(asyncFn: (() => Promise<unknown>) | Promise<unknown>, message?: string): Promise<void>;
    fail(message?: string | Error): never;
  };
  export default assert;
}

declare module "node:test" {
  export function describe(name: string, fn: () => void | Promise<void>): void;
  export function it(name: string, fn: (t?: unknown) => void | Promise<void>): void;
  export function beforeEach(fn: () => void | Promise<void>): void;
  export function afterEach(fn: () => void | Promise<void>): void;
  export function before(fn: () => void | Promise<void>): void;
  export function after(fn: () => void | Promise<void>): void;
  export const mock: {
    fn<T extends Function>(implementation?: T): T & { mock: unknown };
    method<T, K extends keyof T>(object: T, method: K, implementation?: Function): Function & { mock: unknown };
    timers: {
      enable(options?: unknown): void;
      reset(): void;
      tick(ms: number): void;
    };
  };
}

declare module "node:module" {
  export function register(specifier: string | URL, parentURL?: string | URL, options?: unknown): void;
}

declare module "node:crypto" {
  export function createHash(algorithm: string): {
    update(data: string | Uint8Array): {
      digest(encoding?: string): string;
    };
  };
}
