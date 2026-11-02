/**
 * Reader for the dataset-level blob location table (RBLT v1).
 *
 * The table maps a blob id to the blob file holding it and the blob's byte range there.
 * Rows are fixed width and indexed by blob id, so the row for any id is at a computed
 * offset, and one multi-range request fetches the rows for a page of ids. See docs/FORMAT_V3.md.
 */

import { coalesceRanges } from './ranges.js';
import {
  LOCATION_ABSENT_FILE,
  LOCATION_HEADER_SIZE,
  LOCATION_MAGIC,
  LOCATION_ROW_SIZE,
  LOCATION_VERSION,
} from './types.js';

/** 2^32, for combining two u32 halves without bitwise operators (which truncate to 32 bits). */
const TWO_POW_32 = 2 ** 32;

/** The largest high word whose u64 still fits in Number.MAX_SAFE_INTEGER (2^53 - 1). */
const MAX_SAFE_HIGH_WORD = 0x1fffff;

/**
 * Read a little-endian u64 as a Number, refusing values past Number.MAX_SAFE_INTEGER.
 *
 * @param {DataView} view - View over the bytes
 * @param {number} at - Byte offset of the u64
 * @param {string} what - Field name, for the error message
 * @returns {number}
 */
function readU64(view, at, what) {
  const low = view.getUint32(at, true);
  const high = view.getUint32(at + 4, true);
  if (high > MAX_SAFE_HIGH_WORD) {
    throw new Error(`Location table ${what} exceeds Number.MAX_SAFE_INTEGER`);
  }
  return high * TWO_POW_32 + low;
}

/**
 * Parse and validate a location table header.
 *
 * @param {Uint8Array} bytes - The first LOCATION_HEADER_SIZE bytes of the table
 * @returns {{version: number, rowSize: number, firstId: number, flags: number, rowCount: number}}
 */
