export type Service = {
  id: string;
  name: string;
  serviceId: string;
  displayType: string;
  serviceTypeId: string | null;
};

export type KioskState = {
  urlTemplate: string;
  activeServiceId: string | null;
  services: Service[];
  kiosk: { connected: boolean; idleUrl: string };
  pco: { configured: boolean; viaEnv: boolean };
  remote: { active: boolean };
  displayTypes: string[];
  themes: string[];
  defaultDisplayType: string | null;
  defaultTheme: string | null;
  tv: { available: boolean; autoOn: boolean; leadMinutes: number };
  reboot: { cron: string | null };
  platform: { os: string };
  wifi: { supported: boolean };
  adminConfigured: boolean;
  version: string;
  updatePrereleases: boolean;
  canApplyUpdate: boolean;
};

export type AuthStatus = {
  authenticated: boolean;
  setupRequired: boolean;
};

export type PcoPlan = {
  id: string;
  serviceTypeId: string;
  serviceTypeName: string;
  sortDate: string | null;
  shortDates: string | null;
  dates: string | null;
  title: string;
  folderName?: string;
  existing?: boolean;
};

export type PcoGroup = {
  id: string;
  name: string;
  isFolder: boolean;
  serviceTypes: Array<{
    id: string;
    name: string;
    plans: PcoPlan[];
  }>;
};

export type ApiError = Error & { status?: number; detail?: string };
