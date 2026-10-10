/**
 * Indexer — scan, extract, chunk, embed, store.
 *
 * Resumable by content hash (IMPLEMENTATION.md P1): a file whose hash is
 * already in `files` with status done is skipped, so a crash mid-run re-does
 * only the unfinished files. Each file is processed in a transaction-ish
 * pattern — pending row first, done only after all rows commit — and a
 * per-file error never aborts the run.
 *
 * All external capabilities are constructor-injected (AGENT.md); the clock is
 * injected as `now` so tests never touch Date.now().
 */

import type {
  ChunkId,
  Embedder,
  FileId,
  KeywordIndex,
  TextExtractor,
  VectorStore,
} from '@/interfaces/capabilities';
import type { SqliteDb } from '@/db/sqlite';
import { errorMessage } from '@/errors';
import { NoiseFilter } from '@/index/filter';
import { scanFolder, type ScannedFile } from '@/index/scan';
import { chunkText } from '@/index/chunk';
import { l2Normalise } from '@/search/vector';

export interface IndexerDeps {
  db: SqliteDb;
  extractor: TextExtractor;
  embedder: Embedder;
  store: VectorStore;
  keywordIndex: KeywordIndex;
  filter: NoiseFilter;
  now: () => Date;
}

export interface IndexProgress {
  total: number;
  processed: number;
  skipped: number;
  failed: number;
  current: string;
}

export type ProgressCallback = (progress: IndexProgress) => void;

export interface IndexProgressOptions {
  onProgress?: ProgressCallback;
}

export interface IndexFileError {
  path: string;
  error: string;
}

export interface IndexResult {
  scanned: number;
  processed: number;
  skipped: number;
  failed: number;
  errors: IndexFileError[];
}

function resolveCallback(
  arg: ProgressCallback | IndexProgressOptions | undefined,
): ProgressCallback | null {
  if (arg === undefined) return null;
  if (typeof arg === 'function') return arg;
  const cb = (arg as IndexProgressOptions).onProgress;
  return typeof cb === 'function' ? cb : null;
}

// NOTE: the extracted method is re-bound to the instance. Returning it bare
// loses `this`, and `this.meta` inside registerFile then throws.
function asRegisterFile(
  store: VectorStore,
): ((id: FileId, mtime: Date, source: 'ocr' | 'vision') => void) | null {
  const candidate = (store as unknown as Record<string, unknown>)['registerFile'];
  if (typeof candidate === 'function') {
    return (candidate as (...a: never[]) => void).bind(store) as unknown as (
      id: FileId,
      mtime: Date,
      source: 'ocr' | 'vision',
    ) => void;
  }
  return null;
}

function asKeywordRegister(
  index: KeywordIndex,
): ((id: ChunkId, owner: FileId) => void) | null {
  const candidate = (index as unknown as Record<string, unknown>)['register'];
  if (typeof candidate === 'function') {
    return (candidate as (...a: never[]) => void).bind(index) as unknown as (
      id: ChunkId,
      owner: FileId,
    ) => void;
  }
  return null;
}

export class Indexer {
  private readonly deps: IndexerDeps;

  constructor(deps: IndexerDeps) {
    this.deps = deps;
  }

  async indexFolder(
    root: string,
    onProgress?: ProgressCallback | IndexProgressOptions,
  ): Promise<IndexResult> {
    const cb = resolveCallback(onProgress);
    const scan = scanFolder(root, { filter: this.deps.filter });

    const total = scan.files.length;
    let processed = 0;
    let skipped = 0;
    let failed = 0;
    const errors: IndexFileError[] = [...scan.errors];

    const emit = (current: string): void => {
      if (cb) cb({ total, processed, skipped, failed, current });
    };

    for (const file of scan.files) {
      try {
        const outcome = await this.indexFile(file);
        if (outcome === 'skipped') skipped += 1;
        else processed += 1;
      } catch (e) {
        failed += 1;
        errors.push({ path: file.path, error: errorMessage(e) });
      }
      emit(file.path);
    }

    return { scanned: total, processed, skipped, failed, errors };
  }