export function parseLocationHeader(bytes) {
  if (bytes.length < LOCATION_HEADER_SIZE) {
    throw new Error(`Location table too small: ${bytes.length} bytes`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = view.getUint32(0, true);
  if (magic !== LOCATION_MAGIC) {
    throw new Error(`Invalid location table magic: 0x${magic.toString(16)}`);
  }
  const version = view.getUint16(4, true);
  if (version !== LOCATION_VERSION) {
    throw new Error(`Unsupported location table version: ${version}`);
  }
  const rowSize = view.getUint16(6, true);
  if (rowSize !== LOCATION_ROW_SIZE) {
    throw new Error(`Unsupported location table row size: ${rowSize}`);
  }
  return {
    version,
    rowSize,
    firstId: view.getUint32(8, true),
    flags: view.getUint32(12, true),
    rowCount: readU64(view, 16, 'row count'),
  };
}

/**
 * Decode one location table row.
 *
 * @param {Uint8Array} bytes - Bytes containing the row
 * @param {number} at - Offset of the row within `bytes`
 * @param {number} blobId - The row's blob id
 * @returns {{blobId: number, file: number, offset: number, length: number} | null} The ref,
 *   or null for a row with no blob
 */
export function parseLocationRow(bytes, at, blobId) {
  const view = new DataView(bytes.buffer, bytes.byteOffset + at, LOCATION_ROW_SIZE);
  const file = view.getUint16(12, true);
  if (file === LOCATION_ABSENT_FILE) return null;
  return {
    blobId,
    file,
    offset: readU64(view, 0, `offset for blob ${blobId}`),
    length: view.getUint32(8, true),
  };
}

/**
 * Resolves blob ids to refs by range-reading rows of a location table.
 */
export class LocationTable {
  /** @type {string} */
  #url;
  /** @type {number} */
  #firstId;
  /** @type {number} */
  #count;
  /** @type {LocationTableIO} */
  #io;
  /** @type {Promise<Object> | null} */
  #header = null;

  /**
   * @param {string} url - Table file URL
   * @param {{firstId: number, count: number}} layout - `first_id` and `count` from the manifest
   * @param {LocationTableIO} io - Range fetching, caching and coalescing, supplied by BlobReader
   */
  constructor(url, { firstId, count }, io) {
    this.#url = url;
    this.#firstId = firstId;
    this.#count = count;
    this.#io = io;
  }

  /** @returns {string} Table file URL */
  get url() {
    return this.#url;
  }

  /** @returns {number} Blob id of the first row */
  get firstId() {
    return this.#firstId;
  }

  /** @returns {number} Number of rows */
  get count() {
    return this.#count;
  }

  /**
   * Byte range of a blob id's row, or null when the id is outside the table.
   *
   * @param {number} blobId - Blob id
   * @returns {{start: number, end: number} | null} Half-open byte range
   */
  rowRange(blobId) {
    const index = blobId - this.#firstId;
    if (!Number.isInteger(index) || index < 0 || index >= this.#count) return null;
    const start = LOCATION_HEADER_SIZE + index * LOCATION_ROW_SIZE;
    return { start, end: start + LOCATION_ROW_SIZE };
  }

  /**
   * Check header bytes against the manifest.
   *
   * @param {Uint8Array} bytes - The table's first LOCATION_HEADER_SIZE bytes
   * @returns {Object} Parsed header
   */
  #checkHeader(bytes) {
    const header = parseLocationHeader(bytes);
    if (header.firstId !== this.#firstId || header.rowCount !== this.#count) {
      throw new Error(
        `Location table header (first_id ${header.firstId}, ${header.rowCount} rows) ` +
          `disagrees with the manifest (first_id ${this.#firstId}, ${this.#count} rows)`
      );
    }
    return header;
  }

  /**
   * Resolve blob ids to refs.
   *
   * Rows near each other are merged into one range, the same way `getBlobs` merges blob
   * ranges, and all of them go out in one multi-range request. With a range cache, each
   * row is looked up and stored under its own range. On first use the header range rides
   * in the same request as the rows (unless the cache has it) and is checked against the
   * manifest before any row is decoded.
   *
   * @param {number[]} blobIds - Blob ids, from index bitmaps
   * @returns {Promise<Array<{blobId: number, file: number, offset: number, length: number} | null>>}
   *   One ref per id, in the same order; null for an id the table has no blob for
   */
  async lookup(blobIds) {
    // Claim the header check synchronously, so concurrent lookups share one fetch of it.
    /** @type {{resolve: (bytes: Uint8Array) => void, reject: (err: unknown) => void} | null} */
    let headerBytes = null;
    if (!this.#header) {
      /** @type {Promise<Uint8Array>} */
      const bytes = new Promise((resolve, reject) => {
        headerBytes = { resolve, reject };
      });
      const checked = bytes
        .then((b) => this.#checkHeader(b))
        .catch((err) => {
          if (this.#header === checked) this.#header = null; // let a later call retry
          throw err;
        });
      // Callers that need the result await it below; this keeps a failure nobody else is
      // waiting on from surfacing as an unhandled rejection.
      checked.catch(() => {});
      this.#header = checked;
    }
    const header = this.#header;

    try {
      /** @type {Map<number, {blobId: number, file: number, offset: number, length: number} | null>} */
      const found = new Map();
      /** @type {Map<number, {start: number, end: number, blobId: number}>} */
      const pending = new Map();
      /** @type {Map<number, Uint8Array>} */
      const cachedRows = new Map();

      await Promise.all(
        blobIds.map(async (blobId) => {
          if (found.has(blobId) || pending.has(blobId)) return;
          const range = this.rowRange(blobId);
          if (!range) {
            found.set(blobId, null);
            return;
          }
          pending.set(blobId, { ...range, blobId });
          const hit = await this.#io.cacheGet(this.#url, range.start, range.end);
          if (hit) {
            pending.delete(blobId);
            cachedRows.set(blobId, hit);
          }
        })
      );

      /** @type {Array<{start: number, end: number, members: Array<{start: number, end: number, blobId: number}>}>} */
      const ranges = coalesceRanges([...pending.values()], {
        gap: this.#io.coalesceGap,
        maxBytes: this.#io.maxRangeBytes,
      });
      let headerAt = -1;
      if (headerBytes) {
        const hit = await this.#io.cacheGet(this.#url, 0, LOCATION_HEADER_SIZE);
        if (hit) {
          headerBytes.resolve(hit);
        } else {
          headerAt = ranges.length;
          ranges.push({ start: 0, end: LOCATION_HEADER_SIZE, members: [] });
        }
      }

      const chunks = ranges.length ? await this.#io.fetchRanges(this.#url, ranges) : [];
      if (headerBytes && headerAt >= 0) {
        headerBytes.resolve(chunks[headerAt]);
        await this.#io.cacheSet(this.#url, 0, LOCATION_HEADER_SIZE, chunks[headerAt]);
      }
      await header;

      for (const [blobId, row] of cachedRows) found.set(blobId, parseLocationRow(row, 0, blobId));
      await Promise.all(
        ranges.flatMap((group, g) =>
          group.members.map((member) => {
            const at = member.start - group.start;
            found.set(member.blobId, parseLocationRow(chunks[g], at, member.blobId));
            const row = chunks[g].slice(at, at + LOCATION_ROW_SIZE);
            return this.#io.cacheSet(this.#url, member.start, member.end, row);
          })
        )
      );

      return blobIds.map((blobId) => found.get(blobId) ?? null);
    } catch (err) {
      headerBytes?.reject(err);
      throw err;
    }
  }
}

/**
 * I/O hooks a LocationTable uses, supplied by BlobReader so the table shares its fetch
 * function, range cache and coalescing settings.
 *
 * @typedef {Object} LocationTableIO
 * @property {(url: string, ranges: Array<{start: number, end: number}>) => Promise<Uint8Array[]>} fetchRanges -
 *   Uncached read of several half-open ranges of one file, one result per range, in order
 * @property {(url: string, start: number, end: number) => Promise<Uint8Array | undefined>} cacheGet -
 *   Range cache lookup
 * @property {(url: string, start: number, end: number, bytes: Uint8Array) => Promise<void>} cacheSet -
 *   Range cache store
 * @property {number} [coalesceGap] - Merge row ranges this many bytes apart
 * @property {number} [maxRangeBytes] - Largest merged request
 */
