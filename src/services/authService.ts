import { getSupabase } from '../lib/supabase';
import { User, UserRole } from '../types';

const USE_SUPABASE = !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);

// Local dev users — only active when Supabase is not configured.
const LOCAL_USERS: (User & { password: string })[] = [
  { id: 'local-admin', email: 'admin@voiceai.com', name: 'Admin', role: 'system_admin', password: 'admin123' },
  { id: 'local-dm',    email: 'dm@voiceai.com',    name: 'Data Manager', role: 'data_manager', password: 'dm123' },
];

function userFromSupabase(su: {
  id: string;
  email?: string;
  user_metadata?: Record<string, unknown>;
}): User {
  const meta = su.user_metadata ?? {};
  return {
    id: su.id,
    email: su.email ?? '',
    name: (meta.name as string) ?? su.email ?? '',
    role: (meta.role as UserRole) ?? 'support_agent',
  };
}

export async function signInWithSupabase(email: string, password: string): Promise<User | null> {
  if (!USE_SUPABASE) {
    const match = LOCAL_USERS.find((u) => u.email === email && u.password === password);
    if (!match) return null;
    const { password: _pw, ...user } = match;
    return user;
  }
  const { data, error } = await getSupabase().auth.signInWithPassword({ email, password });
  if (error || !data.user) return null;
  return userFromSupabase(data.user);
}

export async function findUserById(userId: string): Promise<User | null> {
  if (!USE_SUPABASE) {
    const match = LOCAL_USERS.find((u) => u.id === userId);
    if (!match) return null;
    const { password: _pw, ...user } = match;
    return user;
  }
  const { data, error } = await getSupabase().auth.admin.getUserById(userId);
  if (error || !data.user) return null;
  return userFromSupabase(data.user);
}

export function getRoleDisplayName(role: UserRole): string {
  const names: Record<UserRole, string> = {
    system_admin: 'System Administrator',
    data_manager: 'Data Manager',
    support_agent: 'Support Agent',
  };
  return names[role];
}
