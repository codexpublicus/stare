/**
 * Type definitions and constants for RoaringBuckets client.
 *
 * Types are documented in JSDoc for IDE support.
 */

/** EIDX file magic bytes */
export const INDEX_MAGIC = 'EIDX';

/** EIDX format version written by the current builder */
export const INDEX_VERSION = 3;

/**
 * EIDX entry table record size in bytes, by format version.
 * v2: u16 bitmap_length and refs_count (18 bytes).
 * v3: u32 bitmap_length and refs_count (22 bytes).
 */
export const INDEX_ENTRY_SIZES = Object.freeze({ 2: 18, 3: 22 });

/** RBLB file magic (little-endian) */
export const BLOB_MAGIC = 0x424c4252; // "RBLB"

/** RBLB format version */
export const BLOB_VERSION = 1;

/** EIDX header size in bytes */
export const INDEX_HEADER_SIZE = 32;

/** EIDX entry table record size in bytes for INDEX_VERSION */
export const INDEX_ENTRY_SIZE = INDEX_ENTRY_SIZES[INDEX_VERSION];

/** RBLB header size in bytes */
export const BLOB_HEADER_SIZE = 16;

/** Manifest versions this client reads */
export const MANIFEST_VERSIONS = Object.freeze([2, 3, 4]);

/** Ways a sharded index can be split, as named by an index's `partition` field */
export const PARTITIONS = Object.freeze(['prefix', 'range']);

/** Location table (RBLT) magic, little-endian */
export const LOCATION_MAGIC = 0x544c4252; // "RBLT"

/** Location table format version */
export const LOCATION_VERSION = 1;

/** Location table header size in bytes */
export const LOCATION_HEADER_SIZE = 32;

/** Location table row size in bytes: offset u64, length u32, file u16 */
export const LOCATION_ROW_SIZE = 14;

/** File index marking a location table row that has no blob */
export const LOCATION_ABSENT_FILE = 0xffff;

/** Index header flags */
export const IndexFlags = {
  SORTED: 0x01,
  CASE_INSENSITIVE: 0x02,
  HAS_PREFIX_TABLE: 0x04,
};
