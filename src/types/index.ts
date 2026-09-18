export type UserRole = 'system_admin' | 'data_manager' | 'support_agent';

export interface User {
  id: string;
  email: string;
  name: string;
  role: UserRole;
}

export interface JwtPayload {
  userId: string;
  email: string;
  role: UserRole;
}

export interface AuthenticatedRequest extends Express.Request {
  user?: JwtPayload;
}

export type CallType = 'Live' | 'Test';

export type University = 'GGU' | 'Edgewood' | 'ESGCI' | 'Waterloo' | 'ParisBusinessSchool';

export type AgentUseCase =
  | 'live-session-reminder'
  | 'deferral-request'
  | 'missed-assignment-deadline'
  | 'new-program-onboarding'
  | 'deadline-reminder';

/** Every upload is tagged with the agent/use-case it was prepared for. */
export type DataType = AgentUseCase;

export interface UploadRecord {
  uploadId: string;
  fileName: string;
  dataType: DataType;
  university?: University;
  program?: string;
  callType?: CallType;
  uploadedAt: string;
  uploadedBy: string;
  totalRows: number;
  validRows: number;
  errorRows: number;
  status: 'success' | 'partial' | 'failed';
}

/**
 * What kind of thing happened. Drives the audit log feed.
 *  - upload:             an agent-data file was uploaded
 *  - unified_generated:  a unified Voice-AI XLSX was generated for a clean agent-data upload
 *  - s3_archived:        the unified XLSX was archived to S3
 *  - scheduler_notified: the downstream Voice-AI scheduler was pinged about a new unified file
 */
export type AuditEventType =
  | 'upload'
  | 'unified_generated'
  | 's3_archived'
  | 'scheduler_notified';

export interface AuditEvent {
  id: string;
  eventType: AuditEventType;
  /** Present for `upload` events. */
  dataType?: DataType;
  /** The upload this event is tied to. */
  uploadId: string;
  university?: string;
  program?: string;
  fileName?: string;
  actorEmail?: string;
  actorRole?: string;
  status: 'success' | 'failed';
  /** Free-form extra context: S3 keys, row counts, error/skip reason, scheduler HTTP status. */
  detail?: Record<string, unknown>;
  createdAt: string;
}

export interface StoredData {
  uploadId: string;
  dataType: DataType;
  university?: University;
  program?: string;
  rows: Record<string, string>[];
  uploadedAt: string;
}

export interface ErrorRow {
  rowNumber: number;
  data: Record<string, string>;
  errorMessage: string;
}

export interface TimezoneWarning {
  country: string;
  suppliedTimezone: string;
  correctTimezone: string;
  rowCount: number;
}

export interface ValidationResult {
  valid: Record<string, string>[];
  errors: ErrorRow[];
  dateAutoCorrected: number;
  timeAutoCorrected: number;
  timezoneWarnings: TimezoneWarning[];
}

export interface UploadResult {
  uploadId: string;
  totalRows: number;
  validRows: number;
  errorRows: number;
  errors: ErrorRow[];
  data: Record<string, string>[];
}

// Augment Express Request
declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}
