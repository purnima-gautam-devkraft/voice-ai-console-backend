import { ValidationResult, ErrorRow, AgentUseCase } from '../types';
import { AGENT_IDS, AGENT_DISPLAY_NAMES } from '../config/constants';
import {
  validateUserContact,
  validateFromNumber,
  normalizeFromNumber,
  parseDateToSerial,
  parseTimeToFraction,
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
  agentType: AgentUseCase
): ValidationResult {
  const expectedAgentId = AGENT_IDS[agentType];
  const valid: Record<string, string>[] = [];
  const errors: ErrorRow[] = [];

  rows.forEach((row, index) => {
    const messages: string[] = [];

    // 1. Columns A-K (the 11 unified mandatory columns) must all be present.
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

    // 3. user_contact must be a clean digit string — reject scientific-notation
    //    corruption from unformatted Excel number cells.
    if (missingColumns.indexOf('user_contact') === -1) {
      const contactError = validateUserContact(row['user_contact']);
      if (contactError) messages.push(contactError);
    }

    // 4. from_number must match the required format. A missing leading zero
    //    (Excel numeric-cell stripping, e.g. "1169323435") is auto-restored
    //    in place so the corrected value carries through to the unified file
    //    — everything else (scientific notation, wrong length) still rejects.
    if (missingColumns.indexOf('from_number') === -1) {
      const fromNumberError = validateFromNumber(row['from_number']);
      if (fromNumberError) {
        messages.push(fromNumberError);
      } else {
        row['from_number'] = normalizeFromNumber(row['from_number']);
      }
    }

    // 5. date_of_call / time_of_call must parse into the exact format used by
    //    the unified output file (Excel serial date / time-of-day fraction).
    if (missingColumns.indexOf('date_of_call') === -1) {
      if (parseDateToSerial(row['date_of_call']) === null) {
        messages.push(`date_of_call "${row['date_of_call']}" is not a recognized date (expected YYYY-MM-DD or DD-MM-YYYY)`);
      }
    }
    if (missingColumns.indexOf('time_of_call') === -1) {
      if (parseTimeToFraction(row['time_of_call']) === null) {
        messages.push(`time_of_call "${row['time_of_call']}" is not a recognized 24-hour time (expected HH:MM or HH:MM:SS, e.g. 21:00 or 21:00:00 — not 9:00 PM)`);
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

  return { valid, errors };
}
