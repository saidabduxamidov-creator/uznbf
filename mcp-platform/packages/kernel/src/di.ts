/**
 * Minimal typed dependency-injection container. Explicit tokens and factories, singleton scope,
 * cycle detection and ordered disposal. No decorators and no runtime reflection.
 */
import { InternalError } from "@lmp/core";

export interface Token<T> {
  readonly key: symbol;
  readonly name: string;
  /** Phantom field that carries the type; never set at runtime. */
  readonly __type?: T;
}

export function createToken<T>(name: string): Token<T> {
  return Object.freeze({ key: Symbol(name), name });
}

export interface Disposable {
  dispose(): void | Promise<void>;
}

type Factory<T> = (container: Container) => T;

interface Registration<T> {
  readonly factory: Factory<T>;
  readonly dispose?: (instance: T) => void | Promise<void>;
}

export class Container {
  private readonly registrations = new Map<symbol, Registration<unknown>>();
  private readonly instances = new Map<symbol, unknown>();
  private readonly creationOrder: symbol[] = [];
  private readonly resolving = new Set<symbol>();
  private disposed = false;

  register<T>(token: Token<T>, factory: Factory<T>, dispose?: (instance: T) => void | Promise<void>): this {
    this.assertActive();
    if (this.registrations.has(token.key)) throw new InternalError(`Duplicate registration: ${token.name}`);
    const registration: Registration<T> = dispose ? { factory, dispose } : { factory };
    this.registrations.set(token.key, registration as Registration<unknown>);
    return this;
  }

  registerValue<T>(token: Token<T>, value: T): this {
    return this.register(token, () => value);
  }

  has(token: Token<unknown>): boolean {
    return this.registrations.has(token.key);
  }

  resolve<T>(token: Token<T>): T {
    this.assertActive();
    if (this.instances.has(token.key)) return this.instances.get(token.key) as T;
    const registration = this.registrations.get(token.key) as Registration<T> | undefined;
    if (!registration) throw new InternalError(`No registration for ${token.name}`);
    if (this.resolving.has(token.key)) throw new InternalError(`Dependency cycle while resolving ${token.name}`);
    this.resolving.add(token.key);
    try {
      const instance = registration.factory(this);
      this.instances.set(token.key, instance);
      this.creationOrder.push(token.key);
      return instance;
    } finally {
      this.resolving.delete(token.key);
    }
  }

  /** Disposes created instances in reverse creation order; errors are collected, not thrown early. */
  async dispose(): Promise<readonly unknown[]> {
    if (this.disposed) return [];
    this.disposed = true;
    const errors: unknown[] = [];
    for (const key of [...this.creationOrder].reverse()) {
      const registration = this.registrations.get(key);
      const instance = this.instances.get(key);
      try {
        if (registration?.dispose) await registration.dispose(instance);
        else if (isDisposable(instance)) await instance.dispose();
      } catch (error) {
        errors.push(error);
      }
    }
    this.instances.clear();
    return errors;
  }

  private assertActive(): void {
    if (this.disposed) throw new InternalError("Container already disposed");
  }
}

function isDisposable(value: unknown): value is Disposable {
  return typeof value === "object" && value !== null && typeof (value as { dispose?: unknown }).dispose === "function";
}
