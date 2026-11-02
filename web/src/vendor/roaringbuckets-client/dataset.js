/**
 * High-level Dataset API for RoaringBuckets.
 *
 * Provides a unified interface for:
 * - Loading manifests
 * - Searching dimensions
 * - Multi-dimension queries with bitmap operations
 * - Blob access with optional partial loading
 */

import { BlobReader } from './blob-reader.js';
import { IndexReader } from './index-reader.js';
import { loadManifest, parseBounds, parseShardList } from './manifest.js';
import { decodeRoaring, intersect, union } from './roaring.js';
import { ShardedIndexReader } from './sharded-index-reader.js';

/**
 * High-level API for querying RoaringBuckets datasets.
 */
export class Dataset {
  /** @type {string} */
  #baseUrl;
  /** @type {Object} */
  #manifest;
  /** @type {typeof globalThis.fetch | undefined} */
  #fetchFn;
  /** @type {BlobReader} */
  #blobReader;

  // Index loads, by dimension. Each holds the promise, not the finished reader, so
  // concurrent calls share one fetch; a rejected promise is removed so the next call retries.
  /** @type {Map<string, Promise<IndexReader | ShardedIndexReader>>} */
  #indexCache = new Map();

  // Shard loads, by dimension and then shard key. Nested so no dimension name and shard key
  // can combine into another pair's cache key.
  /** @type {Map<string, Map<string, Promise<IndexReader>>>} */
  #shardCache = new Map();

  // Shard lists, by dimension: from the manifest, or fetched from the index's directory file.
  /** @type {Map<string, Promise<ShardList>>} */
  #shardListCache = new Map();

  /**
   * @param {string} baseUrl - Base URL of the dataset
   * @param {Object} manifest - Parsed manifest
   * @param {typeof globalThis.fetch} [fetchFn] - Optional custom fetch function
   * @param {import('./blob-reader.js').BlobReaderOptions} [options] - Blob range request options
   */
  constructor(baseUrl, manifest, fetchFn, options) {
    this.#baseUrl = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
    this.#manifest = manifest;
    this.#fetchFn = fetchFn;
    this.#blobReader = new BlobReader(this.#baseUrl, manifest.blobs, fetchFn, options);
  }

  /**
   * Load a dataset from a URL.
   *
   * @param {string} baseUrl - Base URL of the dataset (directory containing manifest.json)
   * @param {{fetch?: typeof globalThis.fetch} & import('./blob-reader.js').BlobReaderOptions} [options] -
   *   Optional configuration: a custom fetch function plus the BlobReader range options
   * @returns {Promise<Dataset>} Dataset instance
   */
  static async load(baseUrl, options) {
    const { fetch: fetchFn, ...blobOptions } = options ?? {};
    const manifest = await loadManifest(baseUrl, fetchFn);
    return new Dataset(baseUrl, manifest, fetchFn, blobOptions);
  }

  /**
   * Get the loaded manifest.
   *
   * @returns {Object} Manifest object
   */
  getManifest() {
    return this.#manifest;
  }

