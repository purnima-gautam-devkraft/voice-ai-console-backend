import { Router, Request, Response } from 'express';
import { authenticateToken, requireRole } from '../middleware/auth';
import {
  listUploads,
  getStats,
  getUploadRecord,
  getUploadRows,
} from '../services/storageService';
import { agentDataToXlsxBuffer } from '../services/csvService';
import { listAuditEvents } from '../services/auditService';
import { AGENT_MAPPING } from '../config/agentMapping';
import { TELEPHONY_PROVIDERS, TelephonyProvider } from '../config/constants';
import { AuditEventType, University, AgentUseCase } from '../types';
import { getSupabase } from '../lib/supabase';

const TELEPHONY_TABLE = 'telephony_providers';

async function getSupabaseProviders(): Promise<TelephonyProvider[]> {
  try {
    const { data, error } = await getSupabase()
      .from(TELEPHONY_TABLE)
      .select('id, provider_name, from_number, country')
      .order('created_at', { ascending: true });
    if (error || !data) return [];
    return data.map((r: { id: string; provider_name: string; from_number: string; country: string }) => ({
      id: r.id,
      providerName: r.provider_name,
      fromNumber: r.from_number,
      country: r.country,
    }));
  } catch {
    return [];
  }
}

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function isValidUuid(s: string): boolean { return UUID_RE.test(s); }

// GET /api/data/agent-mapping
// Reference data — agent name ↔ agent ID lookup for the 5 finalized agents.
// Accessible to all authenticated roles.
router.get(
  '/agent-mapping',
  authenticateToken,
  (_req: Request, res: Response): void => {
    res.json({ agents: AGENT_MAPPING, total: AGENT_MAPPING.length });
  }
);

// GET /api/data/telephony-providers
router.get(
  '/telephony-providers',
  authenticateToken,
  async (_req: Request, res: Response): Promise<void> => {
    const providers = await getSupabaseProviders();
    res.json({ providers, total: providers.length });
  }
);

// POST /api/data/telephony-providers — system_admin only
router.post(
  '/telephony-providers',
  authenticateToken,
  requireRole('system_admin'),
  async (req: Request, res: Response): Promise<void> => {
    const { providerName, fromNumber, country } = req.body;
    if (!providerName?.trim() || !fromNumber?.trim() || !country?.trim()) {
      res.status(400).json({ error: 'providerName, fromNumber, and country are required' });
      return;
    }
    try {
      const { data, error } = await getSupabase()
        .from(TELEPHONY_TABLE)
        .insert({ provider_name: providerName.trim(), from_number: fromNumber.trim(), country: country.trim(), created_by: req.user!.email })
        .select('id, provider_name, from_number, country')
        .single();
      if (error) throw error;
      res.status(201).json({
        provider: { id: data.id, providerName: data.provider_name, fromNumber: data.from_number, country: data.country },
      });
    } catch (err) {
      console.error('telephony provider create failed:', err);
      res.status(500).json({ error: 'Failed to create telephony provider' });
    }
  }
);

// DELETE /api/data/telephony-providers/:id — system_admin only
router.delete(
  '/telephony-providers/:id',
  authenticateToken,
  requireRole('system_admin'),
  async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params;
    if (!isValidUuid(id)) { res.status(400).json({ error: 'Invalid id' }); return; }
    try {
      const { error } = await getSupabase().from(TELEPHONY_TABLE).delete().eq('id', id);
      if (error) throw error;
      res.json({ success: true });
    } catch (err) {
      console.error('telephony provider delete failed:', err);
      res.status(500).json({ error: 'Failed to delete telephony provider' });
    }
  }
);

// GET /api/data/upload-rows/:uploadId
// Returns the validated data rows stored for a given agent-data upload —
// used by the View Data screen to browse a specific upload's contents.
router.get(
  '/upload-rows/:uploadId',
  authenticateToken,
  requireRole('system_admin', 'data_manager'),
  async (req: Request, res: Response): Promise<void> => {
    const { uploadId } = req.params;
    if (!isValidUuid(uploadId)) { res.status(400).json({ error: 'Invalid uploadId' }); return; }
    try {
      const record = await getUploadRecord(uploadId);
      if (!record) { res.status(404).json({ error: 'Upload record not found' }); return; }

      const rows = await getUploadRows(uploadId);
      res.json({ data: rows || [], total: rows?.length || 0 });
    } catch (err) {
      console.error('upload-rows fetch failed:', err);
      res.status(500).json({ error: 'Failed to fetch upload rows' });
    }
  }
);

