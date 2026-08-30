/**
 * SWG's CRC-32.
 *
 * Ported from sharedFoundation/Crc.cpp: polynomial 0x04C11DB7, MSB-first, init
 * and final XOR both 0xFFFFFFFF, no input or output reflection. This is
 * CRC-32/BZIP2, *not* the reflected zlib CRC-32 — feeding a string to the wrong
 * one silently produces a plausible number that matches nothing.
 *
 * It is the key for object template ids, faction names, appearance names, and
 * every other place the game stores a hashed string instead of the string.
 */

const POLY = 0x04c11db7;
const INIT = 0xffffffff;

const table = new Uint32Array(256);
for (let i = 0; i < 256; i += 1) {
  let crc = i << 24;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc & 0x80000000) !== 0 ? ((crc << 1) ^ POLY) >>> 0 : (crc << 1) >>> 0;
  }
  table[i] = crc >>> 0;
}

export function crcBytes(data: Uint8Array, init: number = INIT): number {
  let crc = init >>> 0;
  for (const byte of data) {
    crc = (((table[((crc >>> 24) ^ byte) & 0xff] as number) ^ (crc << 8)) >>> 0) >>> 0;
  }
  return ((crc ^ init) >>> 0) >>> 0;
}

/** CRC of a string, matching `Crc::calculate(const char *)`. */
export function crc(text: string): number {
  // The engine hashes raw bytes of a narrow string; template and faction names
  // are ASCII, and UTF-8 agrees with them byte for byte.
  return crcBytes(new TextEncoder().encode(text));
}

/**
 * CRC of a normalised string, matching `Crc::normalizeAndCalculate`.
 * Normalisation lowercases and converts backslashes to forward slashes, which
 * is how asset paths are hashed.
 */
export function crcNormalized(text: string): number {
  return crc(text.toLowerCase().replace(/\\/g, '/'));
}

/** The CRC of the empty string, which the engine treats as "no value". */
export const CRC_NULL = crc('');
