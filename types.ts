
export interface ReferenceMaterial {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  status: 'uploaded' | 'processing' | 'ready' | 'failed';
  gcsPath?: string;
}

export type StringencyLevel = 'generous' | 'standard' | 'strict';

export interface Agent {
  id: string;
  name: string;
  description: string;
  criteria: string[];
  wordCountLimit: { min: number; max: number };
  passThreshold: number; 
  stringency: StringencyLevel;
  ownerEmail: string; // E-post till skaparen
  ownerUid: string;
  sharedWithEmails: string[]; // Lista på e-postadresser som har tillgång
  sharedWithUids: string[];
  visibleTo: string[];
  isPublic: boolean;
  isDraft?: boolean;
}

export interface AssessmentJSON {
  formalia: {
    status: 'PASS' | 'FAIL';
    word_count: number;
    ref_check: 'OK' | 'MISSING';
  };
  criteria_scores: {
    id: string;
    level: 'Critical Miss' | 'OK' | 'Excellent';
    score: number; // 0, 1, or 2
  }[];
  final_metrics: {
    score_100k: number; 
  };
  teacher_insights: {
    common_errors: string[];
    strengths: string[];
    teaching_actions: string[]; 
  };
}

export interface FeedbackResult {
  studentText: string;
  pedagogicalFeedback: string;
  assessment: AssessmentJSON;
  verificationCode: string;
  timestamp: number;
  language: 'sv' | 'en';
  stringencyUsed: StringencyLevel;
}

export interface Submission {
  agentId: string;
  verificationCode: string;
  score: number;
  timestamp: number;
  stringency: StringencyLevel; 
  visibleTo: string[];
  insights: {
    common_errors: string[];
    strengths: string[];
    teaching_actions: string[]; 
  };
}

export interface AppState {
  view: 'teacher' | 'student';
  selectedAgentId: string | null;
}
