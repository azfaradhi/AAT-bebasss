// Error classes carry a `code` field that is returned to clients in the error envelope.
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

export class InvalidCredentialsError extends AppError {
  constructor() {
    super(401, 'INVALID_CREDENTIALS', 'Invalid client_id or client_secret');
  }
}

export class InvalidTokenError extends AppError {
  constructor(message = 'Invalid token') {
    super(401, 'INVALID_TOKEN', message);
  }
}

export class TokenExpiredError extends AppError {
  constructor() {
    super(401, 'TOKEN_EXPIRED', 'Token has expired');
  }
}
