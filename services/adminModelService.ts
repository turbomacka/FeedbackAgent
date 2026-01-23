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

export interface ModelProvider {
  id: string;
  label: string;
  type: 'native-google' | 'openai-compatible';
  enabled: boolean;
  baseUrl?: string;
  secretName?: string;
  location?: string;
  capabilities?: {
    chat?: boolean;
    embeddings?: boolean;
    jsonMode?: boolean;
  };
  manualModelIds?: string[];
  syncedModels?: { id: string; label: string }[];
  filterRegex?: string;
  lastSyncedAt?: number | null;
}

export interface ModelTaskConfig {
  providerId: string;
  model: string;
  priceInput1M?: string;
  priceOutput1M?: string;
}

export interface ModelRoutingConfig {
  tasks: Record<string, ModelTaskConfig>;
  embeddings: ModelTaskConfig;
  safeAssessment: ModelTaskConfig;
  pricingCurrency: string;
  health?: Record<string, { status: 'ok' | 'error'; checkedAt: number; message?: string }>;
}

export async function getAdminModelConfig(): Promise<{ providers: ModelProvider[]; routing: ModelRoutingConfig; allowlist: string[] }> {
  return requestAuth('/admin/model-config', 'GET');
}

export async function updateAdminModelConfig(
  routing: ModelRoutingConfig,
  allowlist?: string[]
): Promise<{ ok: boolean; routing: ModelRoutingConfig }> {
  return postAuth('/admin/model-config', { routing, allowlist });
}

export async function syncModelProvider(providerId: string): Promise<{ provider: ModelProvider }> {
  return postAuth('/admin/providers/sync', { providerId });
}

export async function updateModelProvider(
  providerId: string,
  updates: Partial<Pick<ModelProvider, 'enabled' | 'label' | 'secretName' | 'location' | 'baseUrl' | 'capabilities' | 'filterRegex' | 'manualModelIds'>>
): Promise<{ provider: ModelProvider }> {
  return postAuth('/admin/providers', { providerId, updates });
}
