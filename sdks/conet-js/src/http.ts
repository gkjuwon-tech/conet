/**
 * HTTP client with exponential-backoff retries on 429/5xx.
 *
 * Authentication header selection mirrors the Python SDK:
 *   - ``em_cluster_…`` → ``X-Cluster-Key`` + ``X-API-Key`` (data-plane)
 *   - ``em_live_…``    → ``X-API-Key`` (control-plane)
 *   - any other prefix → ``X-API-Key`` + ``Authorization: Bearer``
 */

import {
  AuthenticationError,
  ConetError,
  NotFoundError,
  RateLimitError,
  ServerError,
  TimeoutError,
  ValidationError,
} from './errors.js';

const USER_AGENT = 'conet-js/0.2.0';

interface HttpOptions {
  timeout?: number;
  maxRetries?: number;
  /** Raw API key value. Prefix decides which header(s) to send. */
  apiKey?: string;
}

function buildAuthHeaders(apiKey: string): Record<string, string> {
  if (apiKey.startsWith('em_cluster_')) {
    return { 'X-Cluster-Key': apiKey, 'X-API-Key': apiKey };
  }
  if (apiKey.startsWith('em_live_')) {
    return { 'X-API-Key': apiKey };
  }
  return { 'X-API-Key': apiKey, Authorization: `Bearer ${apiKey}` };
}

export class HttpClient {
  private baseUrl: string;
  private timeout: number;
  private maxRetries: number;
  private apiKey?: string;

  constructor(baseUrl: string, options?: HttpOptions) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.timeout = options?.timeout ?? 30_000;
    this.maxRetries = options?.maxRetries ?? 3;
    this.apiKey = options?.apiKey;
  }

  private async sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private getWaitTime(attempt: number): number {
    return Math.min(Math.pow(2, attempt) * 200, 8_000);
  }

  private buildHeaders(extra?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = {
      'User-Agent': USER_AGENT,
      Accept: 'application/json',
      ...extra,
    };
    if (this.apiKey) {
      Object.assign(headers, buildAuthHeaders(this.apiKey));
    }
    return headers;
  }

  private async buildError(response: Response): Promise<ConetError> {
    let detail = `HTTP ${response.status}`;
    try {
      const ct = response.headers.get('content-type') ?? '';
      if (ct.includes('application/json')) {
        const body = (await response.json()) as {
          detail?: unknown;
          message?: string;
        };
        if (Array.isArray(body.detail)) {
          detail =
            body.detail
              .map((d: { loc?: unknown[]; msg?: string }) => {
                const loc = Array.isArray(d.loc)
                  ? d.loc.map((p) => String(p)).join('.')
                  : '';
                return loc ? `${loc}: ${d.msg ?? ''}` : (d.msg ?? '');
              })
              .filter(Boolean)
              .join('; ') || 'validation failed';
        } else if (typeof body.detail === 'string') {
          detail = body.detail;
        } else if (typeof body.message === 'string') {
          detail = body.message;
        }
      } else {
        const text = await response.text();
        if (text) detail = text.slice(0, 200);
      }
    } catch {
      // best-effort
    }

    const status = response.status;
    if (status === 401 || status === 403) {
      return new AuthenticationError(detail, status);
    }
    if (status === 404) return new NotFoundError(detail, status);
    if (status === 429) return new RateLimitError(detail, status);
    if (status >= 500) return new ServerError(detail, status);
    return new ValidationError(detail, status);
  }

  private async makeRequest<T>(
    method: string,
    path: string,
    body?: Record<string, unknown>,
    params?: Record<string, unknown>
  ): Promise<T> {
    const url = new URL(this.baseUrl + path);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null) {
          url.searchParams.append(k, String(v));
        }
      }
    }

    const headers = this.buildHeaders(
      body ? { 'Content-Type': 'application/json' } : undefined
    );

    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);

      try {
        const response = await fetch(url.toString(), {
          method,
          headers,
          body: body ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (response.ok) {
          if (response.status === 204) {
            return undefined as unknown as T;
          }
          const ct = response.headers.get('content-type') ?? '';
          if (ct.includes('application/json')) {
            return (await response.json()) as T;
          }
          return (await response.text()) as unknown as T;
        }

        const err = await this.buildError(response);
        if (
          (err instanceof RateLimitError || err instanceof ServerError) &&
          attempt < this.maxRetries
        ) {
          lastError = err;
          const retryAfter = response.headers.get('Retry-After');
          const wait = retryAfter
            ? Number.parseFloat(retryAfter) * 1000 || this.getWaitTime(attempt)
            : this.getWaitTime(attempt);
          await this.sleep(wait);
          continue;
        }
        throw err;
      } catch (error) {
        clearTimeout(timeoutId);
        if (error instanceof ConetError) {
          throw error;
        }
        if (
          error instanceof DOMException &&
          (error.name === 'AbortError' || error.name === 'TimeoutError')
        ) {
          lastError = new TimeoutError(
            `Request timed out after ${this.timeout}ms`
          );
          if (attempt < this.maxRetries) {
            await this.sleep(this.getWaitTime(attempt));
            continue;
          }
          throw lastError;
        }
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt < this.maxRetries) {
          await this.sleep(this.getWaitTime(attempt));
          continue;
        }
        throw new ConetError(lastError.message);
      }
    }

    throw new ConetError(
      lastError?.message ?? 'Request failed after max retries'
    );
  }

  async get<T>(path: string, params?: Record<string, unknown>): Promise<T> {
    return this.makeRequest<T>('GET', path, undefined, params);
  }

  async post<T>(
    path: string,
    body?: Record<string, unknown>
  ): Promise<T> {
    return this.makeRequest<T>('POST', path, body);
  }

  async delete<T>(
    path: string,
    body?: Record<string, unknown>
  ): Promise<T> {
    return this.makeRequest<T>('DELETE', path, body);
  }
}
