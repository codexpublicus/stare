/**
 * EIDX index file parser for RoaringBuckets (format v2 and v3).
 *
 * The EIDX format stores:
 * - String keys for searching
 * - Roaring bitmaps for set operations (AND/OR across dimensions)
 * - Embedded (blob_id, offset, length) tuples for direct byte-range access, except in
 *   datasets with a location table, whose entries have none (refs is empty)
 */

import { compareKeys, foldKey } from './keys.js';
import { decodeRoaring } from './roaring.js';
import { INDEX_ENTRY_SIZES, INDEX_HEADER_SIZE, INDEX_MAGIC, IndexFlags } from './types.js';
import { decodeRefs } from './varint.js';

/**
 * Index reader for EIDX v2 and v3 format files.
 *
 * The versions differ only in the entry table: v2 records are 18 bytes with
 * u16 bitmapLength and refsCount, v3 records are 22 bytes with u32 for both.
 */
export class IndexReader {
  /** @type {Uint8Array} */
  #data;
  /** @type {DataView} */
  #view;
  /** @type {Object} */
  #header;
  /** @type {Array<{stringOffset: number, stringLength: number, bitmapOffset: number, bitmapLength: number, refsOffset: number, refsCount: number}>} */
  #entryRecords;
  /** @type {TextDecoder} */
  #textDecoder;

  /**
   * @param {Uint8Array} data - Raw EIDX file bytes
   */
  constructor(data) {
    this.#data = data;
    this.#view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    this.#textDecoder = new TextDecoder('utf-8');
    this.#header = this.#parseHeader();
    this.#entryRecords = this.#parseEntryTable();
  }

  /**
   * Load an index from a URL.
   *
   * @param {string} url - URL of the .eidx file
   * @param {typeof globalThis.fetch} [fetchFn] - Optional custom fetch function
   * @returns {Promise<IndexReader>} IndexReader instance
   */
  static async load(url, fetchFn) {
    const response = fetchFn ? await fetchFn(url) : await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to load index: ${response.status} ${response.statusText}`);
    }

    const buffer = await response.arrayBuffer();
    return new IndexReader(new Uint8Array(buffer));
  }

  /**
   * Create an IndexReader from raw bytes.
   *
   * @param {Uint8Array} data - Raw EIDX file bytes
   * @returns {IndexReader} IndexReader instance
   */
  static fromBytes(data) {
    return new IndexReader(data);
  }

  /**
   * Get the index header information.
   *
   * @returns {Object} Header info
   */
  getHeader() {
    return this.#header;
  }

  /**
   * Get the number of entries in this index.
   *
   * @returns {number}
   */
  get entryCount() {
    return this.#header.entryCount;
  }

  /**
   * Check if the index is case-insensitive.
   *
   * @returns {boolean}
   */
  get isCaseInsensitive() {
    return (this.#header.flags & IndexFlags.CASE_INSENSITIVE) !== 0;
  }

  /**
   * Parse the EIDX header.
   *
   * @returns {Object} Parsed header
   */
  #parseHeader() {
    if (this.#data.length < INDEX_HEADER_SIZE) {
      throw new Error(`Index file too small: ${this.#data.length} bytes`);
    }

    // Read magic bytes
    const magic = this.#textDecoder.decode(this.#data.slice(0, 4));
    if (magic !== INDEX_MAGIC) {
      throw new Error(`Invalid index magic: ${magic}`);
    }

    const version = this.#view.getUint16(4, true);
    if (!Object.hasOwn(INDEX_ENTRY_SIZES, version)) {
      const supported = Object.keys(INDEX_ENTRY_SIZES).join(', ');
      throw new Error(`Unsupported index version: ${version}. Expected one of ${supported}.`);
    }

    return {
      magic,
      version,
      flags: this.#view.getUint16(6, true),
      entryCount: this.#view.getUint32(8, true),
      stringSectionOffset: this.#view.getUint32(12, true),
      bitmapSectionOffset: this.#view.getUint32(16, true),
      refsSectionOffset: this.#view.getUint32(20, true),
    };
  }

