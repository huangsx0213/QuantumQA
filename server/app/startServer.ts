import { Log } from '../shared/services/logger';
import '../shared/services/fileLogger.ts';

import express from 'express';
import path from 'path';
import type { Server } from 'node:http';
import { createApp } from './createApp.ts';
import { wsService } from '../shared/services/websocketService.ts';
import { registerAgentWsHandlers } from '../modules/agent/ws-handlers.ts';
import { registerExecutionWsHandlers } from '../modules/execution/ws-handlers.ts';
import { registerRecordingWsHandlers } from '../modules/recording/ws-handlers.ts';

import { getInternalIp } from '../modules/agent/index.ts';
import { recoverInterruptedTestGenRuns } from '../modules/ai-test-gen/index.ts';
import { recoverInterruptedAiRecorderRuns } from '../modules/ai-driven-recorder/index.ts';
import { startHtmlKnowledgeCleanup } from '../modules/ai-test-gen/html-knowledge/cleanup.ts';

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

interface CleanupLifecycle {
  stop: () => void;
}

export function startCleanupAfterListening(
  server: Pick<Server, 'on' | 'once' | 'off'>,
  startCleanup: () => CleanupLifecycle = startHtmlKnowledgeCleanup,
  reportRuntimeError: (error: Error) => void = (error) => {
    Log.for('server').error(`HTTP server error after listening: ${error.message}`);
  },
): Promise<CleanupLifecycle> {
  return new Promise((resolve, reject) => {
    const onListenError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onListenError);
      let cleanup: CleanupLifecycle;
      try {
        cleanup = startCleanup();
      } catch (error) {
        reject(error);
        return;
      }
      let stopped = false;
      const stop = () => {
        if (stopped) return;
        stopped = true;
        cleanup.stop();
      };
      server.on('error', reportRuntimeError);
      server.once('close', stop);
      resolve({ stop });
    };
    server.once('error', onListenError);
    server.once('listening', onListening);
  });
}

export async function startServer(): Promise<Server> {
  let server: Server | undefined;
  let htmlKnowledgeCleanup: CleanupLifecycle | undefined;
  try {
    const app = createApp();

    if (process.env.NODE_ENV !== 'production') {
      const { createServer: createViteServer } = await import('vite');
      const vite = await createViteServer({
        server: { middlewareMode: true },
        appType: 'custom',
      });
    
      app.use(vite.middlewares);

      app.use(/^\/aut/, async (req, res, next) => {
        try {
          let template = await import('fs').then(m => m.readFileSync(path.resolve(process.cwd(), 'aut/aut.html'), 'utf-8'));
          template = await vite.transformIndexHtml(req.originalUrl, template);
          res.status(200).set({ 'Content-Type': 'text/html' }).end(template);
        } catch (e) {
          vite.ssrFixStacktrace(e as Error);
          next(e);
        }
      });

      app.use(async (req, res, next) => {
        try {
          let template = await import('fs').then(m => m.readFileSync(path.resolve(process.cwd(), 'index.html'), 'utf-8'));
          template = await vite.transformIndexHtml(req.originalUrl, template);
          res.status(200).set({ 'Content-Type': 'text/html' }).end(template);
        } catch (e) {
          vite.ssrFixStacktrace(e as Error);
          next(e);
        }
      });
    } else {
      const distPath = path.join(process.cwd(), 'dist');
      app.use(express.static(distPath));
      app.get(/^\/aut/, (req, res) => {
        res.sendFile(path.join(distPath, 'aut', 'aut.html'));
      });
      app.get(/.*/, (req, res) => {
        res.sendFile(path.join(distPath, 'index.html'));
      });
    }

    server = app.listen(PORT, '0.0.0.0');
    htmlKnowledgeCleanup = await startCleanupAfterListening(server);
    const internalIp = getInternalIp();
    Log.for('server').info(`Server running on:\n  - Local:   http://localhost:${PORT}\n  - Network: http://${internalIp}:${PORT}`);

    wsService.initialize(server);

    registerAgentWsHandlers();
    registerExecutionWsHandlers();
    registerRecordingWsHandlers();

// Recover any HITL runs that were waiting before restart
    recoverInterruptedTestGenRuns().catch(err => {
      Log.for('server').error(`Failed to recover interrupted test gen runs: ${err}`);
    });

    // Recover AI recorder runs interrupted by WS disconnect (COMPLETE lost before finalize)
    try {
      const recovered = recoverInterruptedAiRecorderRuns();
      if (recovered > 0) {
        Log.for('server').info(`Recovered ${recovered} interrupted AI recorder run(s)`);
      }
    } catch (err) {
      Log.for('server').error(`Failed to recover interrupted AI recorder runs: ${err}`);
    }
    return server;
  } catch (error) {
    htmlKnowledgeCleanup?.stop();
    if (server?.listening) server.close();
    throw error;
  }
}
