const crypto = require('crypto');

// 1. Generate random string (Code Verifier)
function generateRandomString(length) {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  for (let i = 0; i < length; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

// 2. Encryption SHA256 base64url (Code Challenge)
    // Hashing
function sha256(plain) {
  const encoder = new TextEncoder();
  const data = encoder.encode(plain);
  return crypto.createHash('sha256').update(data).digest();
}

    // Encoding
function base64urlencode(a) {
  return btoa(String.fromCharCode.apply(null, new Uint8Array(a)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function generateCodeChallenge(codeVerifier) {
  const hashed = sha256(codeVerifier);
  return base64urlencode(hashed);
}

module.exports = {
  generateRandomString,
  generateCodeChallenge
};