// Typed adapter errors. Each maps to an explicit readiness/behaviour contract:
// integrations that require unavailable credentials must surface a typed
// not-configured status — never a fabricated response.
export class AdapterError extends Error {
  constructor(code, message, { status = 503, detail } = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}
export class PortalUnavailableError extends AdapterError {
  constructor(detail) { super('portal_unavailable', 'LTET portal is unavailable', { detail }); }
}
export class FinanceUnavailableError extends AdapterError {
  constructor(detail) { super('finance_unavailable', 'Finance integration is unavailable', { detail }); }
}
export class NotConfiguredError extends AdapterError {
  constructor(component) { super('not_configured', `${component} is not configured`, { status: 503 }); }
}
export class VerificationError extends AdapterError {
  constructor(code, message, { status = 400, detail } = {}) { super(code, message, { status, detail }); }
}
