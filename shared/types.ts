export type Json = Record<string, any>;
export interface Credentials {
  appId: string;
  tenant: string;
  password: string;
}
export interface Subscription {
  subscriptionId: string;
  displayName: string;
  state: string;
}
export interface Account {
  id: string;
  label: string;
  appId: string;
  tenant: string;
  subscriptionId: string;
  subscriptionName: string;
  state: string;
  lastSync: number | null;
  createdAt: number;
  error: string | null;
  subscriptions: Subscription[];
}
export interface VirtualMachine {
  id: string;
  accountId: string;
  accountLabel: string;
  name: string;
  resourceGroup: string;
  location: string;
  size: string;
  os: string;
  powerState: string;
  provisioningState: string;
  publicIps: string[];
  privateIps: string[];
  diskSize: number;
  tags: Record<string, string>;
  syncedAt: number;
  resourceId: string;
}
export interface Task {
  id: string;
  accountId: string | null;
  kind: string;
  target: string;
  status: "queued" | "running" | "succeeded" | "failed" | "interrupted";
  progress: string;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  results?: TaskItemResult[];
}
export interface TaskItemResult {
  name: string;
  status: "queued" | "succeeded" | "failed";
  message?: string;
}
export interface BatchDeleteResponse {
  taskId: string | null;
  results: TaskItemResult[];
}
export interface User {
  id: string;
  email: string;
  role: "admin" | "user";
  avatarUrl?: string | null;
}
/** Admin view of a member, including status and usage counts. */
export interface ManagedUser extends User {
  disabled: boolean;
  createdAt: number;
  accounts: number;
  machines: number;
}
export interface Session {
  user: User | null;
  csrf: string;
  writesEnabled: boolean;
}
export interface Overview {
  accounts: number;
  enabled: number;
  machines: number;
  running: number;
  regions: number;
  tasks: Task[];
  recentMachines: VirtualMachine[];
}
export interface Sku {
  name: string;
  cpus: number;
  memory: number;
  generations: string;
  architecture: string;
  restricted: boolean;
}
export interface Location {
  name: string;
  displayName: string;
  regionalDisplayName: string;
  geography: string;
  geographyGroup?: string;
  continent?: string;
}
import type { VmSettings } from "./validation.js";
export interface VmPreset {
  id: string;
  name: string;
  isDefault: boolean;
  settings: VmSettings;
  updatedAt: number;
}
export interface Quota {
  name: string;
  label: string;
  current: number;
  limit: number;
}
export interface MetricPoint {
  time: string;
  cpu: number | null;
  networkIn: number | null;
  networkOut: number | null;
}
export interface Audit {
  id: number;
  action: string;
  target: string;
  createdAt: number;
}
export interface Invite {
  id: string;
  code: string;
  note: string;
  /** 0 means unlimited uses. */
  maxUses: number;
  uses: number;
  /** null means never expires. */
  expiresAt: number | null;
  createdAt: number;
  createdBy: string;
  lastUsedAt: number | null;
}
export interface Session {
  user: User | null;
  csrf: string;
  writesEnabled: boolean;
  registrationOpen: boolean;
}
export interface InviteInput {
  note: string;
  maxUses: number;
  expiresInDays: number | null;
}
