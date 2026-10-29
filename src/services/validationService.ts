import { ValidationResult, ErrorRow, AgentUseCase, TimezoneWarning, ContactCountryWarning } from '../types';
import { AGENT_IDS, AGENT_DISPLAY_NAMES, COUNTRY_TIMEZONE_MAP, PHONE_CODE_COUNTRIES } from '../config/constants';
import {
  validateUserContact,
  validateFromNumber,
  normalizeFromNumber,
  parseDateToISO,
  parseTimeToHHMM,
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
  confirmContactCorrections = false
): ValidationResult {
  const expectedAgentId = AGENT_IDS[agentType];
  const valid: Record<string, string>[] = [];
  const errors: ErrorRow[] = [];
  let dateAutoCorrected = 0;
  let timeAutoCorrected = 0;
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

    // 2. agent_id must match the fixed ID registered for the selected agent.
    if (missingColumns.indexOf('agent_id') === -1) {
      const actualAgentId = String(row['agent_id'] || '').trim();
      if (actualAgentId !== expectedAgentId) {
        messages.push(
          `agent_id "${actualAgentId || '(empty)'}" does not match the required agent_id ` +
          `"${expectedAgentId}" for ${AGENT_DISPLAY_NAMES[agentType]}`
        );
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

    // 4. from_number — auto-restore stripped leading zero; reject other issues.
    if (missingColumns.indexOf('from_number') === -1) {
      const fromNumberError = validateFromNumber(row['from_number']);
      if (fromNumberError) {
        messages.push(fromNumberError);
      } else {
        row['from_number'] = normalizeFromNumber(row['from_number']);
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
  return { valid, errors, dateAutoCorrected, timeAutoCorrected, timezoneWarnings, contactCountryWarnings };
}
