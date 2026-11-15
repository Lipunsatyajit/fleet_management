import { TestBed } from '@angular/core/testing';
import { HTTP_INTERCEPTORS, HttpClient, HttpErrorResponse, HttpRequest, provideHttpClient, withInterceptorsFromDi } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { signal } from '@angular/core';

import { AuthInterceptor } from './auth.interceptor';
import { AuthService } from '../services/auth.service';
import { environment } from '../../../environments/environment';

describe('AuthInterceptor', () => {
  let httpMock: HttpTestingController;
  const accessToken = signal<string | null>('expired-token');
  const refreshToken = signal<string | null>('refresh-token');
  const authMock = {
    accessToken,
    refreshToken,
    isAuthenticated: true,
    updateTokens: (response: { accessToken: string; refreshToken: string }) => {
      accessToken.set(response.accessToken);
      refreshToken.set(response.refreshToken);
    },
    logout: jasmine.createSpy('logout'),
  };

  beforeEach(() => {
    accessToken.set('expired-token');
    refreshToken.set('refresh-token');
    authMock.logout.calls.reset();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptorsFromDi()),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: HTTP_INTERCEPTORS, useClass: AuthInterceptor, multi: true },
        { provide: AuthService, useValue: authMock },
      ],
    });
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => httpMock.verify());

  it('uses one refresh request for ten expired requests', () => {
    const http = TestBed.inject(HttpClient);
    for (let index = 0; index < 10; index += 1) {
      http.get(`${environment.apiBaseUrl}/test/${index}`).subscribe();
    }

    const firstRequests = httpMock.match((request) => request.url.includes('/test/'));
    expect(firstRequests.length).toBe(10);
    for (const request of firstRequests) {
      request.flush({ error: { code: 'token_expired', message: 'expired', details: [] } }, { status: 401, statusText: 'Unauthorized' });
    }

    const refresh = httpMock.expectOne(`${environment.apiBaseUrl}/auth/refresh`);
    expect(refresh.request.body).toEqual({ refreshToken: 'refresh-token' });
    refresh.flush({
      accessToken: 'new-access-token', refreshToken: 'new-refresh-token', expiresIn: 60,
      user: { id: 'u-1', email: 'operator@pulse.dev', role: 'operator' },
    });

    const retriedRequests = httpMock.match((request) => request.url.includes('/test/'));
    expect(retriedRequests.length).toBe(10);
    for (const request of retriedRequests) {
      expect(request.request.headers.get('Authorization')).toBe('Bearer new-access-token');
      request.flush({ ok: true });
    }
  });

  it('logs out when the refresh request fails', () => {
    const http = TestBed.inject(HttpClient);
    http.get(`${environment.apiBaseUrl}/private-data`).subscribe({ error: () => undefined });
    httpMock.expectOne(`${environment.apiBaseUrl}/private-data`).flush(
      { error: { code: 'token_expired' } },
      { status: 401, statusText: 'Unauthorized' },
    );
    httpMock.expectOne(`${environment.apiBaseUrl}/auth/refresh`).flush(
      { error: { code: 'refresh_invalid' } },
      { status: 401, statusText: 'Unauthorized' },
    );

    expect(authMock.logout).toHaveBeenCalled();
  });

  it('retries GET network failures but only retries POST when it has an idempotency key', () => {
    const interceptor = (TestBed.inject(HTTP_INTERCEPTORS) as unknown as AuthInterceptor[])[0] as unknown as {
      canRetry: (request: HttpRequest<unknown>, error: unknown) => boolean;
    };
    const networkError = new HttpErrorResponse({ status: 0 });
    const getRequest = new HttpRequest('GET', '/services');
    const postRequest = new HttpRequest('POST', '/rules', {});
    const safePost = postRequest.clone({ setHeaders: { 'Idempotency-Key': 'test-key' } });

    expect(interceptor.canRetry(getRequest, networkError)).toBeTrue();
    expect(interceptor.canRetry(postRequest, networkError)).toBeFalse();
    expect(interceptor.canRetry(safePost, networkError)).toBeTrue();
    expect(interceptor.canRetry(getRequest, new HttpErrorResponse({ status: 400 }))).toBeFalse();
  });
});
