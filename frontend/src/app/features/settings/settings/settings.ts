import { Component, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { AppPreferencesService } from '../../../core/services/app-preferences.service';
import { FleetDataService } from '../../../core/services/fleet-data.service';

@Component({
  selector: 'app-settings',
  imports: [FormsModule],
  templateUrl: './settings.html',
  styleUrl: './settings.css',
})
export class Settings implements OnInit {
  savedMessage = '';
  metricRefreshSeconds = 3;
  notificationsEnabled = true;
  simulationRate: 500 | 2000 = 500;

  constructor(
    private readonly preferences: AppPreferencesService,
    private readonly fleetData: FleetDataService,
  ) {
    const current = this.preferences.current;
    this.metricRefreshSeconds = current.metricRefreshSeconds;
    this.notificationsEnabled = current.notificationsEnabled;
    this.simulationRate = current.simulationRate;
  }

  ngOnInit(): void {
    this.fleetData.getChaos().subscribe({
      next: (settings) => {
        const rate = Number(settings['rate']);
        if (rate === 500 || rate === 2000) this.simulationRate = rate;
      },
    });
  }

  savePreferences(): void {
    const saved = {
      metricRefreshSeconds: this.metricRefreshSeconds,
      notificationsEnabled: this.notificationsEnabled,
      simulationRate: this.simulationRate,
    };
    this.preferences.update(saved);
    this.fleetData.updateChaos({ rate: saved.simulationRate }).subscribe({
      next: () => this.savedMessage = 'Preferences saved. Backend event rate updated.',
      error: () => this.savedMessage = 'Local preferences saved, but the backend rate could not be changed.',
    });
  }

}