  /**
   * Parse the entry table.
   *
   * @returns {Array<Object>} Entry records
   */
  #parseEntryTable() {
    const records = [];
    const view = this.#view;
    const entrySize = INDEX_ENTRY_SIZES[this.#header.version];
    const tableEnd = INDEX_HEADER_SIZE + entrySize * this.#header.entryCount;
    if (this.#data.length < tableEnd) {
      throw new Error(`Index file truncated: entry table needs ${tableEnd} bytes`);
    }
    let offset = INDEX_HEADER_SIZE;

    if (this.#header.version === 2) {
      for (let i = 0; i < this.#header.entryCount; i++) {
        records.push({
          stringOffset: view.getUint32(offset, true),
          stringLength: view.getUint16(offset + 4, true),
          bitmapOffset: view.getUint32(offset + 6, true),
          bitmapLength: view.getUint16(offset + 10, true),
          refsOffset: view.getUint32(offset + 12, true),
          refsCount: view.getUint16(offset + 16, true),
        });
        offset += entrySize;
      }
    } else {
      for (let i = 0; i < this.#header.entryCount; i++) {
        records.push({
          stringOffset: view.getUint32(offset, true),
          stringLength: view.getUint16(offset + 4, true),
          bitmapOffset: view.getUint32(offset + 6, true),
          bitmapLength: view.getUint32(offset + 10, true),
          refsOffset: view.getUint32(offset + 14, true),
          refsCount: view.getUint32(offset + 18, true),
        });
        offset += entrySize;
      }
    }

    return records;
  }

