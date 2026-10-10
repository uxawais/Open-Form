export interface Bindings {
  DB: D1Database;
  ENVIRONMENT?: string;
  RESEND_API_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
  ADMIN_TOKEN?: string;
  ABUSE_SECRET?: string;
  [key: string]: unknown;
}

export type ExternalFetch = (url: string, init: RequestInit) => Promise<Response>;
export interface FieldRule {
  type: 'text' | 'email' | 'enum' | 'number';
  required: boolean;
  minLength: number;
  maxLength: number;
  values?: string[];
  min?: number;
  max?: number;
}
export interface EmailTemplate {
  subject: string;
  text: string;
  html?: string;
}
export interface FormConfig {
  enabled: boolean;
  allowedOrigins: string[];
  allowMissingOrigin: boolean;
  retentionDays: number;
  fields: Record<string, FieldRule>;
  emailField?: string;
  honeypot?: string;
  turnstile: { enabled: boolean; hostnames: string[]; action: string; secretBinding: string };
  rateLimit: { max: number; windowSeconds: number };
  duplicateWindowSeconds: number;
  notification: EmailTemplate & { from: { name: string; email: string }; to: string[]; replyTo?: string };
  acknowledgment: Partial<EmailTemplate> & { enabled: boolean; nameField?: string; replyTo?: string };
  redirects: { success?: string; error?: string };
}
export interface Config {
  version: 1;
  limits: { bodyBytes: number; fieldCount: number; emailDaily: number; emailMonthly: number };
  delivery: { batchSize: number; maxAttempts: number; timeoutMs: number; retryWindowHours: number };
  forms: Record<string, FormConfig>;
}
export interface MailPayload {
  from: string;
  to: string[];
  reply_to?: string;
  subject: string;
  text: string;
  html?: string;
  headers: Record<string, string>;
}
export interface Delivery {
  id: string;
  submission_id: string;
  channel: 'notification' | 'acknowledgment';
  status: 'pending' | 'processing' | 'accepted' | 'failed' | 'unknown' | 'skipped';
  payload: string | null;
  cost: number;
  attempts: number;
  first_attempt_at: number | null;
  ambiguous: number;
  next_at: number;
  lease_token: string | null;
  lease_until: number | null;
  provider_id: string | null;
  error_code: string | null;
  created_at: number;
  updated_at: number;
}
export interface DedupeKey { key: string; expiresAt: number; }
export interface SubmissionRow {
  id: string;
  form_id: string;
  fields_json: string;
  created_at: number;
  expires_at: number;
}
