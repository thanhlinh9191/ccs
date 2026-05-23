import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import express from 'express';
import type { Server } from 'http';
import { registerCliproxyRestartRoute } from '../../../src/web-server/routes/cliproxy-stats-routes';

describe('cliproxy stats routes restart endpoint', () => {
  let server: Server;
  let baseUrl = '';
  let restartMock: ReturnType<typeof mock>;

  beforeEach(async () => {
    restartMock = mock(async () => ({ success: true, port: 8317 }));

    const app = express();
    app.use(express.json());
    const restartRouter = express.Router();
    registerCliproxyRestartRoute(restartRouter, restartMock);
    app.use('/api/cliproxy', restartRouter);

    server = await new Promise<Server>((resolve, reject) => {
      const instance = app.listen(0, '127.0.0.1');
      instance.once('error', reject);
      instance.once('listening', () => resolve(instance));
    });

    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Unable to resolve test server port');
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('routes POST /api/cliproxy/restart through restart semantics', async () => {
    const response = await fetch(`${baseUrl}/api/cliproxy/restart`, { method: 'POST' });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, port: 8317 });
    expect(restartMock).toHaveBeenCalledTimes(1);
  });
});
