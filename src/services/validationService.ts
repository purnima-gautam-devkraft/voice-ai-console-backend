import { ValidationResult, ErrorRow, AgentUseCase, TimezoneWarning } from '../types';
import { AGENT_IDS, AGENT_DISPLAY_NAMES, COUNTRY_TIMEZONE_MAP, ALLOWED_COUNTRIES } from '../config/constants';
import {
  validateUserContact,
  validateFromNumber,
  normalizeFromNumber,
  parseDateToISO,
  parseTimeToHHMM,
} from './csvService';

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
  confirmCorrections = false
): ValidationResult {
  const expectedAgentId = AGENT_IDS[agentType];
  const valid: Record<string, string>[] = [];
  const errors: ErrorRow[] = [];
  let dateAutoCorrected = 0;
  let timeAutoCorrected = 0;
  // key: "country||supplied||correct" → rowCount
  const tzWarnMap = new Map<string, { country: string; suppliedTimezone: string; correctTimezone: string; rowCount: number }>();

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
        messages.push(`date_of_call "${row['date_of_call']}" is not a recognizable date. Use YYYY-MM-DD, DD-MM-YYYY, or M/D/YYYY.`);
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

    // 7. user_country_of_residence — must be one of the allowed destination countries.
    //    timezone — warn if it doesn't match the canonical value; apply only when confirmCorrections=true.
    if (missingColumns.indexOf('user_country_of_residence') === -1) {
      const rawCountry = String(row['user_country_of_residence'] || '').trim();
      const canonicalTz = COUNTRY_TIMEZONE_MAP[rawCountry.toLowerCase()];
      if (!canonicalTz) {
        messages.push(
          `user_country_of_residence "${rawCountry}" is not a supported destination country. ` +
          `Allowed: ${ALLOWED_COUNTRIES.join(', ')}.`
        );
      } else if (row['timezone'] !== canonicalTz) {
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
  return { valid, errors, dateAutoCorrected, timeAutoCorrected, timezoneWarnings };
}
