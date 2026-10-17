import type { IncomingHttpHeaders } from 'node:http';
import type { RequestHandler } from 'express';
import { gzipSync } from 'node:zlib';

const canonicalOrigin = 'https://asset.gtfol.dev';
export const HOSTED_PAYLOAD_BYTES = 4_000_000;
export const HOSTED_WORKSPACE_BYTES = 32_000_000;

export function jsonBodyLimit(): number {
  return process.env.VERCEL === '1' ? HOSTED_PAYLOAD_BYTES : 12 * 1024 * 1024;
}

const payloadMessage =
  'This data exceeds the hosted size limit. Use a smaller import or a self-hosted server.';

export function assertHostedPayloadSize(value: unknown): void {
  if (process.env.VERCEL !== '1') return;
  const body = Buffer.from(JSON.stringify(value));
  if (body.length > HOSTED_WORKSPACE_BYTES ||
    (body.length > HOSTED_PAYLOAD_BYTES && gzipSync(body, { level: 1 }).length > HOSTED_PAYLOAD_BYTES - 64_000))
    throw Object.assign(Error(payloadMessage), { status: 413 });
}

export const hostedPayloadGuard: RequestHandler = (req, res, next) => {
  if (process.env.VERCEL !== '1') return next();
  const send = res.send;
  res.send = function (body: unknown) {
    const size =
      typeof body === 'string' ? Buffer.byteLength(body) : Buffer.isBuffer(body) ? body.length : 0;
    // Compress at the function boundary, before Vercel applies its response limit.
    // Browsers and URLSession decode Content-Encoding automatically.
    if (size > 256_000 && size <= HOSTED_WORKSPACE_BYTES &&
      String(this.getHeader('content-type')).includes('application/json') &&
      !this.getHeader('content-encoding') && req.acceptsEncodings('gzip')) {
      const compressed = gzipSync(body as string | Buffer, { level: 1 });
      if (compressed.length <= HOSTED_PAYLOAD_BYTES) {
        this.setHeader('Content-Encoding', 'gzip');
        this.vary('Accept-Encoding');
        return send.call(this, compressed);
      }
    }
    if (size > HOSTED_PAYLOAD_BYTES) {
      this.status(413).type('application/json');
      this.removeHeader('Content-Disposition');
      return send.call(this, JSON.stringify({ error: payloadMessage }));
    }
    return send.call(this, body);
  };
  if (Number(req.headers['content-length'] ?? 0) > HOSTED_PAYLOAD_BYTES) {
    res.status(413).json({ error: payloadMessage });
    return;
  }
  next();
};

function normalizeOrigin(value: string) {
  const url = new URL(value);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw Error('APP_ORIGIN must be an HTTPS origin, or a local HTTP origin');
  return url.origin;
}

function configuredOrigin() {
  if (process.env.APP_ORIGIN) return normalizeOrigin(process.env.APP_ORIGIN.trim());
  return process.env.VERCEL === '1'
    ? canonicalOrigin
    : normalizeOrigin(`http://localhost:${process.env.PORT ?? 4317}`);
}

export function acceptedOrigins(): Set<string> {
  const origins = new Set([configuredOrigin()]);
  if (process.env.VERCEL === '1') {
    for (const key of ['VERCEL_URL', 'VERCEL_BRANCH_URL', 'VERCEL_PROJECT_PRODUCTION_URL']) {
      const host = process.env[key]?.trim();
      if (host) origins.add(normalizeOrigin(`https://${host}`));
    }
  } else {
    const local = new URL(configuredOrigin());
    if (local.hostname === 'localhost' || local.hostname === '127.0.0.1') {
      local.hostname = local.hostname === 'localhost' ? '127.0.0.1' : 'localhost';
      origins.add(local.origin);
    }
  }
  return origins;
}

export function publicOrigin(req?: { headers: IncomingHttpHeaders }): string {
  const origins = acceptedOrigins();
  const origin = req?.headers.origin;
  if (typeof origin === 'string' && origins.has(origin)) return origin;
  const host = req?.headers.host;
  if (typeof host === 'string') {
    const matching = [...origins].find((allowed) => new URL(allowed).host === host);
    if (matching) return matching;
  }
  return configuredOrigin();
}
