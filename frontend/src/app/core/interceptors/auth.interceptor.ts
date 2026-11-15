import { Injectable } from '@angular/core';
import {
  HttpBackend,
  HttpErrorResponse,
  HttpEvent,
  HttpHandler,
  HttpInterceptor,
  HttpRequest,
} from '@angular/common/http';
import { Router } from '@angular/router';
import { HttpClient } from '@angular/common/http';
import { Observable, TimeoutError, catchError, finalize, retry, shareReplay, switchMap, throwError, timer } from 'rxjs';
import { timeout } from 'rxjs/operators';

import { environment } from '../../../environments/environment';
import { AuthResponse } from '../../models/service.model';
import { AuthService } from '../services/auth.service';
import { httpResilienceConfig } from '../config/http-resilience.config';

@Injectable()
export class AuthInterceptor implements HttpInterceptor {
  private readonly rawHttp: HttpClient;
  private refreshRequest$: Observable<AuthResponse> | null = null;

  constructor(
    handler: HttpBackend,
    private readonly auth: AuthService,
    private readonly router: Router,
  ) {
    this.rawHttp = new HttpClient(handler);
  }

  intercept(request: HttpRequest<unknown>, next: HttpHandler): Observable<HttpEvent<unknown>> {
    const token = this.auth.accessToken();
    const requestWithToken = !this.isPublicRequest(request) && token
      ? request.clone({ setHeaders: { Authorization: `Bearer ${token}` } })
      : request;

    return this.sendWithResilience(next, requestWithToken).pipe(
      catchError((error: unknown) => {
        if (!this.isExpiredToken(error) || this.isRefreshRequest(request)) {
          return throwError(() => error);
        }

        return this.refreshAccessToken().pipe(
          switchMap((response) => {
            const retriedRequest = request.clone({
              setHeaders: { Authorization: `Bearer ${response.accessToken}` },
            });
            return this.sendWithResilience(next, retriedRequest);
          }),
          catchError((refreshError: unknown) => {
            if (this.auth.isAuthenticated) {
              const returnUrl = this.router.url;
              this.auth.logout();
              void this.router.navigate(['/login'], { queryParams: { returnUrl } });
            }
            return throwError(() => refreshError);
          }),
        );
      }),
    );
  }

  private sendWithResilience(
    next: HttpHandler,
    request: HttpRequest<unknown>,
  ): Observable<HttpEvent<unknown>> {
    return next.handle(request).pipe(
      timeout({ first: httpResilienceConfig.timeoutMs }),
      retry({
        count: httpResilienceConfig.maxAttempts - 1,
        delay: (error: unknown) => {
          if (!this.canRetry(request, error)) return throwError(() => error);
          return timer(this.getRetryDelay(error));
        },
      }),
    );
  }

  private refreshAccessToken(): Observable<AuthResponse> {
    if (!this.refreshRequest$) {
      const refreshToken = this.auth.refreshToken();
      if (!refreshToken) return throwError(() => new Error('Refresh token is missing'));

      this.refreshRequest$ = this.rawHttp.post<AuthResponse>(
        `${environment.apiBaseUrl}/auth/refresh`,
        { refreshToken },
      ).pipe(
        timeout({ first: httpResilienceConfig.timeoutMs }),
        switchMap((response) => {
          this.auth.updateTokens(response);
          return [response];
        }),
        finalize(() => this.refreshRequest$ = null),
        shareReplay({ bufferSize: 1, refCount: false }),
      );
    }
    return this.refreshRequest$;
  }

  private canRetry(request: HttpRequest<unknown>, error: unknown): boolean {
    const isSafeMethod = request.method === 'GET';
    const hasIdempotencyKey = request.headers.has('Idempotency-Key');
    if (!isSafeMethod && !hasIdempotencyKey) return false;

    if (error instanceof TimeoutError) return true;
    if (!(error instanceof HttpErrorResponse)) return false;
    return error.status === 0 || [429, 502, 503, 504].includes(error.status);
  }

  private getRetryDelay(error: unknown): number {
    if (error instanceof HttpErrorResponse && error.status === 429) {
      const retryAfter = error.headers.get('Retry-After');
      if (retryAfter) {
        const seconds = Number(retryAfter);
        if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
        const retryDate = Date.parse(retryAfter);
        if (!Number.isNaN(retryDate)) return Math.max(0, retryDate - Date.now());
      }
    }
    return httpResilienceConfig.retryDelayMs;
  }

  private isExpiredToken(error: unknown): boolean {
    if (!(error instanceof HttpErrorResponse) || error.status !== 401) return false;
    return error.error?.error?.code === 'token_expired';
  }

  private isRefreshRequest(request: HttpRequest<unknown>): boolean {
    return request.url.includes('/auth/refresh');
  }

  private isPublicRequest(request: HttpRequest<unknown>): boolean {
    const publicPaths = ['/auth/login', '/auth/refresh', '/health', '/chaos'];
    return publicPaths.some((path) => request.url.includes(path));
  }
}
