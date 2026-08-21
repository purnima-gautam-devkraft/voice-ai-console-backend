import { getSupabase, UPLOADS_TABLE } from '../lib/supabase';
import { UploadRecord, ErrorRow, DataType, University } from '../types';

/**
 * Bucket in Supabase Storage where every uploaded raw file lives.
 * Created by migrations/003_raw_file_storage.sql.
 * Private — only the service-role key (used by this backend) can read/write.
 */
const RAW_FILES_BUCKET = 'raw-uploads';

interface DBUpload {
  upload_id: string;
  data_type: DataType;
  university: string | null;
  program: string | null;
  call_type: string | null;
  file_name: string;
  file_size_bytes: number;
  file_ext: string;
  /** Legacy inline base64 (kept for older rows; nulled on new inserts). */
  raw_file_b64: string | null;
  /** Path inside the raw-uploads Storage bucket. Set on every new upload. */
  raw_file_path: string | null;
  uploaded_by: string;
  uploaded_at: string;
  total_rows: number;
  valid_rows: number;
  error_rows: number;
  status: 'success' | 'partial' | 'failed';
  rows: Record<string, string>[];
  errors: ErrorRow[];
  /** Legacy column — unused now that unified files are rebuilt on demand from `rows`. */
  unified_csv?: string | null;
}

/** MIME types accepted by the raw-uploads bucket. Match the multer fileFilter. */
function mimeForExt(ext: string): string {
  switch (ext.toLowerCase()) {
    case 'csv':  return 'text/csv';
    case 'xls':  return 'application/vnd.ms-excel';
    case 'xlsx': return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    default:     return 'application/octet-stream';
  }
}

/**
 * Upload the raw file bytes to the Storage bucket. Returns the bucket path.
 *
 * Path layout: <data-type>/<upload-id>.<ext>
 *
 * We intentionally do NOT preserve the original filename in the bucket path —
 * Supabase Storage rejects paths with various unicode / whitespace / special-
 * char combinations as "Invalid path specified in request URL", even after
 * regex sanitization. uuid-based paths are guaranteed valid. The original
 * filename is still kept in the DB row's `file_name` column for display.
 */
async function uploadRawToBucket(
  uploadId: string,
  dataType: DataType,
  originalName: string,
  buffer: Buffer
): Promise<string> {
  // Extension only — strip anything that isn't a-z/0-9, cap length defensively.
  const ext = (originalName.split('.').pop() || 'csv')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 10) || 'bin';

  const path = `${dataType}/${uploadId}.${ext}`;

  const { error } = await getSupabase()
    .storage
    .from(RAW_FILES_BUCKET)
    .upload(path, buffer, {
      contentType: mimeForExt(ext),
      upsert: false,
    });
  if (error) {
    throw new Error(`Supabase storage upload failed: ${error.message}`);
  }
  return path;
}

function rowToUploadRecord(r: DBUpload): UploadRecord {
  return {
    uploadId: r.upload_id,
    fileName: r.file_name,
    dataType: r.data_type,
    university: (r.university || undefined) as University | undefined,
    program: r.program || undefined,
    callType: (r.call_type || undefined) as UploadRecord['callType'],
    uploadedAt: r.uploaded_at,
    uploadedBy: r.uploaded_by,
    totalRows: r.total_rows,
    validRows: r.valid_rows,
    errorRows: r.error_rows,
    status: r.status,
  };
}

export interface SaveUploadInput {
  uploadId: string;
  metadata: Omit<UploadRecord, 'uploadId'>;
  data: Record<string, string>[];
  errors: ErrorRow[];
  rawFile: {
    buffer: Buffer;
    originalName: string;
  };
  /**
   * Legacy field — no longer populated. Unified files are now rebuilt on
   * demand from the stored `rows` (see getUploadRows).
   */
  unifiedCsv?: string;
}

export async function saveUploadRecord(input: SaveUploadInput): Promise<void> {
  const { uploadId, metadata, data, errors, rawFile, unifiedCsv } = input;

  const fileExt = (rawFile.originalName.split('.').pop() || 'csv').toLowerCase();

  let rawFilePath: string | null = null;
  try {
    rawFilePath = await uploadRawToBucket(
      uploadId, metadata.dataType, rawFile.originalName, rawFile.buffer
    );
  } catch (storageErr) {
    console.warn('[storage] Raw file upload failed (continuing without it):', storageErr);
  }

  const row: DBUpload = {
    upload_id: uploadId,
    data_type: metadata.dataType,
    university: metadata.university || null,
    program: metadata.program || null,
    call_type: metadata.callType || null,
    file_name: rawFile.originalName,
    file_size_bytes: rawFile.buffer.length,
    file_ext: fileExt,
    // Legacy inline base64 is no longer populated — the bucket is the
    // canonical store. Older rows still in the DB keep their b64 and are
    // served by the read path below.
    raw_file_b64: null,
    raw_file_path: rawFilePath,
    uploaded_by: metadata.uploadedBy,
    uploaded_at: metadata.uploadedAt,
    total_rows: metadata.totalRows,
    valid_rows: metadata.validRows,
    error_rows: metadata.errorRows,
    status: metadata.status,
    rows: data,
    errors,
    unified_csv: unifiedCsv ?? null,
  };

  const { error } = await getSupabase().from(UPLOADS_TABLE).insert(row);
  if (error) {
    if (rawFilePath) {
      await getSupabase().storage.from(RAW_FILES_BUCKET).remove([rawFilePath]).catch(() => undefined);
    }
    throw new Error(`Supabase insert failed: ${error.message}`);
  }
}

