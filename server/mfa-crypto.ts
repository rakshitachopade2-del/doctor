import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

export function mfaEncryptionKey(value: string | undefined): Buffer | null {
  if (value === undefined || value === '') return null;
  if (!/^[a-f0-9]{64}$/i.test(value))
    throw new Error('MFA_ENCRYPTION_KEY must contain exactly 64 hexadecimal characters.');
  return Buffer.from(value, 'hex');
}
export const mfaHash = (value: string) => createHash('sha256').update(value).digest('hex');
export const mfaBinding = (key: Buffer, value: unknown) =>
  createHmac('sha256', key).update('mfa-command-v1:').update(JSON.stringify(value)).digest('hex');
export const mfaKeyCheck = (key: Buffer) =>
  createHmac('sha256', key).update('mfa-key-check-v1').digest('hex');
export function sealMfa(key: Buffer, userId: string, purpose: string, value: unknown): string {
  const nonce = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(JSON.stringify(['mfa-v1', userId, purpose])));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return JSON.stringify({
    version: 1,
    nonce: nonce.toString('base64'),
    ciphertext: encrypted.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  });
}
export function openMfa<T>(key: Buffer, userId: string, purpose: string, encoded: string): T {
  try {
    const value = JSON.parse(encoded) as {
      version: number;
      nonce: string;
      ciphertext: string;
      tag: string;
    };
    if (value.version !== 1) throw new Error();
    const nonce = Buffer.from(value.nonce, 'base64'),
      tag = Buffer.from(value.tag, 'base64');
    if (nonce.length !== 12 || tag.length !== 16) throw new Error();
    const cipher = createDecipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(Buffer.from(JSON.stringify(['mfa-v1', userId, purpose])));
    cipher.setAuthTag(tag);
    return JSON.parse(
      Buffer.concat([
        cipher.update(Buffer.from(value.ciphertext, 'base64')),
        cipher.final(),
      ]).toString('utf8'),
    ) as T;
  } catch {
    throw new Error('The configured MFA encryption key cannot open protected MFA data.');
  }
}
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32(value: Buffer): string {
  let output = '',
    bits = 0,
    buffer = 0;
  for (const byte of value) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += alphabet[(buffer >>> bits) & 31];
    }
  }
  if (bits) output += alphabet[(buffer << (5 - bits)) & 31];
  return output;
}
export function fromBase32(value: string): Buffer {
  if (!/^[A-Z2-7]+$/.test(value)) throw new Error('Invalid authenticator secret format.');
  const output: number[] = [];
  let bits = 0,
    buffer = 0;
  for (const char of value) {
    buffer = (buffer << 5) | alphabet.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      output.push((buffer >>> bits) & 255);
    }
  }
  return Buffer.from(output);
}
/** RFC6238 using standard HMAC; parameters beyond6/SHA1 are exposed only for reference-vector tests. */
export function totpAt(
  secret: Buffer,
  milliseconds: number,
  digits = 6,
  algorithm = 'sha1',
): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(milliseconds / 30000)));
  const hash = createHmac(algorithm, secret).update(counter).digest(),
    offset = hash[hash.length - 1] & 15;
  const number = (hash.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return String(number).padStart(digits, '0');
}
export function acceptedTotpStep(
  secret: string,
  code: string,
  milliseconds: number,
  lastStep: number,
): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const current = Math.floor(milliseconds / 30000),
    bytes = fromBase32(secret);
  let accepted: number | null = null;
  for (const step of [current - 1, current, current + 1]) {
    if (step < 0) continue;
    const expected = totpAt(bytes, step * 30000);
    if (timingSafeEqual(Buffer.from(code), Buffer.from(expected)) && step > lastStep)
      accepted = step;
  }
  return accepted;
}
export function recoveryCodes(): string[] {
  return Array.from({ length: 10 }, () =>
    randomBytes(16).toString('hex').toUpperCase().match(/.{8}/g)!.join('-'),
  );
}
export const normalizeRecoveryCode = (value: string) => value.replaceAll('-', '').toUpperCase();
export const recoveryCodeHash = (credentialId: string, code: string) =>
  mfaHash(`mfa-recovery-v1:${credentialId}:${normalizeRecoveryCode(code)}`);
