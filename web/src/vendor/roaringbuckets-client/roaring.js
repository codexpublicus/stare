/**
 * Roaring bitmap decoder.
 *
 * Decodes serialized Roaring bitmaps from pyroaring (native format).
 * Based on the Roaring bitmap specification.
 */

// Pyroaring format cookies
const SERIAL_COOKIE_NO_RUNCONTAINER = 12346; // 0x303a
// SERIAL_COOKIE is never followed by a u32 count: its high 16 bits hold
// numContainers - 1, so a one-container run bitmap has a cookie of exactly 0x303b.
const SERIAL_COOKIE = 12347; // 0x303b
const NO_OFFSET_THRESHOLD = 4;
// Containers with more values than this are stored as 8 KiB bitmaps.
const MAX_ARRAY_CARDINALITY = 4096;
const BITMAP_CONTAINER_BYTES = 8192;

/**
 * @typedef {Object} RoaringHeader
 * @property {DataView} view - View over the serialized bytes
 * @property {number} numContainers - Number of containers
 * @property {Uint16Array} keys - High 16 bits of each container
 * @property {Uint32Array} cardinalities - Number of values in each container
 * @property {Uint8Array | null} runBitmap - Which containers are run containers
 * @property {number} total - Number of values in the bitmap
 * @property {number} dataOffset - Byte offset of the first container
 */

/**
 * Throw for a bitmap that ends before `end`.
 *
 * @param {DataView} view
 * @param {number} end - Byte offset the decoder needs to read up to
 * @param {string} what - What is being read there
 */
function need(view, end, what) {
  if (end > view.byteLength) {
    throw new Error(
      `Truncated Roaring bitmap: ${what} needs ${end} bytes, only ${view.byteLength} present`
    );
  }
}

/**
 * Parse the cookie and container descriptions of a serialized bitmap.
 *
 * @param {Uint8Array} data - Serialized bitmap data
 * @returns {RoaringHeader}
 */
function parseHeader(data) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  need(view, 4, 'the cookie');
  const cookie = view.getUint32(0, true);
  let offset = 4;

  let numContainers;
  let hasRunContainers = false;
  let hasOffsetHeader = false;

  if (cookie === SERIAL_COOKIE_NO_RUNCONTAINER) {
    need(view, 8, 'the container count');
    numContainers = view.getUint32(offset, true);
    offset += 4;
    hasOffsetHeader = true;
  } else if ((cookie & 0xffff) === SERIAL_COOKIE_NO_RUNCONTAINER) {
    numContainers = (cookie >>> 16) + 1;
    hasOffsetHeader = numContainers >= NO_OFFSET_THRESHOLD;
  } else if ((cookie & 0xffff) === SERIAL_COOKIE) {
    numContainers = (cookie >>> 16) + 1;
    hasRunContainers = true;
    hasOffsetHeader = numContainers >= NO_OFFSET_THRESHOLD;
  } else {
    throw new Error(`Unknown Roaring bitmap format: 0x${cookie.toString(16)}`);
  }
  if (numContainers > 0x10000) {
    throw new Error(`Corrupt Roaring bitmap: ${numContainers} containers (at most 65536)`);
  }

  let runBitmap = null;
  if (hasRunContainers) {
    const runBitmapSize = Math.ceil(numContainers / 8);
    need(view, offset + runBitmapSize, 'the run container flags');
    runBitmap = data.subarray(offset, offset + runBitmapSize);
    offset += runBitmapSize;
  }

  need(view, offset + numContainers * 4, 'the container descriptions');
  const keys = new Uint16Array(numContainers);
  const cardinalities = new Uint32Array(numContainers);
  let total = 0;
  for (let i = 0; i < numContainers; i++) {
    keys[i] = view.getUint16(offset, true);
    const cardinality = view.getUint16(offset + 2, true) + 1;
    cardinalities[i] = cardinality;
    total += cardinality;
    offset += 4;
  }

  if (hasOffsetHeader) {
    offset += numContainers * 4;
    need(view, offset, 'the container offsets');
  }

  return { view, numContainers, keys, cardinalities, runBitmap, total, dataOffset: offset };
}

/**
 * Decode up to `limit` values into a Uint32Array.
 *
 * Stops reading as soon as `limit` values are out, so containers past that point are
 * neither decoded nor checked.
 *
 * @param {Uint8Array} data - Serialized bitmap data
 * @param {number} limit - Maximum number of values to decode
 * @returns {Uint32Array}
 */
