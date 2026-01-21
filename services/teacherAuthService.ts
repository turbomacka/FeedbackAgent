import { auth } from '../firebase';

const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api';

async function requestAuth<T>(path: string, method: 'GET' | 'POST', payload?: Record<string, unknown>): Promise<T> {
  const token = await auth.currentUser?.getIdToken();
  if (!token) {
    throw new Error('Not authenticated.');
  }

  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: payload ? JSON.stringify(payload) : undefined
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `Request failed: ${response.status}`);
  }

  return response.json() as Promise<T>;
}

function postAuth<T>(path: string, payload: Record<string, unknown>): Promise<T> {
  return requestAuth(path, 'POST', payload);
}

export async function authorizeTeacher(promoCode: string): Promise<{ ok: boolean }> {
  return postAuth('/teacher/authorize', { promoCode });
}

export async function acceptTeacherTos(tosVersion: string): Promise<{ ok: boolean }> {
  return postAuth('/teacher/accept-tos', { tosVersion });
}

export interface PromoCodeEntry {
  id: string;
  code: string;
  active: boolean;
  maxUses: number;
  currentUses: number;
  orgId?: string | null;
  createdAt?: number | null;
}

export async function listPromoCodes(): Promise<PromoCodeEntry[]> {
  const { codes } = await requestAuth<{ codes: PromoCodeEntry[] }>('/teacher/promo-codes', 'GET');
  return codes;
}

export async function createPromoCode(payload: { code?: string; maxUses?: number; orgId?: string | null }): Promise<{ code: string }> {
  return postAuth('/teacher/promo-codes', payload);
}

export async function disablePromoCode(code: string): Promise<{ ok: boolean }> {
  return postAuth('/teacher/promo-codes/disable', { code });
}
