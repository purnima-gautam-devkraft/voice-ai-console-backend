import { ValidationResult, ErrorRow, AgentUseCase, TimezoneWarning, ContactCountryWarning } from '../types';
import { AGENT_IDS, AGENT_DISPLAY_NAMES, COUNTRY_TIMEZONE_MAP, PHONE_CODE_COUNTRIES, COUNTRY_NAME_CANONICAL } from '../config/constants';
// AGENT_IDS is the hardcoded fallback; callers should pass the live expectedAgentId resolved from getAgentMappings().
import {
  validateUserContact,
  normalizeFromNumber,
  parseDateToISO,
  parseTimeToHHMM,
  convertTimezoneHHMM,
} from './csvService';

/**
 * Detect which countries are implied by a phone number's country code.
 * Strips leading +/0, then tries longest prefix first.
 * Returns null when no recognised prefix is found.
 */
function detectPhoneCountries(raw: string): { code: string; countries: string[] } | null {
  const digits = String(raw ?? '').trim().replace(/^\+/, '').replace(/^0+/, '');
  for (const [code, countries] of PHONE_CODE_COUNTRIES) {
    if (countries.length > 0 && digits.startsWith(code)) {
      return { code, countries };
    }
  }
  return null;
}

/**
 * Agent-based upload validation: mandatory columns must all be present
 * (mandatory-list model), AND every row's `agent_id` must match the fixed
 * agent ID registered for the selected use case (see AGENT_IDS). This
 * catches the client uploading data meant for one agent under the wrong
 * agent/use-case selection.
 */
