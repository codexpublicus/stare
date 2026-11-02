/**
 * Reader for prefix-sharded indexes.
 *
 * The Python writer (`IndexWriter._write_sharded`) splits a sharded dimension into one EIDX
 * file per key prefix: the first `shard_depth` code points of the key, ASCII-folded (the
 * whole key when it is shorter than that); see `shardPrefix` in keys.js. The manifest lists
 * the prefixes in sorted order, and its `shard_files` map gives each prefix's file path,
 * with characters that are unsafe in a file name or URL already encoded (see "Shard file
 * names" in docs/FORMAT_V2.md). Older manifests have no `shard_files`; their files live at
 * `pattern` with `{shard}` replaced by the raw prefix. Within a shard, entries are sorted by
 * folded key, so reading shards in manifest order yields entries in the same global order
 * an unsharded index would have.
 *
 * A range-partitioned index (manifest version 4, `partition: "range"`) has numbered shards,
 * "0" to "n-1", each holding consecutive keys in folded key order, cut by size. `bounds[i]`
 * is the lowest folded key shard i can hold, so a key is in the last shard whose bound is
 * at or below its folded form.
 */

import { codePointLength, compareKeys, foldKey, shardPrefix } from './keys.js';
import { decodeRoaring } from './roaring.js';

/** Relevance ranks used to merge `search` results across shards. */
const RELEVANCE_ORDER = { exact: 0, prefix: 1, contains: 2 };

/**
 * Index reader for a sharded dimension. Loads shards lazily, on first use.
 *
 * Mirrors the search methods of IndexReader, but every lookup is async because it may
 * need to fetch a shard first.
 */
export class ShardedIndexReader {
  /** @type {string[]} */
  #shards;
  /** @type {Set<string>} */
  #shardSet;
  /** @type {number} */
  #shardDepth;
  /** @type {number} */
  #totalEntries;
  /** @type {(shard: string) => Promise<import('./index-reader.js').IndexReader>} */
  #loadShard;
  /** @type {string[] | null} */
  #bounds;

  /**
   * @param {{shards?: string[], shardDepth?: number, bounds?: string[] | null,
   *   totalEntries?: number,
   *   loadShard: (shard: string) => Promise<import('./index-reader.js').IndexReader>}} options -
   *   For a prefix-sharded index, the shard prefixes in manifest order and the prefix
   *   length; for a range-partitioned one, `bounds` (each shard's lowest folded key, the
   *   first ""), which names the shards "0" to "n-1". Also the total entry count and a
   *   function that loads (and caches) one shard's IndexReader
   */
  constructor({ shards = [], shardDepth = 1, bounds = null, totalEntries = 0, loadShard }) {
    this.#bounds = bounds ? [...bounds] : null;
    this.#shards = this.#bounds ? this.#bounds.map((_, i) => String(i)) : [...shards];
    this.#shardSet = new Set(this.#shards);
    this.#shardDepth = shardDepth || 1;
    this.#totalEntries = totalEntries;
    this.#loadShard = loadShard;
  }

  /**
   * How the index is split: "prefix" or "range".
   *
   * @returns {'prefix' | 'range'}
   */
  get partition() {
    return this.#bounds ? 'range' : 'prefix';
  }

  /**
   * Each range shard's lowest folded key, or null for a prefix-sharded index.
   *
   * @returns {string[] | null}
   */
  get bounds() {
    return this.#bounds ? [...this.#bounds] : null;
  }

