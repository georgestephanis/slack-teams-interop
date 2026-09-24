/**
 * Signed Media URLs
 * Slack file URLs need the bot token, but Teams clients load card images directly, so the bridge
 * serves Slack images through `/media/slack/<token>`. Tokens are HMAC-signed capability URLs:
 * anyone with the link can view that one image. Rotating MEDIA_PROXY_SECRET revokes all of them.
 */

import crypto from 'node:crypto';

export const MEDIA_PROXY_PATH = '/media/slack';

/** Largest file the bridge will download from either platform */
export const MAX_TRANSFER_BYTES = 20 * 1024 * 1024;

/** Hosts the proxy will fetch from; signing is the main guard, this is defense in depth. */
const ALLOWED_HOSTS = new Set(['files.slack.com']);

export class MediaSigner {
  constructor(
    private secret: string,
    private publicUrl: string
  ) {}

  /** Public proxy URL for a Slack `url_private`. */
  sign(fileUrl: string): string {
    const payload = Buffer.from(fileUrl, 'utf8').toString('base64url');
    return `${this.publicUrl}${MEDIA_PROXY_PATH}/${payload}.${this.mac(payload)}`;
  }

  /** Return the Slack file URL a token was issued for, or null if it's invalid or tampered with. */
  verify(token: string): string | null {
    const [payload, mac] = token.split('.');
    if (!payload || !mac) return null;

    const expected = Buffer.from(this.mac(payload));
    const actual = Buffer.from(mac);
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;

    const url = Buffer.from(payload, 'base64url').toString('utf8');
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'https:' && ALLOWED_HOSTS.has(parsed.hostname) ? url : null;
    } catch {
      return null;
    }
  }

  private mac(payload: string): string {
    return crypto.createHmac('sha256', this.secret).update(payload).digest('base64url');
  }
}
