/**
 * HTTP layer.
 *
 * Deliberately thin: it parses, delegates to SearchService, and formats. No
 * ranking logic, no SQL (AGENT.md — "no raw SQL scattered in route handlers").
 *
 * Every route here is a thin wrapper so the service stays testable without HTTP.
 */

import express, { type Express } from 'express';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { SearchService, SearchResponse } from '@/search/service';
import type { RecallConfig } from '@/config';
import { HOST } from '@/config';
import { isAppError } from '@/errors';

export interface AppDeps {
  search: SearchService;
  config: RecallConfig;
  /**
   * Resolve an indexed file id (content hash) to its on-disk path.
   * Absent in tests that only exercise search; when absent, /img/* is 404.
   */
  imagePathFor?: (id: string) => string | null;
}

export function createApp(deps: AppDeps): Express {
  const app = express();

  app.use(express.json({ limit: '1mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, indexFolder: deps.config.indexFolder });
  });

  app.get('/api/search', async (req, res) => {
    const q = typeof req.query['q'] === 'string' ? req.query['q'] : '';
    const limitRaw = req.query['limit'];
    const limit = typeof limitRaw === 'string' ? Number(limitRaw) : undefined;

    try {
      const response: SearchResponse = await deps.search.search({
        q,
        ...(Number.isFinite(limit) ? { limit: limit as number } : {}),
      });
      res.json(response);
    } catch (e) {
      if (isAppError(e) && e.code === 'invalid_input') {
        res.status(400).json({ error: e.message, code: e.code });
        return;
      }
      throw e;
    }
  });

  // Serves generated thumbnails. The name is a content-hash cache key
  // (thumbCacheKey), never user input, and the resolved path is constrained to
  // the thumbs directory so no traversal is possible.
  app.get('/thumb/:name', (req, res) => {
    const name = typeof req.params['name'] === 'string' ? req.params['name'] : '';
    // Only a bare cache key is servable: no separators, no dots-only names.
    if (!/^[a-f0-9]+\.webp$/.test(name)) {
      res.status(400).json({ error: 'invalid thumbnail name' });
      return;
    }
    const file = join(deps.config.paths.thumbDir, name);
    if (!existsSync(file)) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.sendFile(file);
  });

  // Serves the original indexed images, addressed by content-hash file id.
  // The id is hex-only and the path always comes from the DB row — never
  // from user input — so no traversal is possible. Images are served
  // read-only (GOAL.md N10); nothing here modifies or deletes user files.
  app.get('/img/:id', (req, res) => {
    const id = typeof req.params['id'] === 'string' ? req.params['id'] : '';
    if (!/^[a-f0-9]{16,128}$/.test(id)) {
      res.status(400).json({ error: 'invalid image id' });
      return;
    }
    const file = deps.imagePathFor?.(id) ?? null;
    if (!file || !existsSync(file)) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.set('Cache-Control', 'private, max-age=86400');
    res.sendFile(file);
  });

  // Explicit 404 so an unrouted path does not fall through to express' HTML
  // default, which the React client would try to parse as JSON.
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'not found' });
  });

  return app;
}

/** Start the server bound to loopback. Never 0.0.0.0 (C1). */
export function startServer(deps: AppDeps) {
  const app = createApp(deps);
  return app.listen(deps.config.port, HOST, () => {
    console.log(`recall listening on http://${HOST}:${deps.config.port}`);
  });
}