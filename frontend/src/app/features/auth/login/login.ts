import { Component } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';

import { AuthService } from '../../../core/services/auth.service';

@Component({
  selector: 'app-login',
  imports: [ReactiveFormsModule],
  templateUrl: './login.html',
  styleUrl: './login.css',
})
export class Login {
  readonly loginForm = new FormGroup({
    username: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    password: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
  });

  showPassword = false;
  isSubmitting = false;
  errorMessage = '';

  constructor(
    private readonly auth: AuthService,
    private readonly router: Router,
    private readonly route: ActivatedRoute,
  ) {}

  login(): void {
    if (this.loginForm.invalid) {
      this.loginForm.markAllAsTouched();
      return;
    }

    this.isSubmitting = true;
    this.errorMessage = '';
    const credentials = this.loginForm.getRawValue();

    this.auth.login(credentials.username, credentials.password).subscribe({
      next: () => {
        this.isSubmitting = false;

        const returnUrl = this.route.snapshot.queryParamMap.get('returnUrl');
        const safeReturnUrl = returnUrl?.startsWith('/') && !returnUrl.startsWith('//')
          ? returnUrl
          : '/dashboard';
        void this.router.navigateByUrl(safeReturnUrl);
      },
      error: (error: { error?: { error?: { message?: string } } }) => {
        this.isSubmitting = false;
        this.errorMessage = error.error?.error?.message || 'Could not connect to the Fleet Pulse server.';
      },
    });
  }
}
