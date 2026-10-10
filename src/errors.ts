export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fields?: Record<string, string>;
  readonly retryAfter?: number;
  constructor(
    status: number,
    code: string,
    message: string,
    fields?: Record<string, string>,
    retryAfter?: number,
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.fields = fields;
    this.retryAfter = retryAfter;
  }
}
export class ConfigurationError extends Error {}

// Log only our own stable codes. Upstream exceptions can contain content or keys.
export function log(event: string, metadata: Record<string, string | number> = {}): void {
  console.log(JSON.stringify({ event, ...metadata }));
}
