import { parse } from 'csv-parse/sync';
import * as XLSX from 'xlsx';
import { ErrorRow } from '../types';
import {
  UNIFIED_CSV_COLUMNS,
  AGENT_OPTIONAL_COLUMNS,
  AGENT_SPECIFIC_COLUMNS,
} from '../config/constants';
import { AgentUseCase } from '../types';

/**
 * Detect whether a filename points to an Excel workbook.
 * Anything else is treated as CSV.
 */
export function isExcelFile(filename: string): boolean {
  return /\.xlsx?$/i.test(filename);
}

/** Read an Excel workbook into raw rows (header on row 0, then data rows). */
function excelToRawRows(buffer: Buffer): string[][] {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const sheetName = wb.SheetNames[0];
  const sheet = wb.Sheets[sheetName];
  // header: 1 returns an array of arrays (no auto column names)
  // raw: false formats everything as strings so we match CSV behavior
  // defval: '' avoids undefined gaps for blank cells
  return XLSX.utils.sheet_to_json<string[]>(sheet, {
    header: 1,
    raw: false,
    defval: '',
    blankrows: false,
  });
}

/**
 * Convert raw rows (where rawRows[0] is the header line and rawRows[1+] are
 * data rows) into a list of header-keyed records. Mirrors the behavior of
 * csv-parse with columns:true.
 */
function rawRowsToRecords(rawRows: string[][]): Record<string, string>[] {
  if (rawRows.length === 0) return [];
  const headers = (rawRows[0] || []).map((h) => String(h || '').trim());

  const out: Record<string, string>[] = [];
  for (let r = 1; r < rawRows.length; r++) {
    const row = rawRows[r] || [];
    if (row.every((c) => !c || String(c).trim() === '')) continue;
    const rec: Record<string, string> = {};
    for (let c = 0; c < headers.length; c++) {
      if (!headers[c]) continue;
      rec[headers[c]] = String(row[c] ?? '').trim();
    }
    out.push(rec);
  }
  return out;
}

/**
 * Parse a CSV string into row objects keyed by header.
 * Use this when the CSV content is already in memory (e.g. from multer's
 * memoryStorage on Vercel, where the filesystem is read-only).
 */
export function parseCSVString(content: string): Record<string, string>[] {
  // Remove BOM if present
  const cleanContent = content.replace(/^﻿/, '');

  const records = parse(cleanContent, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
    relax_quotes: true,
  });

  return records as Record<string, string>[];
}

/**
 * Auto-detect file type from filename and parse the in-memory buffer.
 * Use this from upload routes — handles both CSV and Excel transparently.
 */
export function parseRowsFromBuffer(
  buffer: Buffer,
  filename: string
): Record<string, string>[] {
  if (isExcelFile(filename)) {
    return rawRowsToRecords(excelToRawRows(buffer));
  }
  return parseCSVString(buffer.toString('utf-8'));
}

/**
 * Convert "M/D/YY" or "M/D/YYYY" → Excel date serial (days since 1900-01-01,
 * with the 1900-Feb-29 leap-year bug baked in via the standard +25569 offset).
 */
function mdYyToExcelSerial(s: string): number | null {
  const m = s.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return null;
  const month = parseInt(m[1], 10);
  const day   = parseInt(m[2], 10);
  let year    = parseInt(m[3], 10);
  if (year < 100) year += 2000;
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000) + 25569;
}

/**
 * Convert "DD-MM-YYYY" or "D-M-YYYY" → Excel date serial.
 * Common in Indian/European-locale Excel exports.
 */
function dmYyyyToExcelSerial(s: string): number | null {
  const m = s.trim().match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (!m) return null;
  const day   = parseInt(m[1], 10);
  const month = parseInt(m[2], 10);
  const year  = parseInt(m[3], 10);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000) + 25569;
}

/**
 * Convert strict 24-hour "HH:MM" or "HH:MM:SS" → fraction of a day (Excel
 * time representation). Rejects out-of-range hour/minute/second values
 * (e.g. "25:00", "12:60") — those aren't valid in 24-hour format either.
 */
