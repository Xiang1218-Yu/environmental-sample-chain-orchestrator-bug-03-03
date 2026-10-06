export class DomainError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = 'DomainError';
    }
}
export function assertFound(value, code, message) {
    if (!value)
        throw new DomainError(code, message);
    return value;
}
export function assertCondition(condition, code, message) {
    if (!condition)
        throw new DomainError(code, message);
}
