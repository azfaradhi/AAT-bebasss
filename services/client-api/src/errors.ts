export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Insufficient permissions for this resource') {
    super(403, 'FORBIDDEN', message);
  }
}

export class LoadShedError extends AppError {
  constructor(
    public readonly retryAfterSeconds: number,
    message = 'Service overloaded; lower-priority request shed',
  ) {
    super(429, 'LOAD_SHED', message);
  }
}
