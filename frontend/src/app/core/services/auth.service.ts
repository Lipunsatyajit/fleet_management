import { Injectable, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, catchError, map, of, tap } from 'rxjs';

import { environment } from '../../../environments/environment';
import { AuthResponse, UserRole } from '../../models/service.model';

export interface DemoIdentity {
  id: string;
  email: string;
  username: string;
  displayName: string;
  role: UserRole;
}

@Injectable({ providedIn: 'root' })
export class AuthService {
  private static readonly refreshTokenStorageKey = 'fleet-pulse.refresh-token';
  readonly accessToken = signal<string | null>(null);
  readonly refreshToken = signal<string | null>(null);
  readonly currentUser = signal<DemoIdentity | null>(null);

  constructor(private readonly http: HttpClient) {}

  get isAuthenticated(): boolean {
    return this.accessToken() !== null;
  }

  login(usernameOrEmail: string, password: string): Observable<AuthResponse> {
    const email = this.toEmail(usernameOrEmail);
    return this.http.post<AuthResponse>(`${environment.apiBaseUrl}/auth/login`, { email, password }).pipe(
      tap((response) => this.updateTokens(response)),
    );
  }

  restoreSession(): Observable<boolean> {
    const refreshToken = this.readStoredRefreshToken();
    if (!refreshToken) return of(false);

    return this.http.post<AuthResponse>(`${environment.apiBaseUrl}/auth/refresh`, { refreshToken }).pipe(
      tap((response) => this.updateTokens(response)),
      map(() => true),
      catchError(() => {
        this.clearStoredRefreshToken();
        return of(false);
      }),
    );
  }

  updateTokens(response: AuthResponse): void {
    const role = response.user.role;
    const displayName = role === 'operator' ? 'Priya Nair' : 'Aarav Sharma';
    this.accessToken.set(response.accessToken);
    this.refreshToken.set(response.refreshToken);
    this.storeRefreshToken(response.refreshToken);
    this.currentUser.set({
      id: response.user.id,
      email: response.user.email,
      username: role,
      displayName,
      role,
    });
  }

  logout(): void {
    this.accessToken.set(null);
    this.refreshToken.set(null);
    this.currentUser.set(null);
    this.clearStoredRefreshToken();
  }

  private readStoredRefreshToken(): string | null {
    try {
      return globalThis.localStorage?.getItem(AuthService.refreshTokenStorageKey) ?? null;
    } catch {
      return null;
    }
  }

  private storeRefreshToken(token: string): void {
    try {
      globalThis.localStorage?.setItem(AuthService.refreshTokenStorageKey, token);
    } catch {
      // The in-memory session remains usable when browser storage is unavailable.
    }
  }

  private clearStoredRefreshToken(): void {
    try {
      globalThis.localStorage?.removeItem(AuthService.refreshTokenStorageKey);
    } catch {
      // Ignore unavailable browser storage.
    }
  }

  private toEmail(usernameOrEmail: string): string {
    const value = usernameOrEmail.trim().toLowerCase();
    if (value.includes('@')) return value;
    if (value === 'operator' || value === 'priya nair') return 'operator@pulse.dev';
    if (value === 'viewer' || value === 'aarav sharma') return 'viewer@pulse.dev';
    return value;
  }
}
