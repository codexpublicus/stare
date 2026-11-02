/**
 * Blob reader for RoaringBuckets datasets.
 *
 * Supports loading blobs from single or sharded blob files,
 * with optional HTTP range requests for partial loading.
 *
 * A version 3 manifest lists the blob files in `blobs.files`. A ref's `file` field is an
 * index into that list. When the dataset has a location table (`blobs.locations`), blob ids
 * from index bitmaps resolve to refs through it; otherwise refs come from index entries and
 * all point into the one listed file.
 */

import { LocationTable } from './location-table.js';
import {
  coalesceRanges,
  DEFAULT_MAX_RANGES_PER_REQUEST,
  multiRangeHeader,
  multipartBoundary,
  parseContentRange,
  parseMultipartByteranges,
  rangeCacheKey,
} from './ranges.js';
import { BLOB_HEADER_SIZE, BLOB_MAGIC, BLOB_VERSION } from './types.js';

/**
 * Blob reader for accessing blob data from RoaringBuckets datasets.
 */
export class BlobReader {
  /** @type {string} */
  #baseUrl;
  /** @type {Object} */
  #config;
  /** @type {typeof globalThis.fetch | undefined} */
  #fetchFn;
  /** @type {number | undefined} */
  #coalesceGap;
  /** @type {number | undefined} */
  #maxRangeBytes;
  /** @type {RangeCache | undefined} */
  #cache;
  /** @type {number} */
  #maxRangesPerRequest;
  /**
   * False once the host has answered a multi-range request with the whole file; from
   * then on every range gets its own request.
   *
   * @type {boolean}
   */
  #multiRange = true;
  /** @type {LocationTable | null} */
  #table = null;

  // Cache for blob file headers (validate once per file)
  /** @type {Map<string, Object>} */
  #headerCache = new Map();

