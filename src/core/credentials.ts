/**
 * Encryption for platform secrets stored in the database (Teams connection client secrets).
 * AES-256-GCM, with the key derived from CREDENTIALS_KEY.
 */

import crypto from 'node:crypto';

const VERSION = 'v1';

export class CredentialCipher {
  private key: Buffer;

  constructor(secret: string) {
    if (secret.length < 32) throw new Error('CREDENTIALS_KEY must be at least 32 characters');
    this.key = Buffer.from(crypto.hkdfSync('sha256', secret, Buffer.alloc(0), 'interbridge-credentials-v1', 32));
  }

  encrypt(plaintext: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return [VERSION, iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(':');
  }

  /** Throws if the value was encrypted with a different key or has been tampered with. */
  decrypt(stored: string): string {
    const [version, iv, tag, data] = stored.split(':');
    if (version !== VERSION || !iv || !tag || data === undefined) throw new Error('unrecognised encrypted credential');
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
  }
}
