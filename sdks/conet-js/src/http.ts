/**
 * HTTP client with retry logic
 */

import {
  ConetError,
  AuthenticationError,
  NotFoundError,
  RateLimitError,
  ServerError,
  TimeoutError,
  ValidationError,
} from './errors';

interface HttpOptions {
  timeout?: number;
  maxRetries?: number;
  bearerToken?: string;
}

export class HttpClient {
  private baseUrl: string;
  private timeout: number;
  private maxRetries: number;
  private bearerToken?: string;

  constructor(baseUrl: string, options?: HttpOptions) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.timeout = options?.timeout ?? 30_000;
    this.maxRetries = options?.maxRetries ?? 3;
    this.bearerToken = options?.bearerToken;
  }

  private async sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private getWaitTime(attempt: number): number {
    return Math.min(Math.pow(2, attempt) * 100, 10_000);
  }

  private async makeRequest<T>(
    method: string,
    path: string,
    body?: Record<string, any>,
    params?: Record<string, any>
  ): Promise<T> {
    const url = new URL(this.baseUrl + path);

    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined && value !== null) {
          url.searchParams.append(key, String(value));
        }
      });
    }

    const headers: Record<string, string> = {
      'User-Agent': 'conet-js/0.1.0',
      'Content-Type': 'application/json',
    };

    if (this.bearerToken) {
      headers['Authorization'] = `Bearer ${this.bearerToken}`;
    }

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeout);

        const response = await fetch(url.toString(), {
          method,
          headers,
          body: body ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (response.ok) {
          const contentType = response.headers.get('content-type');
          if (contentType?.includes('application/json')) {
            return (await response.json()) as T;
          }
          return {} as T;
        }

        let errorData: any = {};
        try {
          const contentType = response.headers.get('content-type');
          if (contentType?.includes('application/json')) {
            errorData = await response.json();
          }
        } catch (e) {
          // ignore parse errors
        }

        const detail = errorData?.detail || 'Unknown error';

        if (response.status === 401) {
          throw new AuthenticationError(detail, response.status);
        }

        if (response.status === 404) {
          throw new NotFoundError(detail, response.status);
        }

        if (response.status === 429) {
          if (attempt < this.maxRetries) {
            await this.sleep(this.getWaitTime(attempt));
            continue;
          }
          throw new RateLimitError(detail, response.status);
        }

        if (response.status >= 500) {
          if (attempt < this.maxRetries) {
            await this.sleep(this.getWaitTime(attempt));
            continue;
          }
          throw new ServerError(
            detail || `Server error: ${response.status}`,
            response.status
          );
        }

        if (response.status >= 400) {
          throw new ValidationError(detail, response.status);
        }

        const contentType = response.headers.get('content-type');
        if (contentType?.includes('application/json')) {
          return (await response.json()) as T;
        }
        return {} as T;
      } catch (error) {
        if (error instanceof ConetError) {
          throw error;
        }

        if (error instanceof TypeError && error.message.includes('abort')) {
          throw new TimeoutError(`Request timed out after ${this.timeout}ms`);
        }

        if (attempt < this.maxRetries) {
          await this.sleep(this.getWaitTime(attempt));
          continue;
        }

        throw new ConetError(
          error instanceof Error ? error.message : 'Unknown error'
        );
      }
    }

    throw new ConetError('Request failed after max retries');
  }

  async get<T>(path: string, params?: Record<string, any>): Promise<T> {
    return this.makeRequest<T>('GET', path, undefined, params);
  }

  async post<T>(path: string, body?: Record<string, any>): Promise<T> {
    return this.makeRequest<T>('POST', path, body);
  }

  async postForm<T>(path: string, data: Record<string, any>): Promise<T> {
    const headers: Record<string, string> = {
      'User-Agent': 'conet-js/0.1.0',
    };

    if (this.bearerToken) {
      headers['Authorization'] = `Bearer ${this.bearerToken}`;
    }

    const formData = new FormData();
    Object.entries(data).forEach(([key, value]) => {
      formData.append(key, String(value));
    });

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    const response = await fetch(new URL(this.baseUrl + path).toString(), {
      method: 'POST',
      headers,
      body: formData,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (response.ok) {
      return (await response.json()) as T;
    }

    throw new ConetError(`Request failed: ${response.statusText}`, response.status);
  }
}
