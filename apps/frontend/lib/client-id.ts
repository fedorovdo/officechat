let legacySequence = 0;

function formatUuid(bytes: Uint8Array) {
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0"));
  return [
    hex.slice(0, 4).join(""),
    hex.slice(4, 6).join(""),
    hex.slice(6, 8).join(""),
    hex.slice(8, 10).join(""),
    hex.slice(10, 16).join("")
  ].join("-");
}

function createLegacyBytes() {
  const bytes = new Uint8Array(16);
  const timestamp = Date.now();
  legacySequence = (legacySequence + 1) >>> 0;

  // This fallback is only for transient client IDs, never credentials or tokens.
  for (let index = 0; index < 6; index += 1) {
    bytes[index] = Math.floor(timestamp / (2 ** (8 * (5 - index)))) & 0xff;
  }
  for (let index = 0; index < 4; index += 1) {
    bytes[6 + index] = (legacySequence >>> (8 * (3 - index))) & 0xff;
  }
  for (let index = 10; index < 16; index += 1) {
    bytes[index] = Math.floor(Math.random() * 256);
  }

  return bytes;
}

export function createClientId(): string {
  const webCrypto = globalThis.crypto;

  if (typeof webCrypto?.randomUUID === "function") {
    try {
      return webCrypto.randomUUID();
    } catch {
      // Some non-secure browser contexts expose the method but reject calls.
    }
  }

  if (typeof webCrypto?.getRandomValues === "function") {
    try {
      return formatUuid(webCrypto.getRandomValues(new Uint8Array(16)));
    } catch {
      // Continue with a collision-resistant, non-cryptographic client ID.
    }
  }

  return formatUuid(createLegacyBytes());
}
