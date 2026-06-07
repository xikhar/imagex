import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

export const imagexSessionHeader = 'x-imagex-session';

export function createLocalSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function isLoopbackHost(host: string): boolean {
  const normalized = stripHostPort(host).toLowerCase();
  if (!normalized || normalized === 'localhost' || normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') return true;
  if (/^127(?:\.\d{1,3}){3}$/.test(normalized)) return normalized.split('.').every((part) => Number(part) >= 0 && Number(part) <= 255);
  return false;
}

export function assertSafeBindHost(host: string, allowRemote = false): void {
  if (isLoopbackHost(host) || allowRemote) return;
  throw new Error(
    `Refusing to bind ImageX to non-loopback host "${host}". Use --allow-remote only on trusted networks.`
  );
}

export function remoteBindWarning(host: string): string | null {
  if (isLoopbackHost(host)) return null;
  return `Warning: ImageX is bound to ${host}. Anyone who can reach this address may access local projects and generated files.`;
}

export function isMutatingApiRequest(method: string, path: string): boolean {
  return path.startsWith('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase());
}

export function isAllowedMutationOrigin(origin: string | undefined, requestHost: string | undefined): boolean {
  if (!origin) return true;
  try {
    const originUrl = new URL(origin);
    const originHost = stripHostPort(originUrl.host);
    const host = stripHostPort(requestHost || '');
    return originHost === host || isLoopbackHost(originHost);
  } catch {
    return false;
  }
}

export function isValidSessionHeader(expectedToken: string, providedToken: string | undefined): boolean {
  if (!providedToken) return false;
  const expected = Buffer.from(expectedToken);
  const provided = Buffer.from(providedToken);
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}

export function createSessionGuard(expectedToken: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!isMutatingApiRequest(req.method, req.path)) {
      next();
      return;
    }

    if (!isAllowedMutationOrigin(req.get('origin'), req.get('host'))) {
      res.status(403).json({ error: 'Rejected cross-origin ImageX mutation request.' });
      return;
    }

    if (!isValidSessionHeader(expectedToken, req.get(imagexSessionHeader))) {
      res.status(403).json({ error: 'Missing or invalid ImageX session token.' });
      return;
    }

    next();
  };
}

function stripHostPort(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('[')) return trimmed.slice(1, trimmed.indexOf(']') >= 0 ? trimmed.indexOf(']') : undefined);
  const colonIndex = trimmed.lastIndexOf(':');
  if (colonIndex > -1 && trimmed.indexOf(':') === colonIndex) return trimmed.slice(0, colonIndex);
  return trimmed;
}
