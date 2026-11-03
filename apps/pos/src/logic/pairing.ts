import { UUID_RE } from '@retail/shared';
import { t } from '../i18n/current';

export interface Pairing { api: string; device_id: string; device_secret: string }

function base64UrlDecode(s: string): string {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=');
  const bin = globalThis.atob(b64);
  // UTF-8 decode without TextDecoder (not available on every RN runtime).
  return decodeURIComponent(Array.from(bin, (c) => `%${c.charCodeAt(0).toString(16).padStart(2, '0')}`).join(''));
}

/** Pairing code = base64url(JSON {api, device_id, device_secret}) from the back office / seed script. */
export function decodePairingCode(code: string): Pairing {
  const cleaned = code.replace(/\s+/g, '');
  if (!cleaned) throw new Error(t('error.pairEmpty'));
  let parsed: unknown;
  try {
    parsed = JSON.parse(base64UrlDecode(cleaned));
  } catch {
    throw new Error(t('error.pairInvalid'));
  }
  const p = parsed as Partial<Pairing>;
  if (typeof p.api !== 'string' || !/^https?:\/\//.test(p.api)) throw new Error(t('error.pairNoApi'));
  if (typeof p.device_id !== 'string' || !UUID_RE.test(p.device_id)) throw new Error(t('error.pairNoDevice'));
  if (typeof p.device_secret !== 'string' || p.device_secret.length < 20) throw new Error(t('error.pairNoSecret'));
  return { api: p.api.replace(/\/+$/, ''), device_id: p.device_id, device_secret: p.device_secret };
}
