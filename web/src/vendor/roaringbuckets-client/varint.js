/**
 * Variable-length integer encoding/decoding for RoaringBuckets.
 *
 * Uses standard varint encoding where each byte stores 7 bits of data
 * and the high bit indicates whether more bytes follow.
 */

// A u64 needs at most ten 7-bit groups; anything longer is malformed.
const MAX_VARINT_BYTES = 10;

/**
 * Decode a variable-length integer from a Uint8Array.
 *
 * Values are returned as JavaScript numbers and are exact up to
 * Number.MAX_SAFE_INTEGER (2^53 - 1). The bytes are combined with
 * multiplication rather than 32-bit bitwise operators, so offsets, lengths
 * and blob ids past 2^31 and 2^32 decode correctly.
 *
 * A varint whose value exceeds 2^53 - 1 throws a RangeError instead of
 * returning a rounded number or a BigInt. Every varint in the format is a blob
 * id, byte offset or byte length; 2^53 bytes is 8 PiB, so a larger value means
 * a corrupt or hostile index, and returning a BigInt would force every caller
 * to handle two numeric types for a case no real dataset reaches.
 *
 * @param {Uint8Array} data - Bytes containing the encoded varint
 * @param {number} [offset=0] - Starting offset in the data
 * @returns {[number, number]} Tuple of [decoded value, number of bytes consumed]
 * @throws {Error} If the data is truncated or the varint is longer than 10 bytes
 * @throws {RangeError} If the value exceeds Number.MAX_SAFE_INTEGER
 */
export function decodeVarint(data, offset = 0) {
  let result = 0;
  let multiplier = 1;
  let bytesRead = 0;

  while (true) {
    if (offset + bytesRead >= data.length) {
      throw new Error('Truncated varint');
    }
    if (bytesRead >= MAX_VARINT_BYTES) {
      throw new Error(`Varint longer than ${MAX_VARINT_BYTES} bytes`);
    }

    const byte = data[offset + bytesRead];
    // Once the true value passes 2^53 - 1 the float sum is at least 2^53, so
    // this check catches overflow even though the sum itself may be rounded.
    result += (byte & 0x7f) * multiplier;
    bytesRead += 1;
    if (result > Number.MAX_SAFE_INTEGER) {
      throw new RangeError(`Varint at offset ${offset} exceeds Number.MAX_SAFE_INTEGER (2^53 - 1)`);
    }

    if (!(byte & 0x80)) {
      break;
    }

    multiplier *= 128;
  }

  return [result, bytesRead];
}

/**
 * Decode multiple varints representing (blobId, offset, length) tuples.
 *
 * @param {Uint8Array} data - Bytes containing encoded ref tuples
 * @param {number} count - Number of refs to decode
 * @returns {Array<{blobId: number, offset: number, length: number}>}
 */
export function decodeRefs(data, count) {
  const refs = [];
  let pos = 0;

  for (let i = 0; i < count; i++) {
    const [blobId, blobIdLen] = decodeVarint(data, pos);
    pos += blobIdLen;

    const [offset, offsetLen] = decodeVarint(data, pos);
    pos += offsetLen;

    const [length, lengthLen] = decodeVarint(data, pos);
    pos += lengthLen;

    refs.push({ blobId, offset, length });
  }

  return refs;
}