  /**
   * Get the names of all dimensions in this dataset.
   *
   * @returns {string[]} Dimension names
   */
  getDimensionNames() {
    return Object.keys(this.#manifest.dimensions);
  }

  /**
   * Get information about a dimension.
   *
   * @param {string} name - Dimension name
   * @returns {Object|undefined} Dimension config or undefined if not found
   */
  getDimension(name) {
    return this.#manifest.dimensions[name];
  }

  /**
   * Get information about an index.
   *
   * @param {string} name - Index name (usually same as dimension name)
   * @returns {Object|undefined} Index config or undefined if not found
   */
  getIndex(name) {
    return this.#manifest.indexes[name];
  }

  /**
   * Load an index for a dimension.
   *
   * For a sharded index this returns a ShardedIndexReader, which fetches shards lazily as
   * lookups need them. Its search methods are async; IndexReader's are sync. Both can be
   * awaited the same way.
   *
   * @param {string} dimension - Dimension name
   * @returns {Promise<IndexReader | ShardedIndexReader>} Index reader
   */
  loadIndex(dimension) {
    return cachedLoad(this.#indexCache, dimension, () => this.#fetchIndex(dimension));
  }

  /**
   * Build a dimension's index reader, fetching the index file if it is not sharded.
   *
   * @param {string} dimension - Dimension name
   * @returns {Promise<IndexReader | ShardedIndexReader>} Index reader
   */
  async #fetchIndex(dimension) {
    const indexConfig = this.#manifest.indexes[dimension];
    if (!indexConfig) {
      throw new Error(`Unknown dimension: ${dimension}`);
    }

    if (indexConfig.sharded) {
      const { shards, bounds } = await this.loadShardList(dimension);
      return new ShardedIndexReader({
        shards,
        bounds,
        shardDepth: indexConfig.shard_depth,
        totalEntries: indexConfig.total_entries,
        loadShard: (shard) => this.loadIndexShard(dimension, shard),
      });
    }
    const url = `${this.#baseUrl}/${indexConfig.file}`;
    return IndexReader.load(url, this.#fetchFn);
  }

  /**
   * Get a sharded index's shard list: the shards in order and where each one's file is.
   *
   * The list is in the manifest, or (manifest version 4) in a file named by the index's
   * `directory`, fetched once on first use. A prefix-sharded index's shards are its key
   * prefixes, with files in `shard_files`. A range-partitioned index's shards are
   * numbered from "0", with files at the index's `pattern`, and `bounds` holds the lowest
   * folded key each can hold.
   *
   * @param {string} dimension - Dimension name
   * @returns {Promise<ShardList>}
   */
  loadShardList(dimension) {
    return cachedLoad(this.#shardListCache, dimension, () => this.#fetchShardList(dimension));
  }

  /**
   * Read a sharded index's shard list from the manifest or its directory file.
   *
   * @param {string} dimension - Dimension name
   * @returns {Promise<ShardList>}
   */
  async #fetchShardList(dimension) {
    const indexConfig = this.#manifest.indexes[dimension];
    if (!indexConfig) {
      throw new Error(`Unknown dimension: ${dimension}`);
    }
    if (!indexConfig.sharded) {
      throw new Error(`Index ${dimension} is not sharded`);
    }
    if (!indexConfig.directory) {
      return rangeAware({
        shards: indexConfig.shards,
        shard_files: indexConfig.shard_files,
        bounds: indexConfig.bounds,
      });
    }
    const url = `${this.#baseUrl}/${indexConfig.directory}`;
    const response = this.#fetchFn ? await this.#fetchFn(url) : await fetch(url);
    if (!response.ok) {
      throw new Error(
        `Failed to load shard list ${indexConfig.directory}: ${response.status} ${response.statusText}`
      );
    }
    const raw = await response.json();
    const listing =
      indexConfig.partition === 'range'
        ? rangeAware({ shards: [], shard_files: null, bounds: parseBounds(dimension, raw) })
        : { ...parseShardList(dimension, raw), bounds: null };
    if (listing.shards.length !== indexConfig.shard_count) {
      throw new Error(
        `Index ${dimension} shard list ${indexConfig.directory} has ${listing.shards.length} ` +
          `shards; the manifest says ${indexConfig.shard_count}`
      );
    }
    return listing;
  }

  /**
   * Load a specific shard of a sharded index.
   *
   * @param {string} dimension - Dimension name
   * @param {string} shard - Shard prefix (e.g., "a", "ab")
   * @returns {Promise<IndexReader>} IndexReader instance
   */
  loadIndexShard(dimension, shard) {
    let shards = this.#shardCache.get(dimension);
    if (!shards) {
      shards = new Map();
      this.#shardCache.set(dimension, shards);
    }
    return cachedLoad(shards, shard, () => this.#fetchIndexShard(dimension, shard));
  }

  /**
   * Fetch one shard of a sharded index.
   *
   * @param {string} dimension - Dimension name
   * @param {string} shard - Shard prefix
   * @returns {Promise<IndexReader>} IndexReader instance
   */
  async #fetchIndexShard(dimension, shard) {
    const indexConfig = this.#manifest.indexes[dimension];
    if (!indexConfig) {
      throw new Error(`Unknown dimension: ${dimension}`);
    }

    if (!indexConfig.sharded) {
      throw new Error(`Index ${dimension} is not sharded`);
    }

    // The writer lists each shard's file, with path-unsafe characters already encoded.
    // Manifests without shard_files predate that encoding and named files by the raw shard.
    const { shards, shard_files: shardFiles, bounds } = await this.loadShardList(dimension);
    let path;
    if (bounds) {
      // Range shards are numbered; their files are at the pattern.
      if (!/^(0|[1-9][0-9]*)$/.test(shard) || Number(shard) >= shards.length) {
        throw new Error(`Index ${dimension} has no shard: ${shard}`);
      }
      path = indexConfig.pattern.replace('{shard}', shard);
    } else if (shardFiles) {
      path = Object.hasOwn(shardFiles, shard) ? shardFiles[shard] : undefined;
      if (path === undefined) {
        throw new Error(`Index ${dimension} has no file for shard: ${shard}`);
      }
    } else {
      path = indexConfig.pattern.replace('{shard}', shard);
    }
    const url = `${this.#baseUrl}/${path}`;

    return IndexReader.load(url, this.#fetchFn);
  }

  /**
   * Search a dimension for exact key matches.
   * Returns all case variants when index is case-insensitive.
   *
   * @param {string} dimension - Dimension name
   * @param {string} key - Exact key to search for
   * @returns {Promise<Array<Object>>} Array of matching IndexEntries (empty if none)
   */
  async searchExact(dimension, key) {
    const index = await this.loadIndex(dimension);
    return index.searchExact(key);
  }

  /**
   * Search a dimension with relevance scoring.
   *
   * @param {string} dimension - Dimension name
   * @param {string} query - Search query
   * @param {number} [limit=100] - Maximum results
   * @returns {Promise<Array<{entry: Object, relevance: string}>>} Array of SearchResult with relevance
   */
  async search(dimension, query, limit = 100) {
    const index = await this.loadIndex(dimension);
    return index.search(query, limit);
  }

  /**
   * Search a dimension for prefix matches.
   *
   * @param {string} dimension - Dimension name
   * @param {string} prefix - Prefix to search for
   * @returns {Promise<Array<Object>>} Array of matching entries
   */
  async searchPrefix(dimension, prefix) {
    const index = await this.loadIndex(dimension);
    return index.searchPrefix(prefix);
  }

  /**
   * Query across multiple dimensions with AND semantics.
   * Returns blob IDs that match ALL filters.
   * Case variants within a dimension are unioned (OR), then intersected across dimensions (AND).
   *
   * @param {Record<string, string>} filters - Map of dimension name to exact key value
   * @returns {Promise<{entries: Map<string, Array<Object>>, matchingBlobIds: number[], totalMatches: number}>} QueryResult
   */
  async query(filters) {
    const entries = new Map();
    const blobIdSets = [];

    for (const [dimension, key] of Object.entries(filters)) {
      const matchingEntries = await this.searchExact(dimension, key);
      if (matchingEntries.length === 0) {
        // No match for this filter means empty result
        return {
          entries,
          matchingBlobIds: [],
          totalMatches: 0,
        };
      }

      entries.set(dimension, matchingEntries);

      // Union bitmaps from all case variants within this dimension
      let dimensionBlobIds = decodeRoaring(matchingEntries[0].bitmapBytes);
      for (let i = 1; i < matchingEntries.length; i++) {
        dimensionBlobIds = union(dimensionBlobIds, decodeRoaring(matchingEntries[i].bitmapBytes));
      }
      blobIdSets.push(dimensionBlobIds);
    }

    // Intersect all blob ID sets across dimensions
    let matchingBlobIds = blobIdSets[0] ?? [];
    for (let i = 1; i < blobIdSets.length; i++) {
      matchingBlobIds = intersect(matchingBlobIds, blobIdSets[i]);
    }

    return {
      entries,
      matchingBlobIds,
      totalMatches: matchingBlobIds.length,
    };
  }

  /**
   * Query with OR semantics within dimension, AND across dimensions.
   * Case variants are also unioned within each dimension.
   *
   * @param {Record<string, string[]>} filters - Map of dimension name to array of values (OR within dimension)
   * @returns {Promise<{entries: Map<string, Array<Object>>, matchingBlobIds: number[], totalMatches: number}>} QueryResult
   */
  async queryMultiValue(filters) {
    const entries = new Map();
    const dimensionBlobIds = [];

    for (const [dimension, keys] of Object.entries(filters)) {
      const dimensionEntries = [];
      const keyBlobIdSets = [];

      for (const key of keys) {
        const matchingEntries = await this.searchExact(dimension, key);
        for (const entry of matchingEntries) {
          dimensionEntries.push(entry);
          keyBlobIdSets.push(decodeRoaring(entry.bitmapBytes));
        }
      }

      if (keyBlobIdSets.length === 0) {
        // No matches in this dimension
        return {
          entries,
          matchingBlobIds: [],
          totalMatches: 0,
        };
      }

      // Union within dimension (OR across all keys and their case variants)
      let dimensionUnion = keyBlobIdSets[0];
      for (let i = 1; i < keyBlobIdSets.length; i++) {
        dimensionUnion = union(dimensionUnion, keyBlobIdSets[i]);
      }
      dimensionBlobIds.push(dimensionUnion);

      // Store all entries for the dimension
      entries.set(dimension, dimensionEntries);
    }

    // Intersect across dimensions (AND)
    let matchingBlobIds = dimensionBlobIds[0] ?? [];
    for (let i = 1; i < dimensionBlobIds.length; i++) {
      matchingBlobIds = intersect(matchingBlobIds, dimensionBlobIds[i]);
    }

    return {
      entries,
      matchingBlobIds,
      totalMatches: matchingBlobIds.length,
    };
  }

  /**
   * Intersect blob IDs from multiple index entries.
   *
   * @param {Array<{bitmapBytes: Uint8Array}>} entries - Array of IndexEntry objects
   * @returns {number[]} Array of blob IDs present in all entries
   */
  intersectEntries(entries) {
    if (entries.length === 0) return [];

    let result = decodeRoaring(entries[0].bitmapBytes);
    for (let i = 1; i < entries.length; i++) {
      const blobIds = decodeRoaring(entries[i].bitmapBytes);
      result = intersect(result, blobIds);
    }
    return result;
  }

  /**
   * Union blob IDs from multiple index entries.
   *
   * @param {Array<{bitmapBytes: Uint8Array}>} entries - Array of IndexEntry objects
   * @returns {number[]} Array of blob IDs present in any entry
   */
  unionEntries(entries) {
    if (entries.length === 0) return [];

    let result = decodeRoaring(entries[0].bitmapBytes);
    for (let i = 1; i < entries.length; i++) {
      const blobIds = decodeRoaring(entries[i].bitmapBytes);
      result = union(result, blobIds);
    }
    return result;
  }

  /**
   * Get a blob by its reference.
   *
   * @param {{blobId: number, offset: number, length: number}} ref - BlobRef from an index entry
   * @param {{subOffset?: number, subLength?: number}} [options] - Optional partial loading options
   * @returns {Promise<Uint8Array>} Blob data
   */
  async getBlob(ref, options) {
    return this.#blobReader.getBlobRange(ref, options);
  }

  /**
   * Get multiple blobs by their references.
   *
   * Nearby byte ranges are merged into single requests; see BlobReader.getBlobs.
   *
   * @param {Array<{blobId: number, offset: number, length: number}>} refs - Array of BlobRefs
   * @returns {Promise<Map<number, Uint8Array>>} Map of blob_id to blob data, in the order of `refs`
   */
  async getBlobs(refs) {
    return this.#blobReader.getBlobs(refs);
  }

  /**
   * Whether the dataset has a location table. With one, index entries carry only their
   * bitmap (`refs` is empty) and blob ids resolve through the table.
   *
   * @returns {boolean}
   */
  get hasLocationTable() {
    return this.#blobReader.hasLocationTable;
  }

  /**
   * Resolve blob ids to refs.
   *
   * With a location table, this reads the ids' rows from it and `entries` is ignored.
   * Without one, it looks the ids up in the refs of `entries`, which must be the index
   * entries the ids came from.
   *
   * @param {number[]} blobIds - Blob ids, from index bitmaps
   * @param {Array<{refs: Array<{blobId: number, offset: number, length: number}>}>} [entries] -
   *   Index entries holding the refs, for datasets without a location table
   * @returns {Promise<Array<{blobId: number, file?: number, offset: number, length: number} | null>>}
   *   One ref per id, in order; null for an id that couldn't be resolved
   */
  async resolveBlobIds(blobIds, entries = []) {
    if (this.#blobReader.hasLocationTable) {
      return this.#blobReader.resolveBlobIds(blobIds);
    }
    const byId = new Map();
    for (const entry of entries) {
      for (const ref of entry.refs) {
        if (!byId.has(ref.blobId)) byId.set(ref.blobId, ref);
      }
    }
    return blobIds.map((blobId) => byId.get(blobId) ?? null);
  }

  /**
   * Fetch blobs by id through the location table.
   *
   * @param {number[]} blobIds - Blob ids, from index bitmaps or a query result
   * @returns {Promise<Map<number, Uint8Array>>} Map of blob_id to blob data, in the order of `blobIds`
   */
  async getBlobsById(blobIds) {
    return this.#blobReader.getBlobsById(blobIds);
  }

  /**
   * Get a blob by its ID from a query result.
   *
   * @param {number} blobId - Blob ID from a query result
   * @param {{refs: Array<{blobId: number, offset: number, length: number}>}} [entry] - IndexEntry
   *   the ID came from; needed only for datasets without a location table
   * @param {{subOffset?: number, subLength?: number}} [options] - Optional partial loading options
   * @returns {Promise<Uint8Array|null>} Blob data or null if not found
   */
  async getBlobById(blobId, entry, options) {
    const [ref] = await this.resolveBlobIds([blobId], entry ? [entry] : []);
    if (!ref) return null;
    return this.#blobReader.getBlobRange(ref, options);
  }

  /**
   * Get all blobs matching query filters.
   * Convenience method that combines query + blob fetching.
   *
   * @param {Record<string, string>} filters - Query filters
   * @returns {Promise<Map<number, Uint8Array>>} Map of blob_id to blob data
   */
  async queryAndFetchBlobs(filters) {
    const result = await this.query(filters);
    if (result.matchingBlobIds.length === 0) {
      return new Map();
    }

    if (this.#blobReader.hasLocationTable) {
      return this.getBlobsById(result.matchingBlobIds);
    }

    // Get refs from entries that match the blob IDs
    const refsToFetch = [];
    const matchingSet = new Set(result.matchingBlobIds);

    for (const entry of [...result.entries.values()].flat()) {
      for (const ref of entry.refs) {
        if (matchingSet.has(ref.blobId)) {
          refsToFetch.push(ref);
          matchingSet.delete(ref.blobId); // Avoid duplicates
        }
      }
    }

    return this.getBlobs(refsToFetch);
  }

  /**
   * Get the underlying BlobReader for advanced use cases.
   *
   * @returns {BlobReader}
   */
  getBlobReader() {
    return this.#blobReader;
  }

  /**
   * Clear the index cache.
   */
  clearCache() {
    this.#indexCache.clear();
    this.#shardCache.clear();
    this.#shardListCache.clear();
  }
}

/**
 * A sharded index's shard list.
 *
 * @typedef {Object} ShardList
 * @property {string[]} shards - Shard names in order: key prefixes, or "0", "1", ... for range shards
 * @property {Record<string, string> | null} shard_files - Prefix to file path (prefix shards)
 * @property {string[] | null} bounds - Each shard's lowest folded key (range shards)
 */

/**
 * Fill in a range-partitioned list's shard names, "0" to "n-1", from its bounds.
 *
 * @param {ShardList} listing
 * @returns {ShardList}
 */
function rangeAware(listing) {
  if (!listing.bounds) return listing;
  return { ...listing, shards: listing.bounds.map((_, i) => String(i)) };
}

/**
 * Get `key`'s promise from `cache`, starting `load` and caching its promise if there is none.
 * A promise that rejects is removed (if it is still the cached one), so a later call retries.
 *
 * @template T
 * @param {Map<string, Promise<T>>} cache
 * @param {string} key
 * @param {() => Promise<T>} load
 * @returns {Promise<T>}
 */
function cachedLoad(cache, key, load) {
  const cached = cache.get(key);
  if (cached) return cached;
  const promise = load();
  cache.set(key, promise);
  promise.catch(() => {
    if (cache.get(key) === promise) cache.delete(key);
  });
  return promise;
}