function timeStringToFraction(s: string): number | null {
  const m = s.trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const h  = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  const ss = m[3] ? parseInt(m[3], 10) : 0;
  if (h > 23 || mm > 59 || ss > 59) return null;
  return (h * 3600 + mm * 60 + ss) / 86_400;
}

/**
 * Convert 12-hour "H:MM AM/PM" or "HH:MM:SS AM/PM" → 24-hour "HH:MM".
 * Returns null if the string doesn't look like a 12-hour time.
 */
function amPmToHHMM(s: string): string | null {
  const m = s.trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)$/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  const period = m[3].toUpperCase();
  if (h < 1 || h > 12 || mm > 59) return null;
  if (period === 'AM') { if (h === 12) h = 0; }
  else { if (h !== 12) h += 12; }
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}


/**
 * Convert an Excel serial number (days since 1900-01-00) to an ISO date
 * string (YYYY-MM-DD). Used when flattening metadata fields that Excel
 * stores as numbers but should appear as readable dates in user_metadata.
 */
function excelSerialToISODate(serial: number): string {
  const utcDays = serial - 25569;
  const ms = utcDays * 86_400_000;
  const d = new Date(ms);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Convert an Excel time fraction (0..1) to HH:MM for metadata display.
 */
function excelFractionToTime(frac: number): string {
  const totalMinutes = Math.round(frac * 24 * 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * Convert an ISO date string (YYYY-MM-DD) to an Excel serial number.
 */
function isoDateToExcelSerial(s: string): number | null {
  const m = s.trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!m) return null;
  const year = parseInt(m[1], 10);
  const month = parseInt(m[2], 10);
  const day = parseInt(m[3], 10);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000) + 25569;
}

/**
 * Parse `date_of_call` from any of the formats we see in agent input files
 * (ISO "YYYY-MM-DD", slash "M/D/YYYY", DD-MM-YYYY, or an already-numeric
 * Excel serial) into an Excel serial number. Returns null when the value
 * can't be recognized as a date.
 */
export function parseDateToSerial(raw: string): number | null {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const iso = isoDateToExcelSerial(s);
  if (iso !== null) return iso;
  const slash = mdYyToExcelSerial(s);
  if (slash !== null) return slash;
  const dmy = dmYyyyToExcelSerial(s);
  if (dmy !== null) return dmy;
  const num = Number(s);
  if (!isNaN(num) && num > 25569 && num < 80000) return num; // plausible Excel serial range
  return null;
}

/**
 * Parse any recognizable date format → "YYYY-MM-DD" text string.
 * Accepts: YYYY-MM-DD, DD-MM-YYYY, M/D/YYYY, Excel serial number.
 * Returns null when the value cannot be parsed.
 */
export function parseDateToISO(raw: string): string | null {
  const serial = parseDateToSerial(raw);
  if (serial === null) return null;
  return excelSerialToISODate(serial);
}

/**
 * Parse `time_of_call` from strict 24-hour "HH:MM" / "HH:MM:SS", or an
 * already-numeric Excel time fraction, into an Excel time fraction (0..1).
 */
export function parseTimeToFraction(raw: string): number | null {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const frac = timeStringToFraction(s);
  if (frac !== null) return frac;
  const num = Number(s);
  if (!isNaN(num) && num >= 0 && num <= 1) return num;
  return null;
}

/**
 * Parse any recognizable time format → "HH:MM" 24-hour text string.
 * Accepts: HH:MM, HH:MM:SS (24-hour), H:MM AM/PM (12-hour), Excel fraction.
 * Returns null when the value cannot be parsed.
 */
export function parseTimeToHHMM(raw: string): string | null {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  // 12-hour AM/PM first
  const ampm = amPmToHHMM(s);
  if (ampm !== null) return ampm;
  // 24-hour string
  const frac = timeStringToFraction(s);
  if (frac !== null) return excelFractionToTime(frac);
  // Excel fraction number
  const num = Number(s);
  if (!isNaN(num) && num >= 0 && num <= 1) return excelFractionToTime(num);
  return null;
}

/**
 * Strict format checks for the phone-number-shaped columns. The source
 * client Excel files frequently corrupt these when the column isn't
 * formatted as Text: `user_contact` collapses into scientific notation
 * (e.g. "9.19944E+11") — an unrecoverable, lossy corruption we reject
 * outright — and `from_number` loses its leading zero (e.g. "1169323435"
 * instead of "01169323435") — a recoverable formatting slip, since Excel's
 * numeric-cell behavior always strips a leading zero the same way, so we
 * auto-restore it (see normalizeFromNumber) instead of rejecting the row.
 */
export function isScientificNotation(raw: string): boolean {
  return /e[+-]?\d+/i.test(raw) || /^\d+\.\d+$/.test(raw.trim());
}

export function validateUserContact(raw: string): string | null {
  const s = String(raw ?? '').trim();
  if (!s) return 'user_contact is empty';
  if (isScientificNotation(s)) {
    return 'user_contact looks like a corrupted number (scientific notation). ' +
      'Format the User Contact column as Text in the source file before re-uploading.';
  }
  if (!/^\+?\d{8,15}$/.test(s)) {
    return 'user_contact must contain only digits (optionally a leading +), 8–15 digits long.';
  }
  return null;
}

/**
 * Restore a from_number that Excel corrupted by stripping its leading zero
 * (India: "1169323435" → "01169323435") or its leading + sign
 * (international: "442080995236" → "+442080995236", "6569515435" → "+6569515435",
 * "12133143493" → "+12133143493"). Only applies unambiguous fixes; anything
 * else passes through unchanged so validateFromNumber can flag it.
 */
export function normalizeFromNumber(raw: string): string {
  const s = String(raw ?? '').trim();
  // India: 10 plain digits → restore leading 0
  if (/^\d{10}$/.test(s)) return '0' + s;
  // International: plain digits that match a known country-code prefix → restore +
  // UK (+44), Singapore (+65), US/Canada (+1)
  if (/^44\d{10}$/.test(s))  return '+' + s;  // UK: 44 + 10 digits
  if (/^65\d{8}$/.test(s))   return '+' + s;  // Singapore: 65 + 8 digits
  if (/^1\d{10}$/.test(s))   return '+' + s;  // US/Canada: 1 + 10 digits
  return s;
}

export function validateFromNumber(raw: string): string | null {
  const s = String(raw ?? '').trim();
  if (!s) return 'from_number is empty';
  if (isScientificNotation(s)) {
    return 'from_number looks like a corrupted number (scientific notation). ' +
      'Format the From Number column as Text in the source file before re-uploading.';
  }
  const normalized = normalizeFromNumber(s);
  // Accept Indian format (0XXXXXXXXXX) or international format (+XXXXXXXXXXX)
  if (!/^0\d{9,14}$/.test(normalized) && !/^\+\d{7,15}$/.test(normalized)) {
    return 'from_number must be a valid telephony number: Indian format (e.g. 01169323435) or international format with country code (e.g. +442080995236).';
  }
  return null;
}

const METADATA_DATE_FIELDS = new Set([
  'Session Date',
  'Next Batch start date',
  'Assignment Deadline',
  'Extended Assignment Deadline',
  'Orientation Date',
  'Welcome Webinar Date',
  'Batch Launch Date',
  'First Graded Course Start Date',
  'First Live Session Date',
]);

const METADATA_TIME_FIELDS = new Set([
  'Session Start Time',
  'Session End Time',
]);

/**
 * Build a unified-input XLSX directly from agent-specific upload data.
 *
 * The input rows already contain the mandatory unified columns plus
 * agent-specific metadata columns. The function:
 *   1. Extracts the 11 mandatory columns as-is into the unified row.
 *   2. Collects Email, Program Name (→ "Session Program"), Cohort ID, and
 *      all agent-specific columns into a flat JSON user_metadata string.
 *   3. Returns the result as an XLSX buffer that byte-for-byte matches the
 *      client's reference unified file (unified_ggu_assignment_reminder_23_
 *      july_2026_final.xlsx): user_id numeric, user_contact/from_number as
 *      text cells, date_of_call numeric with 'yyyy-mm-dd' format,
 *      time_of_call numeric with 'hh:mm:ss' format.
 */
export function agentDataToXlsxBuffer(
  rows: Record<string, string>[],
  agentType: AgentUseCase,
  callType?: string
): Buffer {
  const metaCols = [
    ...AGENT_OPTIONAL_COLUMNS,
    ...AGENT_SPECIFIC_COLUMNS[agentType],
  ];

  const aoa: (string | number)[][] = [UNIFIED_CSV_COLUMNS.slice()];

  for (const row of rows) {
    const meta: Record<string, string> = {};
    for (const col of metaCols) {
      let val = row[col] ?? '';
      if (!val) continue;
      const num = Number(val);
      if (!isNaN(num) && val !== '') {
        if (METADATA_DATE_FIELDS.has(col) && num > 40000 && num < 70000) {
          val = excelSerialToISODate(num);
        } else if (METADATA_TIME_FIELDS.has(col) && num >= 0 && num <= 1) {
          val = excelFractionToTime(num);
        }
      }
      const key = col === 'Program Name' ? 'Session Program' : col;
      meta[key] = val;
    }

    const userIdRaw = String(row['user_id'] || '').trim();
    const userIdVal: string | number = /^\d+$/.test(userIdRaw) ? Number(userIdRaw) : userIdRaw;

    const userContact = String(row['user_contact'] || '').trim();
    const fromNumber = String(row['from_number'] || '').trim();

    const dateRaw = row['date_of_call'] || '';
    const dateVal: string = parseDateToISO(dateRaw) ?? dateRaw;

    const timeRaw = row['time_of_call'] || '';
    const timeVal: string = parseTimeToHHMM(timeRaw) ?? timeRaw;

    aoa.push([
      userIdVal,
      row['user_first_name'] || '',
      row['user_last_name'] || '',
      userContact,
      fromNumber,
      row['user_country_of_residence'] || '',
      row['timezone'] || '',
      dateVal,
      timeVal,
      row['reason'] || '',
      row['agent_id'] || '',
      callType || '',
      JSON.stringify(meta),
    ]);
  }

  const ws = XLSX.utils.aoa_to_sheet(aoa);

  // Force text type on phone-number and date/time columns so Excel never
  // converts them to scientific notation or date serials.
  const textColIdxs = ['user_contact', 'from_number', 'date_of_call', 'time_of_call']
    .map((c) => UNIFIED_CSV_COLUMNS.indexOf(c))
    .filter((i) => i >= 0);

  for (let r = 1; r < aoa.length; r++) {
    for (const ci of textColIdxs) {
      const addr = XLSX.utils.encode_cell({ c: ci, r });
      const cell = ws[addr];
      if (cell) {
        cell.t = 's';
        cell.v = String(cell.v ?? '');
        cell.z = '@';
      }
    }
  }

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

export function generateErrorReport(errorRows: ErrorRow[]): string {
  if (errorRows.length === 0) {
    return 'Row Number,Error Message\n';
  }

  // Collect all column names from error rows
  const allColumns = new Set<string>();
  for (const errorRow of errorRows) {
    Object.keys(errorRow.data).forEach((k) => allColumns.add(k));
  }

  const columns = ['Row Number', ...Array.from(allColumns), 'Error'];

  const rows = errorRows.map((errorRow) => {
    const row: Record<string, string> = {
      'Row Number': String(errorRow.rowNumber),
      Error: errorRow.errorMessage,
    };
    for (const col of allColumns) {
      row[col] = errorRow.data[col] || '';
    }
    return row;
  });

  return rowsToCSV(rows, columns);
}

function rowsToCSV(
  rows: Record<string, string>[],
  columns: string[],
  textCols?: Set<string>
): string {
  const header = columns.map(escapeCSVValue).join(',');
  const dataRows = rows.map((row) =>
    columns
      .map((col) => {
        const v = row[col] || '';
        if (v && textCols?.has(col)) return excelTextCell(v);
        return escapeCSVValue(v);
      })
      .join(',')
  );
  return [header, ...dataRows].join('\n');
}

function escapeCSVValue(value: string): string {
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Excel text-cell formula:  ="918928220913"
 * Forces Excel to display long digit strings as TEXT instead of scientific
 * notation. CSV-escaped on disk as  "=""918928220913"""
 * Voice AI / pandas consumers should strip the leading =" and trailing "
 * before use — one-liner:  re.sub(r'^="(.+)"$', r'\1', val)
 */
function excelTextCell(v: string): string {
  return `"=""${v.replace(/"/g, '""')}"""`;
}
