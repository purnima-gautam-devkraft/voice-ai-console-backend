import { AgentUseCase, University } from '../types';

// Updated 2026-07-29 per client-shared university/program list.
export const UNIVERSITIES: Record<University, string[]> = {
  GGU: ['MBA', 'DBA', 'DBA ET', 'MS Management'],
  Edgewood: ['MBA', 'DBA', 'MBA + DBA Dual', 'EdD', 'MeD', 'EdD + MeD Dual'],
  ESGCI: ['DBA'],
  Waterloo: ['AI-CTO'],
  ParisBusinessSchool: ['MBMT'],
};

export const UNIVERSITY_NAMES: Record<University, string> = {
  GGU: 'Golden Gate University',
  Edgewood: 'Edgewood College',
  ESGCI: 'ESGCI Paris',
  Waterloo: 'Waterloo',
  ParisBusinessSchool: 'Paris Business School',
};

// Column order matches the client's reference unified file exactly
// (unified_ggu_assignment_reminder_23_july_2026_final.xlsx): timezone comes
// BEFORE date_of_call / time_of_call. agentDataToXlsxBuffer's numeric-format
// targeting (dateColIdx / timeColIdx) depends on this exact order.
export const UNIFIED_CSV_COLUMNS = [
  'user_id',
  'user_first_name',
  'user_last_name',
  'user_contact',
  'from_number',
  'user_country_of_residence',
  'timezone',
  'date_of_call',
  'time_of_call',
  'reason',
  'agent_id',
  'call_type',
  'user_metadata',
];

export const JWT_EXPIRY = '24h';
export const UPLOADS_DIR = 'uploads';
export const DATA_DIR = 'data';

// ── Agent-based upload definitions ────────────────────────────────────

export const AGENT_USE_CASES: AgentUseCase[] = [
  'live-session-reminder',
  'deferral-request',
  'missed-assignment-deadline',
  'new-program-onboarding',
  'deadline-reminder',
];

export const AGENT_DISPLAY_NAMES: Record<AgentUseCase, string> = {
  'live-session-reminder':    'Live Session Reminder Calling',
  'deferral-request':         'Deferral Request',
  'missed-assignment-deadline': 'Missed Assignment Deadline',
  'new-program-onboarding':   'New Program Onboarding',
  'deadline-reminder':        'Deadline Reminder',
};

// user_last_name is intentionally NOT in this list — it's optional (client
// request 2026-07-27). It still stays a top-level unified-output column
// (see UNIFIED_CSV_COLUMNS); it's just not required to have a value.
export const AGENT_MANDATORY_COLUMNS: string[] = [
  'user_id',
  'user_first_name',
  'user_contact',
  'from_number',
  'user_country_of_residence',
  'timezone',
  'date_of_call',
  'time_of_call',
  'reason',
  'agent_id',
];

export const AGENT_OPTIONAL_COLUMNS: string[] = [
  'Email',
  'Program Name',
  'Cohort ID',
];

/**
 * Telephony providers used for outbound calls, and the from_number each one
 * uses. Currently a single provider/number across all agents and campaigns.
 * Update this when new providers/numbers are added — mirrors AGENT_MAPPING's
 * pattern in config/agentMapping.ts.
 */
export interface TelephonyProvider {
  id?: string;
  providerName: string;
  fromNumber: string;
  country: string;
}

export const TELEPHONY_PROVIDERS: TelephonyProvider[] = [
  { providerName: 'Exotel', fromNumber: '01169323435', country: 'India' },
];

/**
 * Voice AI console agent IDs — each use case maps to one live agent.
 * Uploaded data's `agent_id` column must match the value here for the
 * selected agent, or the row is rejected during validation.
 */
export const AGENT_IDS: Record<AgentUseCase, string> = {
  'deadline-reminder':          '6a5f3d6e4b06e6a040d16d04', // Assignment Deadline Reminder Agent
  'live-session-reminder':      '6a4f8a16008496639b3b25fb', // Live Session Reminder Call Agent
  'deferral-request':           '6a16dc61ba7c5d66b6c4d21b', // Deferral Request (Work or Personal Demands) Agent
  'missed-assignment-deadline': '6a16d626ba7c5d66b6c4d0c6', // Missed Assignment Deadline Extension Agent
  'new-program-onboarding':     '6a16bd59ba7c5d66b6c4cee9', // New Batch Onboarding Call Agent
};

export const AGENT_SPECIFIC_COLUMNS: Record<AgentUseCase, string[]> = {
  'live-session-reminder': [
    'Course',
    'Session Day',
    'Session Date',
    'Session Start Time',
    'Session End Time',
    'Session Type',
    'Session SME/Professor',
    'Session Topic',
  ],
  'deferral-request': [
    'Name of Course Failed',
    'Next Batch start date',
    'Deferral Fees Percentage',
  ],
  'missed-assignment-deadline': [
    'Assignment Name',
    'Assignment Deadline',
    'Extended Assignment Deadline',
  ],
  'new-program-onboarding': [
    'Orientation Date',
    'Welcome Webinar Date',
    'Batch Launch Date',
    'First Graded Course',
    'First Graded Course Start Date',
    'First Live Session Date',
  ],
  'deadline-reminder': [
    'Course Name',
    'Assignment Name',
    'Assignment Deadline',
  ],
};
