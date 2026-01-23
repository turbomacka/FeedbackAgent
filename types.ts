
export interface ReferenceMaterial {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  status: 'uploaded' | 'processing' | 'ready' | 'failed' | 'needs_review';
  gcsPath?: string;
  error?: string;
  errorCode?: string;
  tokenCount?: number;
  tokenLimit?: number;
  forceTrim?: boolean;
}

export type StringencyLevel = 'generous' | 'standard' | 'strict';

export interface CriterionMatrixItem {
  id: string;
  name: string;
  description: string;
  indicator: string;
  translations?: {
    sv?: { name?: string; description?: string; indicator?: string };
    en?: { name?: string; description?: string; indicator?: string };
  };
  indicator_status?: 'ok' | 'cannot_operationalize' | 'needs_generation';
  indicator_actor?: string;
  indicator_verb?: string;
  indicator_object?: string;
  indicator_artifact?: string;
  indicator_evidence_min?: string;
  indicator_quality?: string;
  indicator_source_trace?: {
    object: string[];
    evidence_min: string[];
    quality: string[];
  };
  bloom_level: string;
  bloom_index: number;
  reliability_score: number;
  weight: number;
  clarity_label?: 'OTYDLIG' | 'MELLAN' | 'TYDLIG';
  clarity_debug?: {
    actor: string;
    verb: string;
    object: string;
    evidence: string;
  };
}

export interface Agent {
  id: string;
  name: string;
  description: string;
  criteria?: string[];
  criteria_matrix?: CriterionMatrixItem[];
  criteriaLanguage?: 'sv' | 'en';
  wordCountLimit: { min: number; max: number };
  passThreshold: number; 
  verificationPrefix?: number;
  stringency: StringencyLevel;
  ownerEmail: string; // E-post till skaparen
  ownerUid: string;
  sharedWithEmails: string[]; // Lista på e-postadresser som har tillgång
  sharedWithUids: string[];
  visibleTo: string[];
  isPublic: boolean;
  isDraft?: boolean;
  showSubmissionPrompt?: boolean;
  showVerificationCode?: boolean;
}

export interface AssessmentJSON {
  formalia: {
    status: 'PASS' | 'FAIL';
    word_count: number;
    ref_check: 'OK' | 'MISSING';
  };
  criteria_results: {
    id: string;
    met: boolean;
    score: number; // 0..1
    evidence: string;
  }[];
  final_metrics: {
    score_100k: number;
    reliability_index: number;
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
  sessionId?: string;
  stringency: StringencyLevel; 
  visibleTo: string[];
  criteria_matrix?: CriterionMatrixItem[];
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
