
import { AssessmentJSON } from "../types";

const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api';

async function postJson<T>(path: string, payload: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `Request failed: ${response.status}`);
  }

  return response.json() as Promise<T>;
}

export async function improveCriterion(
  sketch: string,
  taskDescription: string,
  agentId: string
): Promise<string> {
  const data = await postJson<{ text: string }>('/criterion/improve', {
    agentId,
    sketch,
    taskDescription
  });
  return data.text;
}

export async function translateContent(
  name: string,
  description: string,
  targetLang: 'sv' | 'en'
): Promise<{ name: string; description: string }> {
  try {
    return await postJson<{ name: string; description: string }>('/translate', {
      name,
      description,
      targetLang
    });
  } catch {
    return { name, description };
  }
}

export async function runAssessment(
  agentId: string,
  studentText: string,
  language: 'sv' | 'en',
  accessToken: string
): Promise<{ assessment: AssessmentJSON; feedback: string; verificationCode: string }> {
  return postJson('/assessment', { agentId, studentText, language, accessToken });
}

export async function validateAccessCode(
  agentId: string,
  accessCode: string
): Promise<{ accessToken: string }> {
  return postJson('/access/validate', { agentId, accessCode });
}

export async function acceptAccessSession(
  agentId: string,
  accessToken: string
): Promise<{ ok: boolean }> {
  return postJson('/access/accept', { agentId, accessToken });
}
