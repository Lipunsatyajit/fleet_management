import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, provideRouter } from '@angular/router';

import { AuthService } from '../../../core/services/auth.service';
import { Login } from './login';

describe('Login', () => {
  it('does not try to sign in when required fields are empty', async () => {
    const loginSpy = jasmine.createSpy('login');
    await TestBed.configureTestingModule({
      imports: [Login],
      providers: [
        provideRouter([]),
        { provide: AuthService, useValue: { login: loginSpy } },
        { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: { get: () => null } } } },
      ],
    }).compileComponents();

    const fixture = TestBed.createComponent(Login);
    fixture.componentInstance.login();

    expect(fixture.componentInstance.loginForm.invalid).toBeTrue();
    expect(loginSpy).not.toHaveBeenCalled();
    fixture.destroy();
  });
});
