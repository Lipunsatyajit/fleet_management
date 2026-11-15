import { Component, OnInit, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { AsyncValidatorFn, FormArray, FormControl, FormGroup, ReactiveFormsModule, Validators, AbstractControl, ValidationErrors, ValidatorFn } from '@angular/forms';
import { catchError, map, of, switchMap, timer } from 'rxjs';

import { AlertRuleService } from './services/alert-rule.service';
import { FleetDataService } from '../../../core/services/fleet-data.service';
import { AuthService } from '../../../core/services/auth.service';
import { AlertRuleCondition, AlertRuleRecord, IncidentRecord, RuleMetric, RuleOperator } from '../../../models/service.model';

export function nonBlankName(control: AbstractControl): ValidationErrors | null {
  return String(control.value ?? '').trim() ? null : { blank: true };
}

export function validThreshold(control: AbstractControl): ValidationErrors | null {
  const value = Number(control.value);
  return Number.isFinite(value) && value >= 0 ? null : { invalidThreshold: true };
}

export const conditionFieldsMatch: ValidatorFn = (control) => {
  const metric = control.get('metric')?.value;
  const threshold = Number(control.get('threshold')?.value);
  // Error rates are percentages, so their threshold cannot exceed 100.
  if (metric === 'errorRate' && threshold > 100) return { errorRateTooHigh: true };
  return null;
};

export function uniqueRuleName(fleetData: FleetDataService, excludeId: () => string | null): AsyncValidatorFn {
  return (control) => {
    const name = String(control.value ?? '').trim();
    if (!name) return of(null);

    // Angular cancels this observable when the user types a newer value.
    return timer(300).pipe(
      switchMap(() => fleetData.checkRuleName(name, excludeId() ?? '')),
      map((result) => result.available ? null : { nameTaken: true }),
      catchError(() => of(null)),
    );
  };
}

type ConditionForm = FormGroup<{
  metric: FormControl<RuleMetric>;
  operator: FormControl<RuleOperator>;
  threshold: FormControl<number>;
  durationSec: FormControl<number>;
}>;

@Component({
  selector: 'app-alert-rules',
  imports: [ReactiveFormsModule, DatePipe],
  templateUrl: './alert-rules.html',
  styleUrl: './alert-rules.css',
})
export class AlertRules implements OnInit {
  readonly isLoading = signal(true);
  readonly errorMessage = signal('');
  get rules() { return this.alertRules.rules; }
  get incidents() { return this.alertRules.incidents; }
  get isOperator(): boolean { return this.auth.currentUser()?.role === 'operator'; }
  readonly rulesPage = signal(1);
  readonly incidentsPage = signal(1);
  rulesPageSize = 10;
  incidentsPageSize = 10;
  editingRuleId: string | null = null;
  savedMessage = '';
  saving = false;

  readonly conditions = new FormArray<ConditionForm>([this.createCondition()]);
  readonly ruleForm = new FormGroup({
    name: new FormControl('', { nonNullable: true, validators: [Validators.required, nonBlankName, Validators.maxLength(60)] }),
    conditions: this.conditions,
    severity: new FormControl<AlertRuleRecord['severity']>('warning', { nonNullable: true }),
    enabled: new FormControl(true, { nonNullable: true }),
  });

  constructor(
    private readonly alertRules: AlertRuleService,
    private readonly fleetData: FleetDataService,
    private readonly auth: AuthService,
  ) {
    this.ruleForm.controls.name.setAsyncValidators(uniqueRuleName(this.fleetData, () => this.editingRuleId));
  }

  ngOnInit(): void {
    this.alertRules.load().subscribe({
      next: () => {
        this.isLoading.set(false);
        this.fleetData.getServices().subscribe((services) => this.alertRules.setServiceNames(services));
      },
      error: () => {
        this.errorMessage.set('Could not load alert rules from the backend.');
        this.isLoading.set(false);
      },
    });
  }

  get pageRules(): AlertRuleRecord[] {
    const start = (this.rulesPage() - 1) * this.rulesPageSize;
    return this.rules().slice(start, start + this.rulesPageSize);
  }
  get pageIncidents(): IncidentRecord[] {
    const start = (this.incidentsPage() - 1) * this.incidentsPageSize;
    return this.incidents().slice(start, start + this.incidentsPageSize);
  }
  get rulesTotalPages(): number { return Math.max(1, Math.ceil(this.rules().length / this.rulesPageSize)); }
  get incidentsTotalPages(): number { return Math.max(1, Math.ceil(this.incidents().length / this.incidentsPageSize)); }
  get rulesFirstRow(): number { return this.firstRow(this.rules().length, this.rulesPage(), this.rulesPageSize); }
  get rulesLastRow(): number { return this.lastRow(this.rules().length, this.rulesPage(), this.rulesPageSize); }
  get incidentsFirstRow(): number { return this.firstRow(this.incidents().length, this.incidentsPage(), this.incidentsPageSize); }
  get incidentsLastRow(): number { return this.lastRow(this.incidents().length, this.incidentsPage(), this.incidentsPageSize); }

  addCondition(): void { this.conditions.push(this.createCondition()); }
  removeCondition(index: number): void { if (this.conditions.length > 1) this.conditions.removeAt(index); }
  changeRulesPageSize(size: number): void { this.rulesPageSize = size; this.rulesPage.set(1); }
  changeIncidentsPageSize(size: number): void { this.incidentsPageSize = size; this.incidentsPage.set(1); }
  previousRulesPage(): void { this.rulesPage.update((page) => Math.max(1, page - 1)); }
  nextRulesPage(): void { this.rulesPage.update((page) => Math.min(this.rulesTotalPages, page + 1)); }
  previousIncidentsPage(): void { this.incidentsPage.update((page) => Math.max(1, page - 1)); }
  nextIncidentsPage(): void { this.incidentsPage.update((page) => Math.min(this.incidentsTotalPages, page + 1)); }

  saveRule(): void {
    if (this.ruleForm.invalid || this.ruleForm.pending || this.saving) {
      this.ruleForm.markAllAsTouched();
      return;
    }
    const value = this.ruleForm.getRawValue();
    const conditions: AlertRuleCondition[] = value.conditions.map((condition) => ({ ...condition }));
    const first = conditions[0];
    const rule: AlertRuleRecord = {
      id: this.editingRuleId ?? `pending-${Date.now()}`, name: value.name.trim(), conditions,
      metric: first.metric, condition: this.toLegacyCondition(first.operator),
      threshold: first.threshold, duration: first.durationSec,
      severity: value.severity, enabled: value.enabled,
    };
    this.saving = true;
    const request = this.editingRuleId ? this.alertRules.updateRule(rule) : this.alertRules.createRule(rule);
    request.subscribe({
      next: () => { this.saving = false; this.savedMessage = 'Rule saved to the backend.'; this.cancelEdit(); },
      error: (error) => {
        this.saving = false;
        this.savedMessage = error?.error?.error?.message ?? 'Could not save this rule.';
        this.alertRules.load().subscribe();
      },
    });
  }

  editRule(rule: AlertRuleRecord): void {
    this.editingRuleId = rule.id;
    const conditions = rule.conditions?.length ? rule.conditions : [{
      metric: rule.metric, operator: this.toOperator(rule.condition), threshold: rule.threshold, durationSec: rule.duration,
    }];
    this.conditions.clear();
    for (const condition of conditions) this.conditions.push(this.createCondition(condition));
    this.ruleForm.patchValue({ name: rule.name, severity: rule.severity, enabled: rule.enabled });
    this.ruleForm.markAsPristine();
  }

  cancelEdit(): void {
    this.editingRuleId = null;
    this.conditions.clear();
    this.conditions.push(this.createCondition());
    this.ruleForm.reset({ name: '', severity: 'warning', enabled: true });
  }

  canDeactivate(): boolean {
    return !this.ruleForm.dirty || window.confirm('Discard unsaved alert rule changes?');
  }

  deleteRule(ruleId: string): void {
    this.alertRules.deleteRule(ruleId).subscribe({ error: () => this.savedMessage = 'Could not delete this rule.' });
  }
  toggleRule(ruleId: string): void {
    this.alertRules.toggleRule(ruleId).subscribe({ error: () => this.savedMessage = 'Could not update this rule.' });
  }
  resolveIncident(incidentId: string): void { this.alertRules.resolveIncident(incidentId); }
  metricText(metric: RuleMetric): string {
    if (metric === 'latencyP95') return 'p95 latency';
    if (metric === 'errorRate') return 'error rate';
    return 'requests per second';
  }
  thresholdLabel(metric: RuleMetric): string {
    if (metric === 'latencyP95') return 'Threshold (milliseconds)';
    if (metric === 'errorRate') return 'Threshold (percent)';
    return 'Threshold (requests per second)';
  }
  ruleConditionsText(rule: AlertRuleRecord): string {
    const conditions = rule.conditions?.length ? rule.conditions : [{
      metric: rule.metric, operator: this.toOperator(rule.condition), threshold: rule.threshold, durationSec: rule.duration,
    }];
    return conditions.map((condition) => `${this.metricText(condition.metric)} ${condition.operator} ${condition.threshold}`).join(' AND ');
  }

  private createCondition(value?: AlertRuleCondition): ConditionForm {
    const condition = value ?? { metric: 'latencyP95', operator: '>' as RuleOperator, threshold: 500, durationSec: 5 };
    return new FormGroup({
      metric: new FormControl<RuleMetric>(condition.metric, { nonNullable: true }),
      operator: new FormControl<RuleOperator>(condition.operator, { nonNullable: true }),
      threshold: new FormControl(condition.threshold, { nonNullable: true, validators: [Validators.required, validThreshold] }),
      durationSec: new FormControl(condition.durationSec, { nonNullable: true, validators: [Validators.required, Validators.min(1), Validators.max(3600)] }),
    }, { validators: conditionFieldsMatch });
  }
  private toLegacyCondition(operator: RuleOperator): AlertRuleRecord['condition'] {
    if (operator === '>') return 'greaterThan';
    if (operator === '>=') return 'greaterThanOrEqual';
    if (operator === '<') return 'lessThan';
    return 'lessThanOrEqual';
  }
  private toOperator(condition: AlertRuleRecord['condition']): RuleOperator {
    if (condition === 'greaterThan') return '>';
    if (condition === 'greaterThanOrEqual') return '>=';
    if (condition === 'lessThan') return '<';
    return '<=';
  }
  private firstRow(total: number, page: number, size: number): number { return total === 0 ? 0 : (page - 1) * size + 1; }
  private lastRow(total: number, page: number, size: number): number { return Math.min(page * size, total); }
}
