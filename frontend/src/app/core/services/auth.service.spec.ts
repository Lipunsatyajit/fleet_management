import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';

import { AuthService } from './auth.service';
import { environment } from '../../../environments/environment';
import { AuthResponse } from '../../models/service.model';

describe('AuthService', () => {
  let service: AuthService;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    service = TestBed.inject(AuthService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => httpMock.verify());

  it('logs in and keeps tokens and role in memory', () => {
    let received: AuthResponse | undefined;
    service.login('operator', 'pulse123').subscribe((response) => received = response);
    const request = httpMock.expectOne(`${environment.apiBaseUrl}/auth/login`);
    expect(request.request.body).toEqual({ email: 'operator@pulse.dev', password: 'pulse123' });
    request.flush({
      accessToken: 'access', refreshToken: 'refresh', expiresIn: 60,
      user: { id: 'u-1', email: 'operator@pulse.dev', role: 'operator' },
    });

    expect(received?.user.role).toBe('operator');
    expect(service.isAuthenticated).toBeTrue();
    expect(service.currentUser()?.role).toBe('operator');
    expect(service.accessToken()).toBe('access');
  });
});