export function validateAgentData(
  rows: Record<string, string>[],
  mandatoryColumns: string[],
  agentType: AgentUseCase,
  confirmCorrections = false,
  confirmContactCorrections = false,
  allowedFromNumbers: Set<string> = new Set(),
  expectedAgentId?: string
): ValidationResult {
  // Use the live agent ID passed from the caller (fetched from Supabase agent_mappings),
  // falling back to the hardcoded constant for local dev without Supabase.
  const resolvedAgentId = expectedAgentId ?? AGENT_IDS[agentType];
  const valid: Record<string, string>[] = [];
  const errors: ErrorRow[] = [];
  let dateAutoCorrected = 0;
  let timeAutoCorrected = 0;
  let fromNumberNormalized = 0;
  let countryNameNormalized = 0;
  // key: "country||supplied||correct" → entry
  const tzWarnMap = new Map<string, { country: string; suppliedTimezone: string; correctTimezone: string; rowCount: number }>();
  // key: "detectedCountry||suppliedCountry||suppliedTz" → entry
  const contactWarnMap = new Map<string, { detectedCountry: string; suppliedCountry: string; suppliedTimezone: string; suggestedTimezone: string; rowCount: number }>();

  rows.forEach((row, index) => {
    const messages: string[] = [];

    // 1. Mandatory columns must all be present and non-empty.
    const missingColumns: string[] = [];
    for (const col of mandatoryColumns) {
      const value = row[col];
      if (value === undefined || value === null || String(value).trim() === '') {
        missingColumns.push(col);
      }
    }
    if (missingColumns.length > 0) {
      messages.push(`Missing required fields: ${missingColumns.join(', ')}`);
    }

    // 2. agent_id must match the live ID from the agent mapping screen.
    if (missingColumns.indexOf('agent_id') === -1) {
      const actualAgentId = String(row['agent_id'] || '').trim();
      if (actualAgentId !== resolvedAgentId) {
        messages.push(
          `agent_id "${actualAgentId || '(empty)'}" does not match the required agent_id ` +
          `"${resolvedAgentId}" for ${AGENT_DISPLAY_NAMES[agentType]}`
        );
      }
    }

    // 1b. Normalize user_country_of_residence to canonical form.
    if (row['user_country_of_residence']) {
      const raw = String(row['user_country_of_residence']).trim();
      const canonical = COUNTRY_NAME_CANONICAL[raw.toLowerCase()];
      if (canonical && canonical !== raw) {
        row['user_country_of_residence'] = canonical;
        countryNameNormalized++;
      }
    }

    // 3. user_contact — reject scientific-notation corruption.
    if (missingColumns.indexOf('user_contact') === -1) {
      const contactError = validateUserContact(row['user_contact']);
      if (contactError) messages.push(contactError);
    }

    // 3b. Contact-country triangulation: detect country from phone code and
    //     compare with user_country_of_residence + timezone.
    //     Runs only when both user_contact and user_country_of_residence are present.
    const contactPresent = missingColumns.indexOf('user_contact') === -1;
    const countryPresent  = missingColumns.indexOf('user_country_of_residence') === -1;
    if (contactPresent && countryPresent) {
      const detected = detectPhoneCountries(row['user_contact']);
      if (detected) {
        const suppliedCountry = String(row['user_country_of_residence'] || '').trim();
        // Check whether supplied country is in the detected set
        const countryMatch = detected.countries.some(
          (c) => c.toLowerCase() === suppliedCountry.toLowerCase()
        );
        if (!countryMatch) {
          const detectedCountry = detected.countries[0];
          const suppliedTz = String(row['timezone'] || '').trim() || '(blank)';
          const suggestedTz = COUNTRY_TIMEZONE_MAP[detectedCountry.toLowerCase()] || '';
          const key = `${detectedCountry}||${suppliedCountry}||${suppliedTz}`;
          const existing = contactWarnMap.get(key);
          if (existing) {
            existing.rowCount++;
          } else {
            contactWarnMap.set(key, {
              detectedCountry,
              suppliedCountry,
              suppliedTimezone: suppliedTz,
              suggestedTimezone: suggestedTz,
              rowCount: 1,
            });
          }
          if (confirmContactCorrections) {
            row['user_country_of_residence'] = detectedCountry;
            if (suggestedTz) row['timezone'] = suggestedTz;
          }
        }
      }
    }

    // 4. from_number — normalize (restore leading 0 for India, add + for international),
    //    then verify it exists in the live telephony-providers list.
    if (missingColumns.indexOf('from_number') === -1) {
      const normalized = normalizeFromNumber(row['from_number']);
      if (!allowedFromNumbers.has(normalized)) {
        const allowed = Array.from(allowedFromNumbers).join(', ');
        messages.push(
          `from_number "${normalized}" is not registered in the Telephony Providers console. ` +
          `Allowed numbers: ${allowed}.`
        );
      } else {
        if (normalized !== row['from_number']) fromNumberNormalized++;
        row['from_number'] = normalized;
      }
    }

    // 5. date_of_call — auto-normalize to YYYY-MM-DD. Accept any parseable format.
    if (missingColumns.indexOf('date_of_call') === -1) {
      const iso = parseDateToISO(row['date_of_call']);
      if (iso === null) {
        messages.push(`date_of_call "${row['date_of_call']}" is not a recognizable date. Use YYYY-MM-DD, DD-MM-YYYY, M/D/YYYY, or DD Mon YYYY (e.g. 23 Oct 2026).`);
      } else if (iso !== row['date_of_call']) {
        row['date_of_call'] = iso;
        dateAutoCorrected++;
      }
    }

    // 6. time_of_call — auto-normalize to HH:MM 24-hour. Accept 12-hour AM/PM too.
    if (missingColumns.indexOf('time_of_call') === -1) {
      const hhmm = parseTimeToHHMM(row['time_of_call']);
      if (hhmm === null) {
        messages.push(`time_of_call "${row['time_of_call']}" is not a recognizable time. Use HH:MM (24-hour) or H:MM AM/PM.`);
      } else if (hhmm !== row['time_of_call']) {
        row['time_of_call'] = hhmm;
        timeAutoCorrected++;
      }
    }

    // 7. timezone — if the country is in COUNTRY_TIMEZONE_MAP, warn when the
    //    supplied timezone doesn't match the canonical value; apply correction
    //    only when confirmCorrections=true. Unknown countries are allowed through
    //    without timezone validation.
    if (missingColumns.indexOf('user_country_of_residence') === -1) {
      const rawCountry = String(row['user_country_of_residence'] || '').trim();
      const canonicalTz = COUNTRY_TIMEZONE_MAP[rawCountry.toLowerCase()];
      if (canonicalTz && row['timezone'] !== canonicalTz) {
        const supplied = String(row['timezone'] || '').trim() || '(blank)';
        const key = `${rawCountry}||${supplied}||${canonicalTz}`;
        const existing = tzWarnMap.get(key);
        if (existing) { existing.rowCount++; } else {
          tzWarnMap.set(key, { country: rawCountry, suppliedTimezone: supplied, correctTimezone: canonicalTz, rowCount: 1 });
        }
        if (confirmCorrections) {
          row['timezone'] = canonicalTz;
        }
      }
    }

    // 8. IST-to-local conversion and calling-hours check (10:00–19:00).
    //
    //    • If the supplied timezone is IST (Asia/Kolkata) and the target
    //      country's canonical timezone is different, convert time_of_call
    //      from IST to the country's local timezone and update the row.
    //
    //    • After any conversion, check that the time falls within 10:00–19:00
    //      in the effective local timezone. Times outside this window are a
    //      hard error — the row is rejected.
    //
    //    Runs only when both date and time were successfully normalised (so the
    //    conversion receives clean inputs). Accumulates alongside other errors.
    {
      const timeIsValid = /^\d{2}:\d{2}$/.test(String(row['time_of_call'] || ''));
      const dateIsValid = /^\d{4}-\d{2}-\d{2}$/.test(String(row['date_of_call'] || ''));
      const hasTimeCol  = missingColumns.indexOf('time_of_call') === -1;
      const hasDateCol  = missingColumns.indexOf('date_of_call') === -1;

      if (hasTimeCol && hasDateCol && timeIsValid && dateIsValid) {
        const rawCountry = String(row['user_country_of_residence'] || '').trim();
        const suppliedTz = String(row['timezone'] || '').trim();

        // Canonical timezone for the country; fall back to supplied value when unknown.
        const canonicalTz = COUNTRY_TIMEZONE_MAP[rawCountry.toLowerCase()] || suppliedTz;

        let callTime = row['time_of_call'];

        // Detect IST: either the IANA name, the abbreviation, or the full name.
        const isIST =
          suppliedTz === 'Asia/Kolkata' ||
          suppliedTz.toUpperCase() === 'IST' ||
          suppliedTz === 'Indian Standard Time';

        if (isIST && canonicalTz && canonicalTz !== 'Asia/Kolkata') {
          const converted = convertTimezoneHHMM(
            callTime, row['date_of_call'], 'Asia/Kolkata', canonicalTz
          );
          if (converted !== null) {
            callTime = converted;
            row['time_of_call'] = callTime;
          }
        }

        // Calling-hours check in the effective local timezone.
        const [hh, mm] = callTime.split(':').map(Number);
        const totalMin = hh * 60 + mm;
        if (totalMin < 10 * 60 || totalMin >= 19 * 60) {
          const tzLabel = canonicalTz || suppliedTz || 'local timezone';
          messages.push(
            `time_of_call "${callTime}" (${tzLabel}) is outside the allowed calling window ` +
            `10:00–19:00. Please reschedule within this range.`
          );
        }
      }
    }

    // 9. live-session-reminder: Session Day must match the actual weekday of
    //    Session Date, and Session Date must be on or after date_of_call.
    if (agentType === 'live-session-reminder') {
      const rawSessionDate = String(row['Session Date'] || '').trim();
      const rawSessionDay  = String(row['Session Day']  || '').trim();

      if (rawSessionDate) {
        const sessionDateISO = parseDateToISO(rawSessionDate);
        if (!sessionDateISO) {
          messages.push(
            `Session Date "${rawSessionDate}" is not a recognizable date. ` +
            `Use YYYY-MM-DD, DD-MM-YYYY, M/D/YYYY, or DD Mon YYYY (e.g. 01 Nov 2026).`
          );
        } else {
          // Check Session Day matches the actual weekday of Session Date.
          if (rawSessionDay) {
            const WEEKDAYS_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
            const WEEKDAYS_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
            const [sy, sm, sd] = sessionDateISO.split('-').map(Number);
            const dayIndex  = new Date(Date.UTC(sy, sm - 1, sd)).getUTCDay();
            const actualFull = WEEKDAYS_FULL[dayIndex];
            const actualAbbr = WEEKDAYS_ABBR[dayIndex];
            const supplied   = rawSessionDay.toLowerCase();
            if (
              supplied !== actualFull.toLowerCase() &&
              supplied !== actualAbbr.toLowerCase()
            ) {
              messages.push(
                `Session Day "${rawSessionDay}" does not match Session Date "${rawSessionDate}" ` +
                `which falls on a ${actualFull}.`
              );
            }
          }

          // Session Date must be on or after date_of_call.
          const callDateISO = String(row['date_of_call'] || '').trim();
          if (callDateISO && /^\d{4}-\d{2}-\d{2}$/.test(callDateISO)) {
            if (sessionDateISO < callDateISO) {
              messages.push(
                `Session Date "${rawSessionDate}" (${sessionDateISO}) is before ` +
                `date_of_call (${callDateISO}). The session must be on or after the call date.`
              );
            }
          }
        }
      }
    }

    if (messages.length === 0) {
      valid.push(row);
      return;
    }

    errors.push({
      rowNumber: index + 2,
      data: row,
      errorMessage: messages.join('; '),
    });
  });

  const timezoneWarnings: TimezoneWarning[] = Array.from(tzWarnMap.values());
  const contactCountryWarnings: ContactCountryWarning[] = Array.from(contactWarnMap.values());
  return { valid, errors, dateAutoCorrected, timeAutoCorrected, fromNumberNormalized, countryNameNormalized, timezoneWarnings, contactCountryWarnings };
}
