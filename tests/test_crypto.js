// Login crypto: MD5 and RSA PKCS#1 v1.5, checked against Node's own crypto.
// Runs the real core.js, not a copy.
'use strict';
const path = require('path');
const fs = require('fs');
const vm = require('vm');
const nodeCrypto = require('crypto');

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; }
  else { failed++; console.log('FAIL  ' + name + (extra ? '  — ' + extra : '')); }
}

function loadCore() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'core.js'), 'utf8');
  const sandbox = { TextEncoder, atob, btoa, crypto: nodeCrypto.webcrypto, console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'core.js' });
  return sandbox.SolarCore;
}
const C = loadCore();

// ---------------------------------------------------------------- MD5
const md5Node = (s) => nodeCrypto.createHash('md5').update(s, 'utf8').digest('hex');

// RFC 1321 test suite
const rfc = {
  '': 'd41d8cd98f00b204e9800998ecf8427e',
  'a': '0cc175b9c0f1b6a831c399e269772661',
  'abc': '900150983cd24fb0d6963f7d28e17f72',
  'message digest': 'f96b697d7cb7938d525a2f31aaf161d0',
  'abcdefghijklmnopqrstuvwxyz': 'c3fcd3d76192e4007dfb496cca67e13b',
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789': 'd174ab98d277d9f5a5611c2c9f419d9f',
  '12345678901234567890123456789012345678901234567890123456789012345678901234567890': '57edf4a22be3c955ac49da2e2107b67a',
};
for (const [input, want] of Object.entries(rfc)) check('md5 RFC 1321: ' + JSON.stringify(input.slice(0, 20)), C.md5(input) === want, C.md5(input));

// Block boundaries are where hand-written MD5 goes wrong: lengths 55, 56, 63, 64, 65 …
for (const n of [54, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129, 1000]) {
  const s = 'x'.repeat(n);
  check('md5 length ' + n, C.md5(s) === md5Node(s));
}
// Multi-byte UTF-8 (an Afrikaans name, an emoji, accents)
for (const s of ['Ruan Harmsë', 'kraggie ☀️🔋', 'naïve café', '日本語']) check('md5 utf-8 ' + s, C.md5(s) === md5Node(s));
// Random strings
let randomOk = true;
for (let i = 0; i < 500; i++) {
  const s = nodeCrypto.randomBytes(1 + (i % 200)).toString('base64');
  if (C.md5(s) !== md5Node(s)) { randomOk = false; break; }
}
check('md5 500 random strings', randomOk);

// ---------------------------------------------------------------- signs
// The two strings Sunsynk expects, exactly.
const nonce = 1759730000123;
check('public-key sign', C.publicKeySign(nonce) === md5Node('nonce=1759730000123&source=sunsynkPOWER_VIEW'));
const key = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA';
check('token sign uses the first 10 key characters',
  C.tokenSign(nonce, key) === md5Node('nonce=1759730000123&source=sunsynkMIIBIjANBg'));

// ---------------------------------------------------------------- RSA
// Decrypt with BigInt so the check does not depend on Node's (now disabled) PKCS#1 decryption.
function b64urlToBig(s) {
  return BigInt('0x' + Buffer.from(s, 'base64url').toString('hex'));
}
function decryptPkcs1(cipherB64, jwk) {
  const n = b64urlToBig(jwk.n), d = b64urlToBig(jwk.d);
  const k = Buffer.from(jwk.n, 'base64url').length;
  const c = BigInt('0x' + Buffer.from(cipherB64, 'base64').toString('hex'));
  const m = C.modPow(c, d, n);
  const em = Buffer.from(m.toString(16).padStart(k * 2, '0'), 'hex');
  return em;
}

for (const bits of [1024, 2048]) {
  const { publicKey, privateKey } = nodeCrypto.generateKeyPairSync('rsa', { modulusLength: bits });
  const spkiB64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const jwk = privateKey.export({ format: 'jwk' });
  const k = bits / 8;

  for (const pw of ['correct horse', 'P@ssw0rd!', 'wagwoord-met-ë', 'x']) {
    const ct = C.rsaPkcs1Encrypt(spkiB64, pw);
    const ctBytes = Buffer.from(ct, 'base64');
    check(bits + '-bit ciphertext is exactly k bytes', ctBytes.length === k, ctBytes.length);
    const em = decryptPkcs1(ct, jwk);
    check(bits + '-bit block starts 00 02', em[0] === 0 && em[1] === 2);
    const sep = em.indexOf(0, 2);
    check(bits + '-bit padding is >= 8 non-zero bytes', sep >= 10, sep);
    check(bits + '-bit decrypts to the password: ' + pw, em.slice(sep + 1).toString('utf8') === pw);
  }

  // Node's own public-key check: a key it can read must give the same modulus we parsed.
  const parsed = C.parseRsaPublicKey(Buffer.from(spkiB64, 'base64'));
  check(bits + '-bit modulus parsed', parsed.n === b64urlToBig(jwk.n));
  check(bits + '-bit exponent parsed', parsed.e === 65537n);
  check(bits + '-bit key size', parsed.k === k);

  // PEM-wrapped and line-broken keys are tolerated
  const pem = publicKey.export({ type: 'spki', format: 'pem' });
  const fromPem = decryptPkcs1(C.rsaPkcs1Encrypt(pem, 'pem works'), jwk);
  check(bits + '-bit PEM input', fromPem.slice(fromPem.indexOf(0, 2) + 1).toString() === 'pem works');

  // Bare PKCS#1 RSAPublicKey
  const pkcs1 = publicKey.export({ type: 'pkcs1', format: 'der' }).toString('base64');
  const fromPkcs1 = decryptPkcs1(C.rsaPkcs1Encrypt(pkcs1, 'pkcs1 works'), jwk);
  check(bits + '-bit PKCS#1 input', fromPkcs1.slice(fromPkcs1.indexOf(0, 2) + 1).toString() === 'pkcs1 works');

  // Two encryptions of the same password differ (random padding)
  check(bits + '-bit padding is random', C.rsaPkcs1Encrypt(spkiB64, 'same') !== C.rsaPkcs1Encrypt(spkiB64, 'same'));

  // Too long for the key → refuse rather than produce garbage
  let threw = false;
  try { C.rsaPkcs1Encrypt(spkiB64, 'x'.repeat(k - 10)); } catch (e) { threw = /too long/.test(e.message); }
  check(bits + '-bit over-long password refused', threw);
}

// A padding source that keeps returning zeros must be replaced, never used
{
  const { publicKey, privateKey } = nodeCrypto.generateKeyPairSync('rsa', { modulusLength: 1024 });
  const spki = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  let calls = 0;
  const zeroish = (n) => { calls++; const b = new Uint8Array(n); if (calls > 1) b.fill(7); return b; };
  const em = decryptPkcs1(C.rsaPkcs1Encrypt(spki, 'zero test', zeroish), privateKey.export({ format: 'jwk' }));
  const sep = em.indexOf(0, 2);
  check('zero padding bytes replaced', sep === 128 - 'zero test'.length - 1, sep);
}

// A malformed key is a clear error, not a silent wrong answer
{
  let msg = '';
  try { C.rsaPkcs1Encrypt('AAAA', 'x'); } catch (e) { msg = e.message; }
  check('malformed key reported', /public key/.test(msg), msg);
}

console.log(`test_crypto: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
