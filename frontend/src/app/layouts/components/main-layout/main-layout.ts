import { Component, effect, OnDestroy } from '@angular/core';
import { AsyncPipe, DatePipe, UpperCasePipe } from '@angular/common';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';

import { AuthService } from '../../../core/services/auth.service';
import { ConnectionHealthService } from '../../../core/services/connection-health.service';
import { InAppNotificationService } from '../../../core/services/in-app-notification.service';
import { FleetDataService } from '../../../core/services/fleet-data.service';
import { AlertRuleService } from '../../../features/alert-rules/alert-rules/services/alert-rule.service';

@Component({
  selector: 'app-main-layout',
  standalone: true,
  imports: [AsyncPipe, DatePipe, UpperCasePipe, RouterLink, RouterLinkActive, RouterOutlet],
  templateUrl: './main-layout.html',
  styleUrl: './main-layout.css',
})
export class MainLayout implements OnDestroy {
  get connectionStatus() { return this.connectionHealth.status; }
  get currentUser() { return this.auth.currentUser; }
  get notification$() { return this.notifications.notification$; }
  get canManageAlerts(): boolean { return this.auth.currentUser()?.role === 'operator'; }
  get canManageSettings(): boolean { return this.canManageAlerts; }

  constructor(
    private readonly auth: AuthService,
    private readonly router: Router,
    private readonly connectionHealth: ConnectionHealthService,
    private readonly notifications: InAppNotificationService,
    private readonly fleetData: FleetDataService,
    private readonly alertRules: AlertRuleService,
  ) {
    // Load rules in the shared layout so alert evaluation starts on every page,
    // not only after the user opens the Alert Rules page.
    this.alertRules.load().subscribe({ error: () => undefined });
    this.fleetData.getServices().subscribe({
      next: (services) => this.alertRules.setServiceNames(services),
      error: () => undefined,
    });

    effect(() => {
      const token = this.auth.accessToken();
      if (token) this.connectionHealth.connect(token);
      else this.connectionHealth.disconnect();
    });
  }

  ngOnDestroy(): void {
    this.connectionHealth.disconnect();
  }

  async logout(): Promise<void> {
    const navigated = await this.router.navigate(['/login']);
    if (navigated) this.auth.logout();
  }

  dismissNotification(): void {
    this.notifications.dismiss();
  }
}
