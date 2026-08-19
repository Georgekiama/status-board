import type { ValidationIssue } from "./validate";

/** Base for errors the HTTP and MCP layers know how to translate. */
export class BoardError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.status = status;
  }
}

/** Payload failed validation. Nothing was written. */
export class BoardValidationError extends BoardError {
  readonly issues: ValidationIssue[];

  constructor(issues: ValidationIssue[]) {
    super(`Board payload is invalid (${issues.length} problem${issues.length === 1 ? "" : "s"})`, "invalid_board", 400);
    this.issues = issues;
  }
}

/** Caller supplied `expectedVersion` and the board had already moved on. */
export class VersionConflictError extends BoardError {
  readonly expectedVersion: number;
  readonly currentVersion: number;

  constructor(expectedVersion: number, currentVersion: number) {
    super(
      `Board has changed: expected version ${expectedVersion} but current version is ${currentVersion}`,
      "version_conflict",
      409,
    );
    this.expectedVersion = expectedVersion;
    this.currentVersion = currentVersion;
  }
}

export class NotFoundError extends BoardError {
  constructor(message: string) {
    super(message, "not_found", 404);
  }
}
