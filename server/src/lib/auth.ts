import {
  createHash,
  randomBytes,
  scrypt,
  timingSafeEqual,
} from 'node:crypto'


// scrypt() uses callbacks by default.
// Wrap it ourselves because promisify() only preserves one of scrypt's
// overloads and loses the optional settings argument in TypeScript.
async function scryptAsync(
  password: string,
  salt: Buffer,
  keyLength: number,
  options?: { N?: number; r?: number; p?: number; maxmem?: number }
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyLength, options ?? {}, (error, derivedKey) => {
      if (error) {
        reject(error)
        return
      }

      resolve(derivedKey as Buffer)
    })
  })
}


// Password hashing settings.
//
// N = CPU/memory cost
// r = block size
// p = parallelisation factor
//
// These values are stored inside the password record too,
// so we can change them later without breaking old accounts.
const SCRYPT_N = 16384
const SCRYPT_R = 8
const SCRYPT_P = 1

// Number of random bytes used for each password salt.
const SALT_LENGTH = 16

// Number of bytes produced by scrypt.
const KEY_LENGTH = 64

// Session tokens contain 256 bits of randomness.
const SESSION_TOKEN_LENGTH = 32


/**
 * Hashes a password for permanent storage.
 *
 * Password + random salt -> scrypt -> derived key.
 *
 * We store everything needed to verify the password later
 * inside one self-describing string.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH)

  const derivedKey = (await scryptAsync(
    password,
    salt,
    KEY_LENGTH,
    {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
    }
  )) as Buffer

  // base64url converts binary Buffers into safe text.
  const encodedSalt = salt.toString('base64url')
  const encodedKey = derivedKey.toString('base64url')

  // Format:
  // algorithm$version$N$r$p$keyLength$salt$hash
  return [
    'scrypt',
    'v1',
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    KEY_LENGTH,
    encodedSalt,
    encodedKey,
  ].join('$')
}


/**
 * Checks whether a supplied password matches a stored hash.
 *
 * A malformed password record simply returns false instead
 * of crashing the login request.
 */
export async function verifyPassword(
  password: string,
  storedHash: string
): Promise<boolean> {
  try {
    const parts = storedHash.split('$')

    if (parts.length !== 8) {
      return false
    }

    // The length check guarantees all eight values exist. A tuple makes that
    // fact visible to TypeScript when noUncheckedIndexedAccess is enabled.
    const [
      algorithm,
      version,
      nText,
      rText,
      pText,
      keyLengthText,
      encodedSalt,
      encodedStoredKey,
    ] = parts as [string, string, string, string, string, string, string, string]

    if (algorithm !== 'scrypt' || version !== 'v1') {
      return false
    }

    // The parameters are stored with the hash so old accounts
    // still work if we increase the cost settings later.
    const N = Number(nText)
    const r = Number(rText)
    const p = Number(pText)
    const keyLength = Number(keyLengthText)

    if (
      !Number.isInteger(N) ||
      !Number.isInteger(r) ||
      !Number.isInteger(p) ||
      !Number.isInteger(keyLength) ||
      N <= 1 ||
      r <= 0 ||
      p <= 0 ||
      keyLength <= 0
    ) {
      return false
    }

    const salt = Buffer.from(encodedSalt, 'base64url')
    const storedKey = Buffer.from(encodedStoredKey, 'base64url')

    // Reject damaged or inconsistent records.
    if (salt.length === 0 || storedKey.length !== keyLength) {
      return false
    }

    // Hash the entered password again using the original salt
    // and the original scrypt settings.
    const suppliedKey = (await scryptAsync(
      password,
      salt,
      keyLength,
      {
        N,
        r,
        p,
      }
    )) as Buffer

    // Cryptographic comparisons should avoid normal === checks.
    // timingSafeEqual reduces timing information leakage.
    return timingSafeEqual(storedKey, suppliedKey)
  } catch {
    return false
  }
}


/**
 * Creates the secret session token given to the browser.
 *
 * This is generated randomly. It is not based on the user ID,
 * email, password or current time.
 */
export function createSessionToken(): string {
  return randomBytes(SESSION_TOKEN_LENGTH).toString('base64url')
}


/**
 * Hashes a session token before storing it in Postgres.
 *
 * Unlike passwords, session tokens already contain lots of
 * randomness, so a fast SHA-256 hash is appropriate here.
 */
export function hashSessionToken(token: string): string {
  return createHash('sha256')
    .update(token)
    .digest('hex')
}
