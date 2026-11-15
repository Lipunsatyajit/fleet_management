export type ServiceStatus = 'Healthy' | 'Warning' | 'Critical' | 'Offline';
export type BackendServiceStatus = 'healthy' | 'degraded' | 'down';
export type RuleMetric = 'latencyP95' | 'errorRate' | 'requestsPerSecond';
export type RuleOperator = '>' | '>=' | '<' | '<=';

export interface BackendServiceRecord {
  id: string;
  name: string;
  team: string;
  region?: string;
  status: BackendServiceStatus;
}

export interface MetricEvent {
  type: 'metric';
  offset: number;
  serviceId: string;
  seq: number;
  ts: number;
  p95: number;
  errRate: number;
  rps: number;
  status: BackendServiceStatus;
}

export interface BackendMetricRecord {
  type?: 'metric';
  offset?: number;
  serviceId: string;
  seq?: number;
  ts: number;
  p95: number;
  errRate: number;
  rps: number;
  status?: BackendServiceStatus;
}

export interface MetricSnapshot {
  offset: number;
  ts: number;
  metrics: BackendMetricRecord[];
}

export interface MetricHistoryPoint {
  serviceId: string;
  ts: number;
  p95: number;
  errRate: number;
  rps: number;
}

export interface BackendRuleCondition {
  metric: 'p95' | 'errRate' | 'rps';
  operator: RuleOperator;
  threshold: number;
  durationSec: number;
}

export interface BackendAlertRule {
  id: string;
  name: string;
  conditions: BackendRuleCondition[];
  createdAt: string;
  updatedAt: string;
  severity?: 'info' | 'warning' | 'critical';
  enabled?: boolean;
}

export interface AlertRuleCondition {
  metric: RuleMetric;
  operator: RuleOperator;
  threshold: number;
  durationSec: number;
}

export interface AuthUserResponse {
  id: string;
  email: string;
  role: UserRole;
}

export interface AuthResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: AuthUserResponse;
}

export interface ServiceRecord {
  id: string;
  name: string;
  team: string;
  region: string;
  status: ServiceStatus;
  latency: number;
  errorRate: number;
  requestsPerSecond: number;
  lastUpdated: string;
}

export interface ServiceMetricRecord {
  serviceId: string;
  timestamp: string;
  latencyP95: number;
  errorRate: number;
  requestsPerSecond: number;
}

export interface SimulatedMetricEvent {
  sequence: number;
  serviceId: string;
  timestamp: string;
  latencyP95: number;
  errorRate: number;
  requestsPerSecond: number;
}

export interface AlertRuleRecord {
  id: string;
  name: string;
  metric: RuleMetric;
  condition: 'greaterThan' | 'greaterThanOrEqual' | 'lessThan' | 'lessThanOrEqual';
  threshold: number;
  duration: number;
  enabled: boolean;
  severity: 'info' | 'warning' | 'critical';
  conditions?: AlertRuleCondition[];
}

export interface IncidentRecord {
  id: string;
  ruleId: string;
  ruleName: string;
  serviceId: string;
  serviceName: string;
  severity: AlertRuleRecord['severity'];
  triggeredAt: string;
  currentValue: number;
  status: 'open' | 'resolved';
}

export type UserRole = 'viewer' | 'operator';

export interface DemoUserRecord {
  username: string;
  password: string;
  role: UserRole;
  displayName: string;
}
