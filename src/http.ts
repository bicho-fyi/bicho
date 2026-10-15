export type JsonObject = Record<string, unknown>;

export class HttpError extends Error {
  status: number;
  headers: Record<string, string>;

  constructor(status: number, message: string, headers: Record<string, string> = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

export function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "Expected a JSON object");
  }
  return value as JsonObject;
}
