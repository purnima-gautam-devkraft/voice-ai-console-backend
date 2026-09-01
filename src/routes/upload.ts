import { Router, Request, Response } from 'express';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import { authenticateToken, requireRole } from '../middleware/auth';
import { uploadLimiter } from '../middleware/rateLimiters';
import {
  parseRowsFromBuffer,
  generateErrorReport,
  agentDataToXlsxBuffer,
} from '../services/csvService';
import { isS3Configured, uploadUnifiedSnapshot } from '../services/s3Storage';
import { isSchedulerConfigured, notifyScheduler } from '../services/schedulerService';
import { recordAuditEvent } from '../services/auditService';
import { validateAgentData } from '../services/validationService';
import {
  saveUploadRecord,
  getUploadRecord,
  getUploadErrors,
  getRawFile,
} from '../services/storageService';
import {
  AGENT_USE_CASES,
  AGENT_MANDATORY_COLUMNS,
  UNIVERSITIES,
} from '../config/constants';
import { AgentUseCase, University } from '../types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function isValidUuid(s: string): boolean { return UUID_RE.test(s); }

const router = Router();

// Memory storage — works on Vercel's read-only filesystem.
// Files stay in req.file.buffer; we forward the buffer to Supabase as
// base64 so the original raw input is preserved exactly.
const storage = multer.memoryStorage();

// Accept both CSV and Excel (.xlsx / .xls)
const ACCEPTED_MIME = new Set([
  'text/csv',
  'application/vnd.ms-excel',                                                // .xls
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',       // .xlsx
  'application/octet-stream',                                                // fallback some browsers use
]);
const ACCEPTED_EXT_RE = /\.(csv|xlsx|xls)$/i;

const fileFilter = (
  _req: Request,
  file: Express.Multer.File,
  cb: multer.FileFilterCallback
): void => {
  if (ACCEPTED_MIME.has(file.mimetype) || ACCEPTED_EXT_RE.test(file.originalname)) {
    cb(null, true);
  } else {
    cb(new Error('Only CSV or Excel (.xlsx / .xls) files are allowed'));
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB
});

// POST /api/upload/agent-data
// Upload pre-formatted input data for a specific Voice AI agent/use case.
// Validates the expected columns, generates a unified XLSX (mandatory cols
// as-is, rest → user_metadata JSON), and optionally archives to S3 / pushes
// to the scheduler.
router.post(
  '/agent-data',
  authenticateToken,
  requireRole('system_admin', 'data_manager'),
  uploadLimiter,
  upload.single('file'),
  async (req: Request, res: Response): Promise<void> => {
    if (!req.file) {
      res.status(400).json({ error: 'No file uploaded' });
      return;
    }

    const { university, program, agentType, callType } = req.body;
    if (!university || !program) {
      res.status(400).json({ error: 'University and program are required' });
      return;
    }
    if (!agentType || !AGENT_USE_CASES.includes(agentType as AgentUseCase)) {
      res.status(400).json({
        error: `Invalid agentType. Must be one of: ${AGENT_USE_CASES.join(', ')}`,
      });
      return;
    }
    if (!callType || !['Live', 'Test'].includes(callType)) {
      res.status(400).json({ error: 'callType is required. Must be Live or Test.' });
      return;
    }
    const allowedPrograms = UNIVERSITIES[university as University];
    if (!allowedPrograms) {
      res.status(400).json({ error: 'Invalid university' });
      return;
    }
    if (!allowedPrograms.includes(program)) {
      res.status(400).json({ error: 'Invalid program for the selected university' });
      return;
    }

    const agent = agentType as AgentUseCase;

    try {
      const rows = parseRowsFromBuffer(req.file.buffer, req.file.originalname);
      const { valid, errors, dateAutoCorrected, timeAutoCorrected } = validateAgentData(rows, AGENT_MANDATORY_COLUMNS, agent);

      const uploadId = uuidv4();
      const now = new Date().toISOString();

      let xlsxBuffer: Buffer | undefined;
      let unifiedFileName: string | undefined;
      let unifiedArchivedToS3 = false;
      let schedulerNotified = false;

      if (errors.length === 0 && valid.length > 0) {
        xlsxBuffer = agentDataToXlsxBuffer(valid, agent, callType);
        const safeStamp = now.replace(/[:.]/g, '-');
        const safeUni = ((university as string) || 'all').replace(/[^a-z0-9]/gi, '-');
        const safeProg = ((program as string) || 'all').replace(/[^a-z0-9]/gi, '-');
        unifiedFileName = `unified-${agent}-${safeUni}-${safeProg}-${safeStamp}.xlsx`;
      }

      await saveUploadRecord({
        uploadId,
        metadata: {
          fileName: req.file.originalname,
          dataType: agent,
          university: university as University,
          program,
          callType: callType as 'Live' | 'Test',
          uploadedAt: now,
          uploadedBy: req.user!.email,
          totalRows: rows.length,
          validRows: errors.length === 0 ? valid.length : 0,
          errorRows: errors.length,
          status: errors.length === 0 ? 'success' : 'failed',
        },
        data: errors.length === 0 ? valid : [],
        errors,
        rawFile: { buffer: req.file.buffer, originalName: req.file.originalname },
        unifiedCsv: xlsxBuffer ? '[binary unified xlsx generated]' : undefined,
      });

      await recordAuditEvent({
        eventType: 'upload',
        dataType: agent,
        uploadId,
        university: university as string,
        program,
        fileName: req.file.originalname,
        actorEmail: req.user!.email,
        actorRole: req.user!.role,
        status: errors.length === 0 ? 'success' : 'failed',
        detail: {
          totalRows: rows.length,
          validRows: errors.length === 0 ? valid.length : 0,
          errorRows: errors.length,
          agentType: agent,
        },
      });

      if (xlsxBuffer) {
        await recordAuditEvent({
          eventType: 'unified_generated',
          dataType: agent,
          uploadId,
          university: university as string,
          program,
          fileName: req.file.originalname,
          actorEmail: req.user!.email,
          actorRole: req.user!.role,
          status: 'success',
          detail: { rows: valid.length, agentType: agent },
        });
      }

      if (xlsxBuffer && isS3Configured()) {
        try {
          const csvPlaceholder = '';
          const keys = await uploadUnifiedSnapshot({
            uploadId,
            university: university as string,
            program: program as string,
            uploadedAt: now,
            csv: csvPlaceholder,
            xlsx: xlsxBuffer,
          });
          unifiedArchivedToS3 = true;
          console.log(`[s3] archived unified snapshot: ${keys.xlsxKey}`);
          await recordAuditEvent({
            eventType: 's3_archived',
            dataType: agent,
            uploadId,
            university: university as string,
            program,
            fileName: req.file.originalname,
            actorEmail: req.user!.email,
            actorRole: req.user!.role,
            status: 'success',
            detail: { bucket: keys.bucket, xlsxKey: keys.xlsxKey },
          });
        } catch (s3err) {
          console.error('[s3] unified snapshot archive failed (continuing):', s3err);
          await recordAuditEvent({
            eventType: 's3_archived',
            dataType: agent,
            uploadId,
            university: university as string,
            program,
            fileName: req.file.originalname,
            actorEmail: req.user!.email,
            actorRole: req.user!.role,
            status: 'failed',
            detail: { error: String(s3err).slice(0, 500) },
          });
        }
      }

      if (xlsxBuffer && unifiedFileName && isSchedulerConfigured()) {
        const result = await notifyScheduler({
          uploadId,
          fileName: unifiedFileName,
          xlsx: xlsxBuffer,
        });
        schedulerNotified = result.ok;
        if (result.ok) {
          console.log(`[scheduler] uploaded unified file ok (status ${result.status ?? '?'})`);
        } else {
          console.error(`[scheduler] upload failed (continuing): ${result.detail ?? ''}`);
        }
        await recordAuditEvent({
          eventType: 'scheduler_notified',
          dataType: agent,
          uploadId,
          university: university as string,
          program,
          fileName: req.file.originalname,
          actorEmail: req.user!.email,
          actorRole: req.user!.role,
          status: result.ok ? 'success' : 'failed',
          detail: { httpStatus: result.status, detail: result.detail, file: unifiedFileName },
        });
      }

      res.json({
        uploadId,
        success: errors.length === 0,
        totalRows: rows.length,
        validRows: errors.length === 0 ? valid.length : 0,
        errorRows: errors.length,
        errors: errors.slice(0, 100),
        data: [],
        unifiedCsvAvailable: xlsxBuffer != null,
        unifiedArchivedToS3,
        schedulerNotified,
        dateAutoCorrected,
        timeAutoCorrected,
      });
    } catch (err) {
      console.error('Upload error:', err);
      res.status(500).json({ error: 'Failed to process file' });
    }
  }
);

