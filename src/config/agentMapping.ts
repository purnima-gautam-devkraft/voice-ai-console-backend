/**
 * Voice AI agent mapping: human-readable agent name → backend agent ID.
 *
 * AGENT_MAPPING is the hardcoded fallback used when Supabase is unavailable
 * (local dev without env vars). Production always fetches live from the
 * `agent_mappings` Supabase table via getAgentMappings() in storageService.
 *
 * AGENT_USE_CASE_NAMES maps each internal AgentUseCase key to the exact
 * agent name stored in the `agent_mappings` table — used to resolve the
 * expected agent_id for the selected use case at upload time.
 */
import { AgentUseCase } from '../types';

export interface AgentMapping {
  agentName: string;
  agentId: string;
}

export const AGENT_MAPPING: AgentMapping[] = [
  { agentName: 'Live Session Reminder Call Agent',                     agentId: '6a4f8a16008496639b3b25fb' },
  { agentName: 'Deferral Request (Work or Personal Demands) Agent',    agentId: '6a16dc61ba7c5d66b6c4d21b' },
  { agentName: 'Missed Assignment Deadline Extension Agent',           agentId: '6a16d626ba7c5d66b6c4d0c6' },
  { agentName: 'New Batch Onboarding Call Agent',                      agentId: '6a16bd59ba7c5d66b6c4cee9' },
  { agentName: 'Assignment Deadline Reminder Agent',                   agentId: '6a5f3d6e4b06e6a040d16d04' },
];

/** Maps each upload use case to the exact agent name in the Supabase agent_mappings table. */
export const AGENT_USE_CASE_NAMES: Record<AgentUseCase, string> = {
  'live-session-reminder':      'Live Session Reminder Call Agent',
  'deferral-request':           'Deferral Request (Work or Personal Demands) Agent',
  'missed-assignment-deadline': 'Missed Assignment Deadline Extension Agent',
  'new-program-onboarding':     'New Batch Onboarding Call Agent',
  'deadline-reminder':          'Assignment Deadline Reminder Agent',
};