function decodeInto(data, limit) {
  const { view, numContainers, keys, cardinalities, runBitmap, total, dataOffset } =
    parseHeader(data);
  const size = Math.max(0, Math.min(total, Math.floor(limit)));
  const out = new Uint32Array(size);
  let offset = dataOffset;
  let pos = 0;

  for (let i = 0; i < numContainers && pos < size; i++) {
    // key * 65536, not key << 16: the shift is signed 32-bit and turns keys
    // >= 0x8000 (ids >= 2^31) negative. Uint32Array stores the sum unsigned.
    const base = keys[i] * 0x10000;
    const cardinality = cardinalities[i];
    const start = pos;
    // Values this container may write before the output (or the limit) is full.
    const stop = Math.min(size, pos + cardinality);
    const isRun = runBitmap !== null && (runBitmap[i >>> 3] & (1 << (i & 7))) !== 0;

    if (isRun) {
      need(view, offset + 2, `run container ${i}`);
      const numRuns = view.getUint16(offset, true);
      offset += 2;
      need(view, offset + numRuns * 4, `run container ${i}`);
      let count = 0;
      for (let r = 0; r < numRuns; r++) {
        const runStart = view.getUint16(offset + r * 4, true);
        const length = view.getUint16(offset + r * 4 + 2, true);
        if (runStart + length > 0xffff) {
          throw new Error(`Corrupt Roaring bitmap: run past 65535 in container ${i}`);
        }
        count += length + 1;
      }
      if (count !== cardinality) {
        throw new Error(
          `Corrupt Roaring bitmap: container ${i} runs hold ${count} values, header says ${cardinality}`
        );
      }
      for (let r = 0; r < numRuns && pos < stop; r++) {
        const runStart = base + view.getUint16(offset + r * 4, true);
        const runEnd = Math.min(
          runStart + view.getUint16(offset + r * 4 + 2, true) + 1,
          runStart + stop - pos
        );
        for (let v = runStart; v < runEnd; v++) out[pos++] = v;
      }
      offset += numRuns * 4;
    } else if (cardinality <= MAX_ARRAY_CARDINALITY) {
      need(view, offset + cardinality * 2, `array container ${i}`);
      for (let p = offset; pos < stop; p += 2) out[pos++] = base + view.getUint16(p, true);
      offset += cardinality * 2;
    } else {
      need(view, offset + BITMAP_CONTAINER_BYTES, `bitmap container ${i}`);
      const end = offset + BITMAP_CONTAINER_BYTES;
      // Each 64-bit word is read as two little-endian u32 halves. w & -w isolates the
      // lowest set bit and 31 - clz32 gives its index; ^= clears it.
      let wordBase = base;
      for (let p = offset; p < end && pos < stop; p += 4, wordBase += 32) {
        let w = view.getUint32(p, true);
        while (w !== 0 && pos < stop) {
          const t = w & -w;
          out[pos++] = wordBase + 31 - Math.clz32(t);
          w ^= t;
        }
      }
      offset = end;
    }

    if (pos < size && pos - start !== cardinality) {
      throw new Error(
        `Corrupt Roaring bitmap: container ${i} holds ${pos - start} values, header says ${cardinality}`
      );
    }
  }

  return out;
}

/**
 * Copy a Uint32Array into a plain array.
 *
 * An indexed copy into a preallocated array; Array.from and spread are several times
 * slower on typed arrays.
 *
 * @param {Uint32Array} ids
 * @returns {number[]}
 */
function toArray(ids) {
  const out = new Array(ids.length);
  for (let i = 0; i < ids.length; i++) out[i] = ids[i];
  return out;
}

/**
 * Decode a serialized Roaring bitmap into a Uint32Array.
 *
 * The fast path: the output is sized from the container cardinalities up front and
 * holds ids up to 2^32 - 1 unsigned. Throws on truncated or inconsistent input.
 *
 * @param {Uint8Array} data - Serialized bitmap data
 * @returns {Uint32Array} Sorted ids in the bitmap
 */
export function decodeRoaringU32(data) {
  return decodeInto(data, Number.POSITIVE_INFINITY);
}

/**
 * Decode a serialized Roaring bitmap and return an array of integers.
 *
 * @param {Uint8Array} data - Serialized bitmap data
 * @returns {number[]} Array of integers in the bitmap
 */
export function decodeRoaring(data) {
  return toArray(decodeRoaringU32(data));
}

/**
 * Decode a Roaring bitmap and return first N results.
 *
 * Stops decoding once it has `limit` values.
 *
 * @param {Uint8Array} data - Serialized bitmap data
 * @param {number} limit - Maximum results to return
 * @returns {number[]} Array of integers (up to limit)
 */
export function decodeRoaringLimit(data, limit) {
  return toArray(decodeInto(data, limit));
}

/**
 * Get the cardinality of a Roaring bitmap without fully decoding.
 *
 * @param {Uint8Array} data - Serialized bitmap data
 * @returns {number} Total number of integers in the bitmap
 */
export function countRoaring(data) {
  return parseHeader(data).total;
}

/**
 * Intersect two sorted arrays of integers.
 *
 * @param {ArrayLike<number>} a - First sorted array (a Uint32Array works)
 * @param {ArrayLike<number>} b - Second sorted array
 * @returns {number[]} Sorted array of integers in both a and b
 */
export function intersect(a, b) {
  const result = [];
  let i = 0;
  let j = 0;

  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      result.push(a[i]);
      i++;
      j++;
    } else if (a[i] < b[j]) {
      i++;
    } else {
      j++;
    }
  }

  return result;
}

/**
 * Union two sorted arrays of integers.
 *
 * @param {ArrayLike<number>} a - First sorted array (a Uint32Array works)
 * @param {ArrayLike<number>} b - Second sorted array
 * @returns {number[]} Sorted array of integers in a or b
 */
export function union(a, b) {
  const result = [];
  let i = 0;
  let j = 0;

  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      result.push(a[i]);
      i++;
      j++;
    } else if (a[i] < b[j]) {
      result.push(a[i]);
      i++;
    } else {
      result.push(b[j]);
      j++;
    }
  }

  while (i < a.length) {
    result.push(a[i]);
    i++;
  }
  while (j < b.length) {
    result.push(b[j]);
    j++;
  }

  return result;
}
