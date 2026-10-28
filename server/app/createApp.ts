import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';

import { runMigrations } from '../migrations/index.ts';
import { handleApiError } from '../shared/http/responses.ts';
import { registerRoutes } from './registerRoutes.ts';

export type TrustProxySetting = boolean | number | string;

const PRODUCTION_TRUST_PROXY = 'loopback, linklocal, uniquelocal';

export function createApp() {
  const app = express();
  app.set(
    'trust proxy',
    resolveTrustProxySetting(process.env.TRUST_PROXY, process.env.NODE_ENV),
  );

  app.use(cors());
  const parseStandardJson = express.json({ limit: '2mb' });
  const parsePrdJson = express.json({ limit: '50mb' });
  app.use((req, res, next) => {
    if (isHtmlKnowledgePageUpload(req)) {
      next();
      return;
    }
    if (isPrdDocumentUpload(req)) {
      parsePrdJson(req, res, next);
      return;
    }
    parseStandardJson(req, res, next);
  });

  runMigrations();

  registerRoutes(app);

  app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    handleApiError(res, error);
  });

  return app;
}

const HTML_KNOWLEDGE_PAGE_UPLOAD_PATH =
  /^\/api\/test-gen\/[^/]+\/html-knowledge-sets\/[^/]+\/pages\/[^/]+\/?$/iu;

function isHtmlKnowledgePageUpload(req: Request): boolean {
  return req.method === 'PUT' && HTML_KNOWLEDGE_PAGE_UPLOAD_PATH.test(req.path);
}

const PRD_DOCUMENT_UPLOAD_PATH =
  /^\/api\/requirements\/[^/]+\/documents\/(?:parse-preview|commit)\/?$/iu;

function isPrdDocumentUpload(req: Request): boolean {
  return req.method === 'POST' && PRD_DOCUMENT_UPLOAD_PATH.test(req.path);
}

export function resolveTrustProxySetting(
  configuredValue: string | undefined,
  nodeEnvironment: string | undefined,
): TrustProxySetting {
  const value = configuredValue?.trim();
  if (!value) return nodeEnvironment === 'production' ? PRODUCTION_TRUST_PROXY : false;
  if (value.toLowerCase() === 'false') return false;
  if (value.toLowerCase() === 'true') return true;
  if (/^\d+$/u.test(value)) {
    const hops = Number(value);
    if (!Number.isSafeInteger(hops)) throw new Error('TRUST_PROXY hop count is invalid');
    return hops;
  }
  return value;
}
