/**
 * RoaringBuckets JavaScript Client
 *
 * A browser-first client library for querying RoaringBuckets datasets.
 *
 * @example
 * ```javascript
 * import { Dataset } from '@roaringbuckets/client';
 *
 * const dataset = await Dataset.load('https://example.com/dataset');
 *
 * // Single dimension search
 * const results = await dataset.search('vendors', 'acme');
 *
 * // Multi-dimension query
 * const query = await dataset.query({
 *   vendors: 'acme',
 *   categories: 'electronics'
 * });
 *
 * // Fetch blobs
 * const blobs = await dataset.queryAndFetchBlobs({
 *   vendors: 'acme'
 * });
 * ```
 */

// Main API
export { Dataset } from './dataset.js';

// Core readers
export { IndexReader } from './index-reader.js';
export { ShardedIndexReader } from './sharded-index-reader.js';
export { BlobReader } from './blob-reader.js';
export { LocationTable, parseLocationHeader, parseLocationRow } from './location-table.js';

// Range utilities
export {
  coalesceRanges,
  rangeCacheKey,
  multiRangeHeader,
  multipartBoundary,
  parseContentRange,
  parseMultipartByteranges,
  DEFAULT_COALESCE_GAP,
  DEFAULT_MAX_RANGE_BYTES,
  DEFAULT_MAX_RANGES_PER_REQUEST,
} from './ranges.js';

// Manifest utilities
export { loadManifest, parseManifest } from './manifest.js';

// Low-level utilities
export {
  decodeRoaring,
  decodeRoaringU32,
  decodeRoaringLimit,
  countRoaring,
  intersect,
  union,
} from './roaring.js';
export { decodeVarint, decodeRefs } from './varint.js';

// Constants
export {
  INDEX_MAGIC,
  INDEX_VERSION,
  BLOB_MAGIC,
  BLOB_VERSION,
  INDEX_HEADER_SIZE,
  INDEX_ENTRY_SIZE,
  BLOB_HEADER_SIZE,
  MANIFEST_VERSIONS,
  LOCATION_MAGIC,
  LOCATION_VERSION,
  LOCATION_HEADER_SIZE,
  LOCATION_ROW_SIZE,
  LOCATION_ABSENT_FILE,
  IndexFlags,
} from './types.js';