  /**
   * Get the key string for an entry by index.
   *
   * @param {number} index - Entry index
   * @returns {string} Key string
   */
  #getKey(index) {
    const record = this.#entryRecords[index];
    const start = this.#header.stringSectionOffset + record.stringOffset;
    const end = start + record.stringLength;
    return this.#textDecoder.decode(this.#data.slice(start, end));
  }

  /**
   * Get the bitmap bytes for an entry by index.
   *
   * @param {number} index - Entry index
   * @returns {Uint8Array} Bitmap bytes
   */
  #getBitmapBytes(index) {
    const record = this.#entryRecords[index];
    const start = this.#header.bitmapSectionOffset + record.bitmapOffset;
    const end = start + record.bitmapLength;
    return this.#data.slice(start, end);
  }

  /**
   * Get the refs for an entry by index.
   *
   * @param {number} index - Entry index
   * @returns {Array<{blobId: number, offset: number, length: number}>} Refs
   */
  #getRefs(index) {
    const record = this.#entryRecords[index];
    const start = this.#header.refsSectionOffset + record.refsOffset;

    // Find the end by looking at the next entry or section end
    let end;
    if (index + 1 < this.#entryRecords.length) {
      end = this.#header.refsSectionOffset + this.#entryRecords[index + 1].refsOffset;
    } else {
      end = this.#data.length;
    }

    const refsData = this.#data.slice(start, end);
    const decoded = decodeRefs(refsData, record.refsCount);

    return decoded.map((r) => ({
      blobId: r.blobId,
      offset: r.offset,
      length: r.length,
    }));
  }

  /**
   * Get a full IndexEntry by index.
   *
   * @param {number} index - Entry index
   * @returns {{key: string, bitmapBytes: Uint8Array, refs: Array<{blobId: number, offset: number, length: number}>}} Index entry
   */
  getEntry(index) {
    if (index < 0 || index >= this.#entryRecords.length) {
      throw new Error(`Entry index out of bounds: ${index}`);
    }

    return {
      key: this.#getKey(index),
      bitmapBytes: this.#getBitmapBytes(index),
      refs: this.#getRefs(index),
    };
  }

  /**
   * Get all entries in the index.
   *
   * @returns {Array<{key: string, bitmapBytes: Uint8Array, refs: Array}>} All entries
   */
  getAllEntries() {
    const entries = [];
    for (let i = 0; i < this.#entryRecords.length; i++) {
      entries.push(this.getEntry(i));
    }
    return entries;
  }

  /**
   * Fold a key for comparison if this index is case-insensitive; see keys.js.
   *
   * @param {string} key
   * @returns {string}
   */
  #compareForm(key) {
    return this.isCaseInsensitive ? foldKey(key) : key;
  }

  /**
   * Find the first entry whose folded key is not less than `folded`, in code point order.
   *
   * The writer sorts every index, case-insensitive or not, by folded key in code point
   * order, so this is the one ordering a binary search over the entries can rely on.
   *
   * @param {string} folded - A folded key
   * @returns {number} Entry position, or entryCount if every key is less
   */
  #lowerBound(folded) {
    let low = 0;
    let high = this.#entryRecords.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (compareKeys(foldKey(this.#getKey(mid)), folded) < 0) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    return low;
  }

  /**
   * Search for exact key matches (case-insensitive if flag set).
   * Returns all case variants when case-insensitive.
   *
   * @param {string} key - Exact key to search for
   * @returns {Array<{key: string, bitmapBytes: Uint8Array, refs: Array}>} Matching entries (empty if none)
   */
  searchExact(key) {
    const folded = foldKey(key);
    const searchKey = this.#compareForm(key);
    const results = [];

    for (let i = this.#lowerBound(folded); i < this.#entryRecords.length; i++) {
      const entryKey = this.#getKey(i);
      if (foldKey(entryKey) !== folded) break;
      if (this.#compareForm(entryKey) === searchKey) results.push(this.getEntry(i));
    }

    return results;
  }

  /**
   * Search for entries matching a prefix.
   *
   * @param {string} prefix - Prefix to search for
   * @returns {Array<{key: string, bitmapBytes: Uint8Array, refs: Array}>} Matching entries
   */
  searchPrefix(prefix) {
    const folded = foldKey(prefix);
    const searchPrefix = this.#compareForm(prefix);
    const results = [];

    for (let i = this.#lowerBound(folded); i < this.#entryRecords.length; i++) {
      const entryKey = this.#getKey(i);
      if (!foldKey(entryKey).startsWith(folded)) break;
      if (this.#compareForm(entryKey).startsWith(searchPrefix)) results.push(this.getEntry(i));
    }

    return results;
  }

  /**
   * Search for entries containing a substring.
   *
   * @param {string} substring - Substring to search for
   * @param {number} [limit=100] - Maximum number of results
   * @returns {Array<{key: string, bitmapBytes: Uint8Array, refs: Array}>} Matching entries
   */
  searchContains(substring, limit = 100) {
    const searchStr = this.#compareForm(substring);
    const results = [];

    for (let i = 0; i < this.#entryRecords.length && results.length < limit; i++) {
      const entryKey = this.#getKey(i);
      const compareKey = this.#compareForm(entryKey);

      if (compareKey.includes(searchStr)) {
        results.push(this.getEntry(i));
      }
    }

    return results;
  }

  /**
   * Search with relevance scoring.
   * Returns results ranked: exact > prefix > contains.
   *
   * @param {string} query - Search query
   * @param {number} [limit=100] - Maximum number of results
   * @returns {Array<{entry: Object, relevance: 'exact'|'prefix'|'contains'}>} Results with relevance
   */
  search(query, limit = 100) {
    const searchQuery = this.#compareForm(query);
    const exact = [];
    const prefix = [];
    const contains = [];

    for (let i = 0; i < this.#entryRecords.length; i++) {
      const entryKey = this.#getKey(i);
      const compareKey = this.#compareForm(entryKey);

      if (compareKey === searchQuery) {
        exact.push({ entry: this.getEntry(i), relevance: 'exact' });
      } else if (compareKey.startsWith(searchQuery)) {
        prefix.push({ entry: this.getEntry(i), relevance: 'prefix' });
      } else if (compareKey.includes(searchQuery)) {
        contains.push({ entry: this.getEntry(i), relevance: 'contains' });
      }

      // Early exit if we have enough exact/prefix matches
      if (exact.length + prefix.length >= limit) {
        break;
      }
    }

    // Combine results respecting limit
    const results = [...exact, ...prefix, ...contains];
    return results.slice(0, limit);
  }

  /**
   * Decode the blob IDs from an entry's bitmap.
   *
   * @param {{bitmapBytes: Uint8Array}} entry - IndexEntry with bitmapBytes
   * @returns {number[]} Array of blob IDs
   */
  decodeBlobIds(entry) {
    return decodeRoaring(entry.bitmapBytes);
  }
}