  /**
   * @param {string} baseUrl - Base URL of the dataset
   * @param {Object} config - Blobs configuration from manifest
   * @param {typeof globalThis.fetch} [fetchFn] - Optional custom fetch function
   * @param {BlobReaderOptions} [options] - Range request tuning
   */
  constructor(baseUrl, config, fetchFn, options) {
    this.#baseUrl = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
    this.#config = config;
    this.#fetchFn = fetchFn;
    this.#coalesceGap = options?.coalesceGap;
    this.#maxRangeBytes = options?.maxRangeBytes;
    this.#cache = options?.cache;
    const cap = options?.maxRangesPerRequest ?? DEFAULT_MAX_RANGES_PER_REQUEST;
    if (!Number.isInteger(cap) || cap < 1) {
      throw new Error(`maxRangesPerRequest must be a positive integer, not ${cap}`);
    }
    this.#maxRangesPerRequest = cap;

    if (config.locations) {
      this.#table = new LocationTable(
        `${this.#baseUrl}/${config.locations.file}`,
        { firstId: config.locations.first_id, count: config.locations.count },
        {
          fetchRanges: (url, ranges) => this.#fetchRanges(url, ranges),
          cacheGet: (url, start, end) => this.#cacheGet(url, start, end),
          cacheSet: (url, start, end, bytes) => this.#cacheSet(url, start, end, bytes),
          coalesceGap: this.#coalesceGap,
          maxRangeBytes: this.#maxRangeBytes,
        }
      );
    }
  }

  /**
   * Whether multi-range requests are still in use. False once the host has answered one
   * with the whole file (as S3 does), after which each range is requested on its own.
   *
   * @returns {boolean}
   */
  get multiRange() {
    return this.#multiRange;
  }

  /**
   * Whether the dataset has a location table, so blob ids resolve without index refs.
   *
   * @returns {boolean}
   */
  get hasLocationTable() {
    return this.#table !== null;
  }

  /**
   * The dataset's location table, or null if it has none.
   *
   * @returns {LocationTable | null}
   */
  getLocationTable() {
    return this.#table;
  }

  /**
   * Resolve blob ids to refs through the location table.
   *
   * @param {number[]} blobIds - Blob ids, from index bitmaps
   * @returns {Promise<Array<{blobId: number, file: number, offset: number, length: number} | null>>}
   *   One ref per id, in order; null for an id the table has no blob for
   */
  async resolveBlobIds(blobIds) {
    if (!this.#table) {
      throw new Error(
        'This dataset has no location table; blob refs come from index entries instead'
      );
    }
    return this.#table.lookup(blobIds);
  }

  /**
   * Fetch blobs by id, resolving them through the location table.
   *
   * Row reads and blob reads are both coalesced and sent as multi-range requests, so a
   * page of results costs one table request plus one request per blob file it touches.
   *
   * @param {number[]} blobIds - Blob ids, from index bitmaps
   * @returns {Promise<Map<number, Uint8Array>>} Map of blob id to blob data, in the order of `blobIds`
   */
  async getBlobsById(blobIds) {
    const refs = await this.resolveBlobIds(blobIds);
    const missing = blobIds.filter((_, i) => refs[i] === null);
    if (missing.length > 0) {
      throw new Error(`Location table has no blob for id(s): ${missing.slice(0, 10).join(', ')}`);
    }
    /** @type {Array<{blobId: number, file: number, offset: number, length: number}>} */
    const found = /** @type {any} */ (refs);
    return this.getBlobs(found);
  }

  /**
   * Look up bytes `[start, end)` of a file in the range cache.
   *
   * @param {string} url - File URL
   * @param {number} start - First byte (inclusive)
   * @param {number} end - Last byte (exclusive)
   * @returns {Promise<Uint8Array | undefined>} Cached bytes, or undefined on a miss or with no cache
   */
  async #cacheGet(url, start, end) {
    if (!this.#cache) return undefined;
    const hit = await this.#cache.get(rangeCacheKey(url, start, end));
    return hit ?? undefined;
  }

  /**
   * Store bytes `[start, end)` of a file in the range cache, if one is configured.
   *
   * @param {string} url - File URL
   * @param {number} start - First byte (inclusive)
   * @param {number} end - Last byte (exclusive)
   * @param {Uint8Array} bytes - The bytes of that range
   * @returns {Promise<void>}
   */
  async #cacheSet(url, start, end, bytes) {
    if (this.#cache) await this.#cache.set(rangeCacheKey(url, start, end), bytes);
  }

  /**
   * Fetch bytes `[start, end)` of a file, going through the range cache.
   *
   * @param {string} url - File URL
   * @param {number} start - First byte (inclusive)
   * @param {number} end - Last byte (exclusive)
   * @returns {Promise<Uint8Array>} The requested bytes
   */
  async #cachedRange(url, start, end) {
    const hit = await this.#cacheGet(url, start, end);
    if (hit) return hit;
    const bytes = await this.#fetchRange(url, start, end);
    await this.#cacheSet(url, start, end, bytes);
    return bytes;
  }

  /**
   * Fetch bytes `[start, end)` of a file with an HTTP range request.
   *
   * Falls back to slicing the full body when the server ignores the Range header.
   *
   * @param {string} url - File URL
   * @param {number} start - First byte (inclusive)
   * @param {number} end - Last byte (exclusive)
   * @returns {Promise<Uint8Array>} The requested bytes
   */
  async #fetchRange(url, start, end) {
    const init = { headers: { Range: `bytes=${start}-${end - 1}` } };
    const response = this.#fetchFn ? await this.#fetchFn(url, init) : await fetch(url, init);

    if (response.status === 206) {
      return new Uint8Array(await response.arrayBuffer());
    }
    if (response.ok) {
      // Server ignored the Range header and sent the whole file
      const full = new Uint8Array(await response.arrayBuffer());
      return full.slice(start, end);
    }
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }

  /**
   * Fetch several byte ranges of one file, as few requests as the host allows.
   *
   * Ranges go out in batches of at most `maxRangesPerRequest`, one multi-range request per
   * batch; a batch of one is a plain range request. Once the host has answered a
   * multi-range request with the whole file, every range is requested on its own.
   *
   * @param {string} url - File URL
   * @param {Array<{start: number, end: number}>} ranges - Half-open ranges, none empty
   * @returns {Promise<Uint8Array[]>} The bytes of each range, in the order given
   */
  async #fetchRanges(url, ranges) {
    /** @type {Uint8Array[]} */
    const out = new Array(ranges.length);
    const single = (i) =>
      this.#fetchRange(url, ranges[i].start, ranges[i].end).then((bytes) => {
        out[i] = bytes;
      });

    const indices = ranges.map((_, i) => i);
    if (!this.#multiRange) {
      await Promise.all(indices.map(single));
      return out;
    }

    const batches = [];
    for (let i = 0; i < indices.length; i += this.#maxRangesPerRequest) {
      batches.push(indices.slice(i, i + this.#maxRangesPerRequest));
    }
    await Promise.all(
      batches.map(async (batch) => {
        if (batch.length === 1 || !this.#multiRange) {
          await Promise.all(batch.map(single));
          return;
        }
        const got = await this.#fetchBatch(
          url,
          batch.map((i) => ranges[i])
        );
        const missed = [];
        batch.forEach((i, k) => {
          if (got[k]) out[i] = got[k];
          else missed.push(i);
        });
        await Promise.all(missed.map(single));
      })
    );
    return out;
  }

  /**
   * Send one multi-range request and take what it returns.
   *
   * A `206 multipart/byteranges` response is split into parts, and a `206` with one
   * `Content-Range` is a single part; each requested range is cut from whichever part
   * covers it, since servers may merge, reorder or drop ranges. A `200` means the host
   * ignores multiple ranges and is sending the whole file: the body is cancelled unread
   * and multi-range requests are switched off for this reader.
   *
   * @param {string} url - File URL
   * @param {Array<{start: number, end: number}>} ranges - Half-open ranges, two or more
   * @returns {Promise<Array<Uint8Array | undefined>>} Bytes per range, undefined for a
   *   range the response didn't cover
   */
  async #fetchBatch(url, ranges) {
    const init = { headers: { Range: multiRangeHeader(ranges) } };
    const response = this.#fetchFn ? await this.#fetchFn(url, init) : await fetch(url, init);

    if (response.status === 206) {
      const contentType = response.headers.get('Content-Type');
      /** @type {Array<{start: number, end: number, bytes: Uint8Array}>} */
      let parts;
      if (multipartBoundary(contentType)) {
        const body = new Uint8Array(await response.arrayBuffer());
        parts = parseMultipartByteranges(body, /** @type {string} */ (contentType));
      } else {
        // One range back. Without a readable Content-Range (it isn't CORS-safelisted)
        // there's no telling which bytes these are.
        const range = parseContentRange(response.headers.get('Content-Range'));
        if (!range) {
          await response.body?.cancel();
          return ranges.map(() => undefined);
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.length !== range.end - range.start) {
          throw new Error(
            `Short response from ${url}: Content-Range names ${range.end - range.start} bytes, got ${bytes.length}`
          );
        }
        parts = [{ start: range.start, end: range.end, bytes }];
      }
      return ranges.map((r) => {
        const part = parts.find((p) => p.start <= r.start && r.end <= p.end);
        return part?.bytes.slice(r.start - part.start, r.end - part.start);
      });
    }
    if (response.ok) {
      // The host ignored the ranges and is sending the whole file. Don't download it.
      await response.body?.cancel();
      this.#multiRange = false;
      return ranges.map(() => undefined);
    }
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }

  /**
   * Get the blob file URL a ref points into.
   *
   * Refs from the location table name their file. Refs from index entries don't; they
   * exist only in datasets whose blobs are all in one file.
   *
   * @param {{blobId: number, file?: number, offset: number, length: number}} ref - BlobRef
   * @returns {string} Blob file URL
   */
  #urlForRef(ref) {
    const files = this.#config.files;
    if (ref.file !== undefined) {
      if (!files || files[ref.file] === undefined) {
        throw new Error(
          `Blob ${ref.blobId} is in file ${ref.file}, but the manifest lists ${files?.length ?? 0} blob file(s)`
        );
      }
      return `${this.#baseUrl}/${files[ref.file]}`;
    }
    if (files) {
      if (files.length !== 1) {
        throw new Error(
          `Blob ${ref.blobId} has no file index, and the manifest lists ${files.length} blob files`
        );
      }
      return `${this.#baseUrl}/${files[0]}`;
    }
    if (this.#config.mode === 'sharded') {
      // Version 2 manifests and refs don't record which shard file holds a blob.
      throw new Error(
        `Can't locate blob ${ref.blobId}: version 2 sharded datasets don't record which shard ` +
          'file holds a blob. Rebuild the dataset to get a location table.'
      );
    }
    return `${this.#baseUrl}/blobs/data.bin`;
  }

  /**
   * Get the URL for a blob file.
   *
   * For a version 3 manifest, `fileIndex` is an index into `blobs.files`, the same index a
   * ref's `file` field holds. For a version 2 manifest it's the shard number (0-255) in
   * sharded mode and ignored in single mode.
   *
   * @param {number} [fileIndex=0] - File index
   * @returns {string} Full URL to the blob file
   */
  getBlobFileUrl(fileIndex = 0) {
    const files = this.#config.files;
    if (files) {
      if (files[fileIndex] === undefined) {
        throw new Error(`No blob file ${fileIndex}; the manifest lists ${files.length}`);
      }
      return `${this.#baseUrl}/${files[fileIndex]}`;
    }
    if (this.#config.mode === 'sharded') {
      const hex = fileIndex.toString(16).padStart(2, '0');
      return `${this.#baseUrl}/blobs/${hex}.bin`;
    }
    return `${this.#baseUrl}/blobs/data.bin`;
  }

  /**
   * Parse a blob file header.
   *
   * @param {Uint8Array} data - Header bytes
   * @returns {Object} Parsed header
   */
  #parseHeader(data) {
    if (data.length < BLOB_HEADER_SIZE) {
      throw new Error(`Blob file too small: ${data.length} bytes`);
    }

    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

    const magic = view.getUint32(0, true);
    if (magic !== BLOB_MAGIC) {
      throw new Error(`Invalid blob magic: 0x${magic.toString(16)}`);
    }

    const version = view.getUint16(4, true);
    if (version !== BLOB_VERSION) {
      throw new Error(`Unsupported blob version: ${version}`);
    }

    return {
      magic,
      version,
      flags: view.getUint16(6, true),
      blobCount: view.getBigUint64(8, true),
    };
  }

  /**
   * Validate a blob file by fetching and parsing its header.
   *
   * @param {number} [fileIndex=0] - File index, as for getBlobFileUrl
   * @returns {Promise<Object>} Parsed header
   */
  async validateFile(fileIndex = 0) {
    const url = this.getBlobFileUrl(fileIndex);

    // Check cache
    if (this.#headerCache.has(url)) {
      return this.#headerCache.get(url);
    }

    // Fetch just the header using range request
    const header = this.#parseHeader(await this.#cachedRange(url, 0, BLOB_HEADER_SIZE));

    this.#headerCache.set(url, header);
    return header;
  }

  /**
   * Fetch a complete blob by its reference.
   *
   * @param {{blobId: number, file?: number, offset: number, length: number}} ref - BlobRef from an index entry
   * @returns {Promise<Uint8Array>} Blob data
   */
  async getBlob(ref) {
    return this.getBlobRange(ref);
  }

  /**
   * Fetch a blob or partial blob using HTTP range requests.
   *
   * @param {{blobId: number, file?: number, offset: number, length: number}} ref - BlobRef from an index entry
   * @param {{subOffset?: number, subLength?: number}} [options] - Optional sub-range within the blob
   * @returns {Promise<Uint8Array>} Blob data (full or partial)
   */
  async getBlobRange(ref, options) {
    // Calculate file offset: header + ref.offset + optional sub-offset
    const fileOffset = BLOB_HEADER_SIZE + ref.offset + (options?.subOffset ?? 0);

    // Calculate length: sub-length if specified, otherwise full blob length
    const length = options?.subLength ?? ref.length;

    // Ensure we don't read beyond the blob
    if (options?.subOffset !== undefined && options.subLength !== undefined) {
      if (options.subOffset + options.subLength > ref.length) {
        throw new Error(
          `Sub-range exceeds blob length: offset=${options.subOffset}, length=${options.subLength}, blob length=${ref.length}`
        );
      }
    }

    return this.#cachedRange(this.#urlForRef(ref), fileOffset, fileOffset + length);
  }

  /**
   * Fetch multiple blobs, merging nearby byte ranges into fewer requests.
   *
   * Refs whose ranges touch, overlap, or sit within `coalesceGap` bytes of each other in
   * the same file are merged into one range (capped at `maxRangeBytes`), and all of a
   * file's ranges go out in one multi-range request (up to `maxRangesPerRequest` ranges
   * each). The responses are split back into one entry per blob. With a range cache, each
   * blob is looked up and stored under its own range, so only cache misses are requested.
   *
   * @param {Array<{blobId: number, file?: number, offset: number, length: number}>} refs - Array of BlobRefs to fetch
   * @returns {Promise<Map<number, Uint8Array>>} Map of blob_id to blob data, in the order of `refs`
   */
  async getBlobs(refs) {
    /** @type {Uint8Array[]} */
    const data = new Array(refs.length);

    /** @type {Map<string, Array<{start: number, end: number, index: number}>>} */
    const byUrl = new Map();
    await Promise.all(
      refs.map(async (ref, index) => {
        const url = this.#urlForRef(ref);
        const start = BLOB_HEADER_SIZE + ref.offset;
        const end = start + ref.length;
        const hit = await this.#cacheGet(url, start, end);
        if (hit) {
          data[index] = hit;
          return;
        }
        let ranges = byUrl.get(url);
        if (!ranges) {
          ranges = [];
          byUrl.set(url, ranges);
        }
        ranges.push({ start, end, index });
      })
    );

    const requests = [];
    for (const [url, ranges] of byUrl) {
      const groups = coalesceRanges(ranges, {
        gap: this.#coalesceGap,
        maxBytes: this.#maxRangeBytes,
      }).filter((group) => {
        if (group.end > group.start) return true;
        // Only zero-length blobs; nothing to request
        for (const member of group.members) data[member.index] = new Uint8Array(0);
        return false;
      });
      if (groups.length === 0) continue;
      requests.push(
        this.#fetchRanges(url, groups).then((chunks) =>
          Promise.all(
            groups.flatMap((group, g) =>
              group.members.map((member) => {
                const blob = chunks[g].slice(member.start - group.start, member.end - group.start);
                data[member.index] = blob;
                return this.#cacheSet(url, member.start, member.end, blob);
              })
            )
          )
        )
      );
    }
    await Promise.all(requests);

    const results = new Map();
    refs.forEach((ref, index) => {
      if (!results.has(ref.blobId)) {
        results.set(ref.blobId, data[index]);
      }
    });
    return results;
  }

  /**
   * Get a blob by ID from a list of refs.
   * Finds the ref with the matching blob_id and fetches it.
   *
   * @param {number} blobId - Blob ID to fetch
   * @param {Array<{blobId: number, file?: number, offset: number, length: number}>} refs - Array of BlobRefs to search
   * @returns {Promise<Uint8Array|null>} Blob data or null if not found
   */
  async getBlobById(blobId, refs) {
    const ref = refs.find((r) => r.blobId === blobId);
    if (!ref) {
      return null;
    }
    return this.getBlob(ref);
  }

  /**
   * Fetch the entire blob file (for small datasets or caching).
   *
   * @param {number} [fileIndex=0] - File index, as for getBlobFileUrl
   * @returns {Promise<Uint8Array>} Full file data
   */
  async fetchFullFile(fileIndex = 0) {
    const url = this.getBlobFileUrl(fileIndex);
    const response = this.#fetchFn ? await this.#fetchFn(url) : await fetch(url);

    if (!response.ok) {
      throw new Error(`Failed to fetch blob file: ${response.status} ${response.statusText}`);
    }

    const buffer = await response.arrayBuffer();
    return new Uint8Array(buffer);
  }

  /**
   * Create a blob extractor from a pre-fetched file.
   * Useful when the entire file has been loaded into memory.
   *
   * @param {Uint8Array} data - Full blob file data
   * @returns {function({blobId: number, file?: number, offset: number, length: number}, {subOffset?: number, subLength?: number}=): Uint8Array} Extractor function
   */
  createExtractor(data) {
    // Validate header
    this.#parseHeader(data);

    return (ref, options) => {
      const offset = BLOB_HEADER_SIZE + ref.offset + (options?.subOffset ?? 0);
      const length = options?.subLength ?? ref.length;

      if (options?.subOffset !== undefined && options.subLength !== undefined) {
        if (options.subOffset + options.subLength > ref.length) {
          throw new Error(
            `Sub-range exceeds blob length: offset=${options.subOffset}, length=${options.subLength}, blob length=${ref.length}`
          );
        }
      }

      return data.slice(offset, offset + length);
    };
  }
}