/**
 * Fetch the original raw uploaded file. Prefers the Storage bucket; falls
 * back to the legacy inline base64 column for rows uploaded before 003.
 * Returns null when no file was stored.
 */
export async function getRawFile(
  uploadId: string
): Promise<{ buffer: Buffer; fileName: string; mime: string } | null> {
  const { data, error } = await getSupabase()
    .from(UPLOADS_TABLE)
    .select('raw_file_path, raw_file_b64, file_name, file_ext')
    .eq('upload_id', uploadId)
    .maybeSingle();
  if (error) throw new Error(`Supabase select failed: ${error.message}`);
  if (!data) return null;

  const fileName = (data as { file_name?: string }).file_name || `upload-${uploadId}`;
  const fileExt  = (data as { file_ext?: string }).file_ext || 'bin';
  const mime     = mimeForExt(fileExt);

  // Prefer the bucket
  const path = (data as { raw_file_path?: string | null }).raw_file_path;
  if (path) {
    const dl = await getSupabase().storage.from(RAW_FILES_BUCKET).download(path);
    if (dl.error || !dl.data) {
      console.error('Storage download failed:', dl.error?.message);
      return null;
    }
    const buf = Buffer.from(await dl.data.arrayBuffer());
    return { buffer: buf, fileName, mime };
  }

  // Legacy fallback
  const b64 = (data as { raw_file_b64?: string | null }).raw_file_b64;
  if (b64) {
    return { buffer: Buffer.from(b64, 'base64'), fileName, mime };
  }
  return null;
}

export async function getUploadRecord(uploadId: string): Promise<UploadRecord | null> {
  const { data, error } = await getSupabase()
    .from(UPLOADS_TABLE)
    .select('*')
    .eq('upload_id', uploadId)
    .maybeSingle();
  if (error) throw new Error(`Supabase select failed: ${error.message}`);
  return data ? rowToUploadRecord(data as DBUpload) : null;
}

export async function getUploadErrors(uploadId: string): Promise<ErrorRow[]> {
  const { data, error } = await getSupabase()
    .from(UPLOADS_TABLE)
    .select('errors')
    .eq('upload_id', uploadId)
    .maybeSingle();
  if (error) throw new Error(`Supabase select failed: ${error.message}`);
  return (data?.errors as ErrorRow[] | undefined) || [];
}

/**
 * Raw stored rows (the validated data) for an upload — used to regenerate
 * the unified XLSX on demand and to power the View Data screen.
 */
export async function getUploadRows(uploadId: string): Promise<Record<string, string>[] | null> {
  const { data, error } = await getSupabase()
    .from(UPLOADS_TABLE)
    .select('rows')
    .eq('upload_id', uploadId)
    .maybeSingle();
  if (error) throw new Error(`Supabase select failed: ${error.message}`);
  return (data?.rows as Record<string, string>[] | null | undefined) ?? null;
}

export async function listUploads(filters?: {
  dataType?: DataType;
  university?: University;
  program?: string;
  limit?: number;
}): Promise<UploadRecord[]> {
  let query = getSupabase()
    .from(UPLOADS_TABLE)
    .select('*')
    .order('uploaded_at', { ascending: false });

  if (filters?.dataType)   query = query.eq('data_type', filters.dataType);
  if (filters?.university) query = query.eq('university', filters.university);
  if (filters?.program)    query = query.eq('program', filters.program);
  if (filters?.limit)      query = query.limit(filters.limit);

  const { data, error } = await query;
  if (error) throw new Error(`Supabase select failed: ${error.message}`);
  return (data || []).map((r) => rowToUploadRecord(r as DBUpload));
}

export async function getStats(): Promise<{
  totalUploadsToday: number;
  totalUploads: number;
  totalRowsProcessed: number;
  lastSyncTime: string | null;
}> {
  const { data, error } = await getSupabase()
    .from(UPLOADS_TABLE)
    .select('data_type, uploaded_at, valid_rows')
    .order('uploaded_at', { ascending: false });
  if (error) throw new Error(`Supabase select failed: ${error.message}`);

  const rows = (data || []) as Array<Pick<DBUpload, 'data_type' | 'uploaded_at' | 'valid_rows'>>;
  const todayPrefix = new Date().toISOString().split('T')[0];

  let totalUploadsToday = 0;
  let totalRowsProcessed = 0;
  const lastSyncTime: string | null = rows[0]?.uploaded_at || null;

  for (const r of rows) {
    if (r.uploaded_at.startsWith(todayPrefix)) totalUploadsToday += 1;
    totalRowsProcessed += r.valid_rows;
  }

  return { totalUploadsToday, totalUploads: rows.length, totalRowsProcessed, lastSyncTime };
}
