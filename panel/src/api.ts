import type { ApiError } from './types';

export async function api<T = unknown>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(opts?.headers || {}) },
    ...opts,
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const err = new Error((data.error as string) || `HTTP ${res.status}`) as ApiError;
    err.status = res.status;
    err.detail = data.detail as string | undefined;
    throw err;
  }
  return data as T;
}
