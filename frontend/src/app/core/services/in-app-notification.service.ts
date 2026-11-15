import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

import { IncidentRecord } from '../../models/service.model';

@Injectable({ providedIn: 'root' })
export class InAppNotificationService {
  private readonly notificationSubject = new BehaviorSubject<IncidentRecord | null>(null);
  readonly notification$ = this.notificationSubject.asObservable();

  showIncident(incident: IncidentRecord): void {
    this.notificationSubject.next(incident);
  }

  dismiss(): void {
    this.notificationSubject.next(null);
  }
}
