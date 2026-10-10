/**
 * HTTP layer.
 *
 * Deliberately thin: it parses, delegates to SearchService, and formats. No
 * ranking logic, no SQL (AGENT.md — "no raw SQL scattered in route handlers").
 *
 * Every route here is a thin wrapper so the service stays testable without HTTP.
 */

import express, { type Express } from 'express';
import type { SearchService, SearchResponse } from '@/search/service';
import type { RecallConfig } from '@/config';
import { HOST } from '@/config';
import { isAppError } from '@/errors';

export interface AppDeps {
  search: SearchService;
  config: RecallConfig;
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