/**
 * @typedef {Object} BlobReaderOptions
 * @property {number} [coalesceGap=1024] - Merge blob ranges in `getBlobs` when the gap
 *   between them is at most this many bytes. 0 merges only touching or overlapping ranges.
 * @property {number} [maxRangeBytes=8388608] - Stop merging once a request would exceed
 *   this many bytes.
 * @property {RangeCache} [cache] - Application cache for range responses. None by default.
 * @property {number} [maxRangesPerRequest=100] - Most byte ranges sent in one multi-range
 *   request; more ranges are split across requests. The cap keeps the `Range` header
 *   under servers' request header limits. 1 sends one range per request.
 */

/**
 * A cache for byte-range responses, supplied by the application.
 *
 * Keys come from `rangeCacheKey(url, start, end)` and name the range a caller asked for
 * (a blob, a sub-range of one, or a file header), not the coalesced request that fetched
 * it. Both methods may return a promise. Errors from either propagate to the caller.
 *
 * @typedef {Object} RangeCache
 * @property {(key: string) => Uint8Array | undefined | null | Promise<Uint8Array | undefined | null>} get -
 *   Return the cached bytes for `key`, or undefined/null on a miss
 * @property {(key: string, bytes: Uint8Array) => void | Promise<void>} set - Store `bytes` under `key`
 */