// GET /api/data/unified-xlsx/:uploadId
// Serves the unified Voice AI input file as .xlsx with date_of_call and
// time_of_call cells stored as proper Excel number types so the downstream
// scheduler can compute wall-clock call times (vs marking calls 'skipped').
// Rebuilt directly from the upload's stored validated rows — see
// agentDataToXlsxBuffer for the exact cell-format spec (matches the
// client's reference unified file).
router.get(
  '/unified-xlsx/:uploadId',
  authenticateToken,
  requireRole('system_admin', 'data_manager'),
  async (req: Request, res: Response): Promise<void> => {
    const { uploadId } = req.params;
    if (!isValidUuid(uploadId)) { res.status(400).json({ error: 'Invalid uploadId' }); return; }
    try {
      const record = await getUploadRecord(uploadId);
      if (!record) { res.status(404).json({ error: 'Upload record not found' }); return; }

      const rows = await getUploadRows(uploadId);
      if (!rows || rows.length === 0) {
        res.status(404).json({ error: 'No unified file stored for this upload (was the upload rejected?)' });
        return;
      }

      const safeStamp = record.uploadedAt.replace(/[:.]/g, '-');
      const safeUni   = (record.university || 'all').replace(/[^a-z0-9]/gi, '-');
      const safeProg  = (record.program    || 'all').replace(/[^a-z0-9]/gi, '-');

      const buf = agentDataToXlsxBuffer(rows, record.dataType as AgentUseCase, record.callType);
      const fileName = `unified-${record.dataType}-${safeUni}-${safeProg}-${safeStamp}.xlsx`;

      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
      res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
      res.send(buf);
    } catch (err) {
      console.error('unified-xlsx fetch failed:', err);
      res.status(500).json({ error: 'Failed to fetch unified XLSX' });
    }
  }
);

// GET /api/data/upload-history
router.get(
  '/upload-history',
  authenticateToken,
  requireRole('system_admin', 'data_manager'),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { dataType, university, program } = req.query;

      const uploads = await listUploads({
        dataType: dataType as AgentUseCase | undefined,
        university: university as University | undefined,
        program: program as string | undefined,
      });

      res.json({ uploads, total: uploads.length });
    } catch (err) {
      console.error('upload-history fetch failed:', err);
      res.status(500).json({ error: 'Failed to fetch upload history' });
    }
  }
);

// GET /api/data/audit
// Audit log feed — every upload, unified-file generation, S3 archive, and
// scheduler notification. Admin-facing: only system_admin + data_manager.
// Optional filters: eventType, university, program, uploadId, limit.
router.get(
  '/audit',
  authenticateToken,
  requireRole('system_admin', 'data_manager'),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { eventType, university, program, uploadId, limit } = req.query;
      const parsedLimit = limit ? parseInt(limit as string, 10) : undefined;
      const events = await listAuditEvents({
        eventType: eventType as AuditEventType | undefined,
        university: university as string | undefined,
        program: program as string | undefined,
        uploadId: uploadId as string | undefined,
        limit: parsedLimit && !isNaN(parsedLimit) ? parsedLimit : undefined,
      });
      res.json({ events, total: events.length });
    } catch (err) {
      console.error('audit fetch failed:', err);
      res.status(500).json({ error: 'Failed to fetch audit log' });
    }
  }
);

// GET /api/data/stats
router.get(
  '/stats',
  authenticateToken,
  async (_req: Request, res: Response): Promise<void> => {
    try {
      const stats = await getStats();
      res.json(stats);
    } catch (err) {
      console.error('stats fetch failed:', err);
      res.status(500).json({ error: 'Failed to fetch stats' });
    }
  }
);

export default router;
