import { Routes } from '@angular/router';
import { authGuard } from './core/guards/auth.guard';
import { roleGuard } from './core/guards/role.guard';
import { unsavedChangesGuard } from './core/guards/unsaved-changes.guard';

export const routes: Routes = [
  {
    path: '',
    loadComponent: () =>
      import('./layouts/components/main-layout/main-layout').then((page) => page.MainLayout),
    canActivate: [authGuard],
    canActivateChild: [authGuard],
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'dashboard' },
      {
        path: 'dashboard',
        title: 'Fleet Dashboard | Fleet Pulse',
        loadComponent: () =>
          import('./features/dashboard/fleet-dashboard/fleet-dashboard').then((page) => page.FleetDashboard),
      },
      {
        path: 'services',
        title: 'Services | Fleet Pulse',
        loadComponent: () =>
          import('./features/services/service-list/service-list').then((page) => page.ServiceList),
      },
      {
        path: 'services/:id',
        title: 'Service Details | Fleet Pulse',
        loadComponent: () =>
          import('./features/servicedetails/service-details/service-details').then((page) => page.ServiceDetails),
      },
      {
        path: 'alert-rules',
        title: 'Alert Rules | Fleet Pulse',
        canActivate: [roleGuard],
        data: { roles: ['operator'] },
        canDeactivate: [unsavedChangesGuard],
        loadComponent: () =>
          import('./features/alert-rules/alert-rules/alert-rules').then((page) => page.AlertRules),
      },
      {
        // The assignment names the protected rule page /rules; keep /alert-rules
        // as a backward-compatible route for existing links.
        path: 'rules',
        title: 'Alert Rules | Fleet Pulse',
        canActivate: [roleGuard],
        data: { roles: ['operator'] },
        canDeactivate: [unsavedChangesGuard],
        loadComponent: () =>
          import('./features/alert-rules/alert-rules/alert-rules').then((page) => page.AlertRules),
      },
      {
        path: 'settings',
        title: 'Settings | Fleet Pulse',
        canActivate: [roleGuard],
        data: { roles: ['operator'] },
        loadComponent: () =>
          import('./features/settings/settings/settings').then((page) => page.Settings),
      },
    ],
  },
  {
    path: 'login',
    title: 'Login | Fleet Pulse',
    loadComponent: () =>
      import('./layouts/components/auth-layout/auth-layout').then((page) => page.AuthLayout),
    children: [
      {
        path: '',
        loadComponent: () => import('./features/auth/login/login').then((page) => page.Login),
      },
    ],
  },
  { path: '**', redirectTo: 'dashboard' },
];