  /**
   * Number of the range shard a folded key falls in: the last whose bound is at or below
   * it. -1 when there are no shards.
   *
   * @param {string} folded - A folded key
   * @returns {number}
   */
  #rangeIndex(folded) {
    const bounds = /** @type {string[]} */ (this.#bounds);
    let low = 0;
    let high = bounds.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (compareKeys(bounds[mid], folded) <= 0) low = mid + 1;
      else high = mid;
    }
    return low - 1;
  }

  /**
   * Always true; lets callers tell this apart from an IndexReader.
   *
   * @returns {boolean}
   */
  get isSharded() {
    return true;
  }

  /**
   * Total number of entries across all shards, from the manifest.
   *
   * @returns {number}
   */
  get entryCount() {
    return this.#totalEntries;
  }

  /**
   * Shard names, in order: key prefixes, or "0" to "n-1" for range shards.
   *
   * @returns {string[]}
   */
  get shards() {
    return [...this.#shards];
  }

  /**
   * Number of key code points that make up a shard prefix.
   *
   * @returns {number}
   */
  get shardDepth() {
    return this.#shardDepth;
  }

  /**
   * Get the shard prefix a key belongs to, whether or not that shard exists.
   *
   * @param {string} key - Index key
   * @returns {string} Shard prefix
   */
  shardForKey(key) {
    if (this.#bounds) {
      const index = this.#rangeIndex(foldKey(key));
      return index >= 0 ? String(index) : '';
    }
    return shardPrefix(key, this.#shardDepth);
  }

  /**
   * Get the shards that can hold keys starting with a prefix, in order.
   *
   * Prefix shards: one shard when the prefix is at least `shardDepth` code points long,
   * otherwise every shard starting with it. Range shards: the shard the prefix falls in
   * and every later one whose bound starts with it (a bound above the prefix that doesn't
   * start with it is above every key that does).
   *
   * @param {string} prefix - Prefix to search for
   * @returns {string[]} Shard names
   */
  shardsForPrefix(prefix) {
    const folded = foldKey(prefix);
    if (this.#bounds) {
      const bounds = this.#bounds;
      const first = this.#rangeIndex(folded);
      if (first < 0) return [];
      let last = first;
      while (last + 1 < bounds.length && bounds[last + 1].startsWith(folded)) last++;
      return this.#shards.slice(first, last + 1);
    }
    if (codePointLength(prefix) >= this.#shardDepth) {
      const shard = this.shardForKey(prefix);
      return this.#shardSet.has(shard) ? [shard] : [];
    }
    return this.#shards.filter((s) => s.startsWith(folded));
  }

  /**
   * Load one shard's IndexReader.
   *
   * @param {string} shard - Shard prefix
   * @returns {Promise<import('./index-reader.js').IndexReader>}
   */
  async loadShard(shard) {
    if (!this.#shardSet.has(shard)) {
      throw new Error(`Unknown shard: ${shard}`);
    }
    return this.#loadShard(shard);
  }

  /**
   * Load several shards in parallel, keeping their order.
   *
   * @param {string[]} shards - Shard prefixes
   * @returns {Promise<Array<import('./index-reader.js').IndexReader>>}
   */
  #loadShards(shards) {
    return Promise.all(shards.map((shard) => this.#loadShard(shard)));
  }

  /**
   * Search for exact key matches. Loads at most one shard.
   *
   * @param {string} key - Exact key to search for
   * @returns {Promise<Array<{key: string, bitmapBytes: Uint8Array, refs: Array}>>} Matching entries
   */
  async searchExact(key) {
    const shard = this.shardForKey(key);
    if (!this.#shardSet.has(shard)) return [];
    const index = await this.#loadShard(shard);
    return index.searchExact(key);
  }

  /**
   * Search for entries matching a prefix.
   *
   * A prefix at least `shardDepth` code points long loads one shard; a shorter one loads
   * every shard that starts with it.
   *
   * @param {string} prefix - Prefix to search for
   * @returns {Promise<Array<{key: string, bitmapBytes: Uint8Array, refs: Array}>>} Matching entries
   */
  async searchPrefix(prefix) {
    const indexes = await this.#loadShards(this.shardsForPrefix(prefix));
    return indexes.flatMap((index) => index.searchPrefix(prefix));
  }

  /**
   * Search for entries containing a substring. Loads every shard.
   *
   * @param {string} substring - Substring to search for
   * @param {number} [limit=100] - Maximum number of results
   * @returns {Promise<Array<{key: string, bitmapBytes: Uint8Array, refs: Array}>>} Matching entries
   */
  async searchContains(substring, limit = 100) {
    const indexes = await this.#loadShards(this.#shards);
    return indexes.flatMap((index) => index.searchContains(substring, limit)).slice(0, limit);
  }

  /**
   * Search with relevance scoring (exact > prefix > contains). Loads every shard.
   *
   * @param {string} query - Search query
   * @param {number} [limit=100] - Maximum number of results
   * @returns {Promise<Array<{entry: Object, relevance: 'exact'|'prefix'|'contains'}>>} Results with relevance
   */
  async search(query, limit = 100) {
    const indexes = await this.#loadShards(this.#shards);
    const results = indexes.flatMap((index) => index.search(query, limit));
    // Stable sort: within a relevance tier, shard order then in-shard order is key order
    results.sort((a, b) => RELEVANCE_ORDER[a.relevance] - RELEVANCE_ORDER[b.relevance]);
    return results.slice(0, limit);
  }

  /**
   * Get every entry from every shard. Loads every shard.
   *
   * @returns {Promise<Array<{key: string, bitmapBytes: Uint8Array, refs: Array}>>} All entries
   */
  async getAllEntries() {
    const indexes = await this.#loadShards(this.#shards);
    return indexes.flatMap((index) => index.getAllEntries());
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