// GET /api/upload/error-report/:uploadId
router.get(
  '/error-report/:uploadId',
  authenticateToken,
  async (req: Request, res: Response): Promise<void> => {
    const { uploadId } = req.params;
    if (!isValidUuid(uploadId)) { res.status(400).json({ error: 'Invalid uploadId' }); return; }

    try {
      const record = await getUploadRecord(uploadId);
      if (!record) {
        res.status(404).json({ error: 'Upload record not found' });
        return;
      }

      const errors = await getUploadErrors(uploadId);
      if (errors.length === 0) {
        res.status(404).json({ error: 'No errors found for this upload' });
        return;
      }

      const csvContent = generateErrorReport(errors);

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="error-report-${uploadId}.csv"`
      );
      res.send(csvContent);
    } catch (err) {
      console.error('Error report fetch failed:', err);
      res.status(500).json({ error: 'Failed to fetch error report' });
    }
  }
);

// GET /api/upload/raw-file/:uploadId
// Download the original uploaded file (CSV / XLSX) that the client sent.
// File is fetched from the Supabase Storage 'raw-uploads' bucket in
// production; local-dev file-storage fallback returns it from the inline
// base64 in ./data/uploads.json.
router.get(
  '/raw-file/:uploadId',
  authenticateToken,
  async (req: Request, res: Response): Promise<void> => {
    const { uploadId } = req.params;
    if (!isValidUuid(uploadId)) { res.status(400).json({ error: 'Invalid uploadId' }); return; }

    try {
      const record = await getUploadRecord(uploadId);
      if (!record) {
        res.status(404).json({ error: 'Upload record not found' });
        return;
      }
      // Support agents can only download their own raw files
      if (req.user?.role === 'support_agent' && record.uploadedBy !== req.user.email) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }

      const file = await getRawFile(uploadId);
      if (!file) {
        res.status(404).json({
          error: 'Raw file not stored for this upload',
          hint:  'Older uploads (before the raw-file bucket was introduced) may not have a stored original.',
        });
        return;
      }

      res.setHeader('Content-Type', file.mime);
      res.setHeader('Content-Disposition', `attachment; filename="${file.fileName}"`);
      res.send(file.buffer);
    } catch (err) {
      console.error('Raw-file fetch failed:', err);
      res.status(500).json({ error: 'Failed to fetch raw file' });
    }
  }
);

export default router;
