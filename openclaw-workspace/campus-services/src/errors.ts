/**
 * Business error type shared by all campus services.
 *
 * Mapped to exit code 2 (CLI) and HTTP 4xx/5xx (Node server layer).
 * `code` is a stable machine-readable identifier (SCREAMING_SNAKE_CASE).
 */
export class CampusServiceError extends Error {
  readonly code: string;
  readonly httpStatus: number;

  constructor(code: string, message: string, httpStatus = 400) {
    super(message);
    this.name = 'CampusServiceError';
    this.code = code;
    this.httpStatus = httpStatus;
  }

  toJSON(): { code: string; message: string } {
    return { code: this.code, message: this.message };
  }
}
