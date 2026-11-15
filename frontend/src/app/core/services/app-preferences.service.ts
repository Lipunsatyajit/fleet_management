import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

export interface AppPreferences {
  metricRefreshSeconds: number;
  notificationsEnabled: boolean;
  simulationRate: 500 | 2000;
}

@Injectable({ providedIn: 'root' })
export class AppPreferencesService {
  private readonly preferencesSubject = new BehaviorSubject<AppPreferences>({
    metricRefreshSeconds: 3,
    notificationsEnabled: true,
    simulationRate: 500,
  });
  readonly preferences$ = this.preferencesSubject.asObservable();

  get current(): AppPreferences {
    return this.preferencesSubject.value;
  }

  update(preferences: AppPreferences): void {
    this.preferencesSubject.next({ ...preferences });
  }
}
