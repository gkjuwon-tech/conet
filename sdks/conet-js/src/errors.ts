/**
 * Conet API exceptions
 */

export class ConetError extends Error {
  constructor(
    message: string,
    public statusCode?: number,
    public details?: Record<string, any>
  ) {
    super(message);
    this.name = 'ConetError';
  }
}

export class AuthenticationError extends ConetError {
  constructor(message = 'Invalid API key', statusCode?: number) {
    super(message, statusCode);
    this.name = 'AuthenticationError';
  }
}

export class NotFoundError extends ConetError {
  constructor(message = 'Resource not found', statusCode?: number) {
    super(message, statusCode);
    this.name = 'NotFoundError';
  }
}

export class ValidationError extends ConetError {
  constructor(message = 'Validation failed', statusCode?: number) {
    super(message, statusCode);
    this.name = 'ValidationError';
  }
}

export class RateLimitError extends ConetError {
  constructor(message = 'Rate limit exceeded', statusCode?: number) {
    super(message, statusCode);
    this.name = 'RateLimitError';
  }
}

export class TimeoutError extends ConetError {
  constructor(message = 'Request timed out', statusCode?: number) {
    super(message, statusCode);
    this.name = 'TimeoutError';
  }
}

export class ServerError extends ConetError {
  constructor(message: string, statusCode?: number) {
    super(message, statusCode);
    this.name = 'ServerError';
  }
}
