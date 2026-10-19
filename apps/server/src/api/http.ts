import { createServer } from 'node:http';
import type { HealthReader } from '../application/ports.js';

export function createHttp(health: HealthReader) {
  return createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    const path = request.url?.split('?')[0];
    if (path !== '/health/live' && path !== '/health/ready') {
      response.writeHead(404).end(JSON.stringify({code: 'NOT_FOUND'})); return;
    }
    if (request.method !== 'GET') {
      response.setHeader('Allow', 'GET');
      response.writeHead(405).end(JSON.stringify({code: 'METHOD_NOT_ALLOWED'})); return;
    }
    const status = health.status();
    const ok = path === '/health/live' ? status.phase !== 'stopped' && status.phase !== 'failed' : status.phase === 'ready';
    response.writeHead(ok ? 200 : 503).end(JSON.stringify(status));
  });
}
