import type { ClinicSettings } from './types';

/** Opening-hours text is informational; timezone is always Asia/Kolkata. */
export type ClinicProfile = Omit<ClinicSettings, 'modules'>;
export type ClinicModules = ClinicSettings['modules'];
export type ClinicConfigurationScope = 'profile' | 'modules';
interface ChangeFields {
  id: string;
  source: 'reviewed' | 'legacy';
  reason: string | null;
  createdByName: string;
  createdAt: string;
}
export type ClinicConfigurationChange = ChangeFields &
  (
    | { scope: 'profile'; before: ClinicProfile; after: ClinicProfile }
    | { scope: 'modules'; before: ClinicModules; after: ClinicModules }
  );
export interface ClinicConfigurationContext {
  settings: ClinicSettings;
  profileRevision: string;
  modulesRevision: string;
  latestProfileChange: Extract<ClinicConfigurationChange, { scope: 'profile' }> | null;
  latestModulesChange: Extract<ClinicConfigurationChange, { scope: 'modules' }> | null;
}
export interface ClinicProfileInput {
  profile: ClinicProfile;
  reason: string;
  expectedRevision: string;
  requestId: string;
}
export interface ClinicModulesInput {
  modules: ClinicModules;
  reason: string;
  expectedRevision: string;
  requestId: string;
}
export interface ClinicConfigurationMutation {
  context: ClinicConfigurationContext;
  change: ClinicConfigurationChange;
  receipt: {
    requestId: string;
    actorId: string;
    scope: ClinicConfigurationScope;
    expectedRevision: string;
    changeId: string;
  };
}
export interface ClinicConfigurationHistory {
  items: ClinicConfigurationChange[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}
