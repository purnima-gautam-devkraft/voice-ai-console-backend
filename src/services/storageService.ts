/**
 * Storage facade — picks between Supabase (production) and file-based
 * storage (local dev) based on whether Supabase env vars are set.
 *
 * Routes always import from here; they don't care which backend is active.
 *
 * To use Supabase locally, copy SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
 * into backend/.env. Otherwise data is stored in ./data/uploads.json.
 */
import * as supabaseStorage from './supabaseStorage';
import * as fileStorage from './fileStorage';
import { getSupabase } from '../lib/supabase';
import { TELEPHONY_PROVIDERS, TelephonyProvider } from '../config/constants';
import { AGENT_MAPPING, AgentMapping } from '../config/agentMapping';

export type { SaveUploadInput } from './supabaseStorage';

const USE_SUPABASE = !!(
  process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
);

if (USE_SUPABASE) {
  // eslint-disable-next-line no-console
  console.log('[storage] Using Supabase (SUPABASE_URL detected)');
} else {
  // eslint-disable-next-line no-console
  console.log('[storage] Using local file storage at ./data/uploads.json — set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in .env to switch to Supabase');
}

const impl = USE_SUPABASE ? supabaseStorage : fileStorage;

export const saveUploadRecord  = impl.saveUploadRecord;
export const getUploadRecord   = impl.getUploadRecord;
export const getUploadErrors   = impl.getUploadErrors;
export const getUploadRows     = impl.getUploadRows;
export const getRawFile        = impl.getRawFile;
export const listUploads       = impl.listUploads;
export const getStats          = impl.getStats;

/**
 * Fetch telephony providers from Supabase when configured, falling back to
 * the hardcoded TELEPHONY_PROVIDERS constant for local dev without Supabase.
 */
export async function getTelephonyProviders(): Promise<TelephonyProvider[]> {
  if (!USE_SUPABASE) return TELEPHONY_PROVIDERS;
  try {
    const { data, error } = await getSupabase()
      .from('telephony_providers')
      .select('id, provider_name, from_number, country')
      .order('created_at', { ascending: true });
    if (error || !data || data.length === 0) return TELEPHONY_PROVIDERS;
    return data.map((r: { id: string; provider_name: string; from_number: string; country: string }) => ({
      id: r.id,
      providerName: r.provider_name,
      fromNumber: r.from_number,
      country:    r.country,
    }));
  } catch {
    return TELEPHONY_PROVIDERS;
  }
}

/**
 * Fetch agent mappings from Supabase when configured, falling back to the
 * hardcoded AGENT_MAPPING constant for local dev without Supabase.
 * This is the live source of truth for the agent_mappings screen.
 */
export async function getAgentMappings(): Promise<AgentMapping[]> {
  if (!USE_SUPABASE) return AGENT_MAPPING;
  try {
    const { data, error } = await getSupabase()
      .from('agent_mappings')
      .select('agent_name, agent_id')
      .order('created_at', { ascending: true });
    if (error || !data || data.length === 0) return AGENT_MAPPING;
    return data.map((r: { agent_name: string; agent_id: string }) => ({
      agentName: r.agent_name,
      agentId:   r.agent_id,
    }));
  } catch {
    return AGENT_MAPPING;
  }
}
