/**
 * One-time migration script — seeds all application users into Supabase Auth.
 *
 * Safe to re-run: users that already exist in Supabase Auth are skipped.
 * Run BEFORE starting the backend for the first time after the Supabase Auth migration.
 *
 * Usage:
 *   npm run seed:users
 *
 * What it does:
 *   - Creates each user in Supabase Auth with email_confirm: true (no verification email sent)
 *   - Stores name and role in user_metadata (the backend reads these on every login)
 *   - Sets a temporary password — all users MUST change it before going live
 */

import * as dotenv from 'dotenv';
import * as path from 'path';
import { createClient } from '@supabase/supabase-js';

dotenv.config({ path: path.join(__dirname, '../.env') });

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Error: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env');
  process.exit(1);
}

const TEMP_PASSWORD = 'ChangeMe@VoiceAI!';

const USERS = [
  { email: 'admin@voiceai.com',                name: 'Voice AI Superadmin',         role: 'system_admin'  },
  { email: 'swaroop.mendon@upgrad.com',        name: 'Swaroop Mendon',              role: 'system_admin'  },
  { email: 'sandeep.pereira@upgrad.com',       name: 'Sandeep Pereira',             role: 'system_admin'  },
  { email: 'dipika1.carpenter@upgrad.com',     name: 'Dipika Carpenter',            role: 'data_manager' },
  { email: 'hiral.patani@upgrad.com',          name: 'Hiral Kamlesh Patani',        role: 'data_manager'  },
  { email: 'khushbu1.bhadra@upgrad.com',       name: 'Khushbu Sudhir Bhadr',        role: 'data_manager'  },
  { email: 'mukhtar.sayyed@upgrad.com',        name: 'Mukhtar Ali Ali Sayyed',      role: 'data_manager'  },
  { email: 'praveen.shettigar@upgrad.com',     name: 'Praveen Ravindra Shettigar',  role: 'data_manager'  },
  { email: 'michelle.fernandes@upgrad.com',    name: 'Michelle Secelin Fernandes',  role: 'data_manager'  },
  { email: 'akshit1.shetty@upgrad.com',        name: 'Akshit Shetty',               role: 'data_manager'  },
  { email: 'rashmi.rane@upgrad.com',           name: 'Rashmi Rane',                 role: 'data_manager'  },
];

async function seed() {
  const supabase = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  console.log(`\nSeeding ${USERS.length} users into Supabase Auth…\n`);

  let created = 0;
  let skipped = 0;
  let failed  = 0;

  for (const u of USERS) {
    const { data, error } = await supabase.auth.admin.createUser({
      email: u.email,
      password: TEMP_PASSWORD,
      email_confirm: true,
      user_metadata: { name: u.name, role: u.role },
    });

    if (error) {
      if (error.message.toLowerCase().includes('already been registered') ||
          error.message.toLowerCase().includes('already exists')) {
        console.log(`  SKIP  ${u.email}`);
        skipped++;
      } else {
        console.error(`  FAIL  ${u.email} — ${error.message}`);
        failed++;
      }
    } else {
      console.log(`  OK    ${u.email}  (id: ${data.user.id})`);
      created++;
    }
  }

  console.log(`\nDone — created: ${created}, skipped: ${skipped}, failed: ${failed}`);

  if (created > 0) {
    console.log(`\n⚠  Temporary password set for new users: ${TEMP_PASSWORD}`);
    console.log('   Notify each user to change their password before going live.');
    console.log('   Use the Supabase dashboard → Authentication → Users to send a reset email.');
  }

  if (failed > 0) process.exit(1);
}

seed().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
