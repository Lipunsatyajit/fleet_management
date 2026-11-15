import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';

import { AuthService } from '../services/auth.service';
import { UserRole } from '../../models/service.model';

export const roleGuard: CanActivateFn = (route, state) => {
  const auth = inject(AuthService);
  const router = inject(Router);

  if (!auth.isAuthenticated) {
    return router.createUrlTree(['/login'], {
      queryParams: { returnUrl: state.url },
    });
  }

  const allowedRoles = route.data['roles'] as UserRole[] | undefined;
  const currentUser = auth.currentUser();
  if (currentUser && allowedRoles?.includes(currentUser.role)) {
    return true;
  }

  return router.createUrlTree(['/dashboard']);
};