  /**
   * Index one file. Returns 'skipped' when its hash is already done,
   * 'processed' on success, and throws on failure (caller records it).
   */
  private async indexFile(scanned: ScannedFile): Promise<'processed' | 'skipped'> {
    const { db, extractor, embedder, store, keywordIndex, now } = this.deps;

    // Resumability: content hash already done means nothing to do, even if
    // the path differs (byte-identical copy indexed earlier).
    const doneRow = db
      .prepare('SELECT id FROM files WHERE content_hash = ? AND status = ? LIMIT 1')
      .get(scanned.contentHash, 'done') as { id: string } | undefined;
    if (doneRow) return 'skipped';

    // Deterministic id from content — no randomness, stable across re-runs.
    const fileId = scanned.contentHash as FileId;
    const mtimeMs = Math.floor(scanned.mtimeMs);

    // Same path, new content: drop the stale rows so path stays UNIQUE and
    // no orphan chunks/vectors survive the rewrite.
    const byPath = db.prepare('SELECT id FROM files WHERE path = ?').get(scanned.path) as
      | { id: string }
      | undefined;
    if (byPath && byPath.id !== (fileId as string)) {
      const oldId = byPath.id as FileId;
      try {
        await store.deleteByFile(oldId);
      } catch {
        // Best-effort cleanup; the per-file try below decides success.
      }
      try {
        await keywordIndex.deleteByFile(oldId);
      } catch {
        // Same as above.
      }
      db.prepare('DELETE FROM chunks WHERE file_id = ?').run(oldId);
      db.prepare('DELETE FROM files WHERE id = ?').run(oldId);
    }

    db.prepare(
      `INSERT INTO files(id,path,mtime_ms,bytes,content_hash,phash,status)
       VALUES(?,?,?,?,?,?,'pending')
       ON CONFLICT(id) DO UPDATE SET
         path=excluded.path, mtime_ms=excluded.mtime_ms, bytes=excluded.bytes,
         content_hash=excluded.content_hash, phash=excluded.phash, status='pending'`,
    ).run(fileId, scanned.path, mtimeMs, scanned.bytes, scanned.contentHash, scanned.phash);

    try {
      const extracted = await extractor.extract(scanned.path);
      const body = extracted.text ?? '';
      const confidence = extracted.confidence ?? 0;
      const chars = body.length;
      // C6 vision-fallback signal: low OCR confidence or almost no text.
      const needsVision = confidence < 0.35 || chars < 20 ? 1 : 0;

      db.prepare('UPDATE files SET ocr_confidence=?, ocr_chars=?, needs_vision=? WHERE id=?').run(
        confidence,
        chars,
        needsVision,
        fileId,
      );

      const texts = chunkText(body);
      // Retry cleanup: a previous crash may have left partial chunks.
      db.prepare('DELETE FROM chunks WHERE file_id = ?').run(fileId);
      try {
        await store.deleteByFile(fileId);
      } catch {
        // Ignored here; a real failure surfaces on upsert below.
      }
      try {
        await keywordIndex.deleteByFile(fileId);
      } catch {
        // Same as above.
      }

      const registerFile = asRegisterFile(store);
      if (registerFile) registerFile(fileId, new Date(scanned.mtimeMs), 'ocr');
      const keywordRegister = asKeywordRegister(keywordIndex);

      const chunkIds: ChunkId[] = [];
      for (let ord = 0; ord < texts.length; ord++) {
        const chunkTextValue = texts[ord] as string;
        const chunkId = `${fileId as string}#${ord}` as ChunkId;
        chunkIds.push(chunkId);
        const tokens = Math.ceil(chunkTextValue.length / 4);
        db.prepare(
          'INSERT INTO chunks(id,file_id,source,text,tokens,ord) VALUES(?,?,?,?,?,?)',
        ).run(chunkId, fileId, 'ocr', chunkTextValue, tokens, ord);
      }

      if (chunkIds.length > 0) {
        const entries: { chunkId: ChunkId; fileId: FileId; vector: Float32Array }[] = [];
        for (let i = 0; i < texts.length; i++) {
          const raw = await embedder.embed(texts[i] as string);
          entries.push({
            chunkId: chunkIds[i] as ChunkId,
            fileId,
            vector: l2Normalise(raw),
          });
        }
        await store.upsert(entries);
        for (let i = 0; i < chunkIds.length; i++) {
          await keywordIndex.upsert(chunkIds[i] as ChunkId, texts[i] as string);
          if (keywordRegister) keywordRegister(chunkIds[i] as ChunkId, fileId);
        }
      }

      db.prepare("UPDATE files SET status='done', indexed_at=? WHERE id=?").run(
        now().getTime(),
        fileId,
      );
      return 'processed';
    } catch (e) {
      // Transaction-ish rollback for this file only; the run continues.
      try {
        db.prepare("UPDATE files SET status='failed' WHERE id=?").run(fileId);
      } catch {
        // Marking failure must not mask the original error.
      }
      try {
        db.prepare('DELETE FROM chunks WHERE file_id=?').run(fileId);
      } catch {
        // Same as above.
      }
      try {
        await store.deleteByFile(fileId);
      } catch {
        // Same as above.
      }
      try {
        await keywordIndex.deleteByFile(fileId);
      } catch {
        // Same as above.
      }
      throw e;
    }
  }
}
