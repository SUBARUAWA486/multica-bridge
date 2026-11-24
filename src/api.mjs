import { readJson } from './storage.mjs';
import http from 'node:http';
import https from 'node:https';
import { ClientGate, ClientClosedError } from './client-gate.mjs';
import { publicText, outboundBody } from './privacy.mjs';

export class APIError extends Error {
  constructor(method, endpoint, status, detail = '') { super(`${method} ${endpoint}: HTTP ${status}${detail ? ': ' + detail : ''}`); this.status = status; this.retryable = status === 429 || status >= 500; }
}
export class API {
  constructor(config, options = {}) { this.config = config; this.gate = options.gate ?? new ClientGate(config); }
  async request(method, endpoint, body, options = {}) {
    let clientSignal, dispatched = false;
    try {
      clientSignal = await this.gate.signal();
      // Resolve refreshed credentials per request; never persist or return them.
      const { token } = readJson(this.config.profilePath);
      if (!token) throw new Error('The configured Multica profile is not authenticated.');
      const privacy = { ...this.config, knownSecrets: [token] };
      const url = new URL(this.config.serverUrl.replace(/\/$/, '') + endpoint), payload = body === undefined ? undefined : JSON.stringify(outboundBody(body, privacy));
      return await new Promise((resolve, reject) => {
        options.beforeSend?.();
        if (clientSignal.aborted) throw new ClientClosedError();
        options.onDispatch?.();
        // No persistent HTTP pool remains connected after the desktop client exits.
        const transport = url.protocol === 'https:' ? https : http;
        const req = transport.request(url, { method, agent: false,
          signal: AbortSignal.any([clientSignal, AbortSignal.timeout(10000)]),
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Workspace-ID': this.config.workspaceId,
            ...(payload === undefined ? {} : { 'Content-Length': Buffer.byteLength(payload) }) } }, res => {
          const chunks = [];
          res.on('data', chunk => chunks.push(chunk)); res.on('error', reject);
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            if (res.statusCode < 200 || res.statusCode >= 300) {
              let detail = '';
              try { const error = JSON.parse(text); detail = [error.code, typeof error.error === 'string' ? error.error : undefined].filter(Boolean).join(': '); } catch {}
              return reject(new APIError(method, endpoint, res.statusCode, publicText(detail, privacy).slice(0, 1200)));
            }
            try { resolve(text ? JSON.parse(text) : null); } catch (e) { reject(e); }
          });
        });
        req.on('error', reject); dispatched = true; req.end(payload);
      });
    } catch (error) {
      const e = clientSignal?.aborted ? new ClientClosedError() : error;
      e.requestDelivery = dispatched ? 'unknown' : 'not_sent'; throw e;
    }
  }
}
export function list(value, key) { return Array.isArray(value) ? value : value?.[key] ?? []; }
