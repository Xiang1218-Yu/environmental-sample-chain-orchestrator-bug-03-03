export class DomainError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'DomainError';
  }
}

export function assertFound<T>(value: T | undefined, code: string, message: string): T {
  if (!value) throw new DomainError(code, message);
  return value;
}

export function assertCondition(condition: unknown, code: string, message: string): asserts condition {
  if (!condition) throw new DomainError(code, message);
}
