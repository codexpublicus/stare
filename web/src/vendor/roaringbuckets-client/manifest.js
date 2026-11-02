/**
 * Manifest loading and parsing for RoaringBuckets datasets.
 */

import { compareKeys } from './keys.js';
import { MANIFEST_VERSIONS, PARTITIONS } from './types.js';

/**
 * Validate and parse a manifest JSON object.
 *
 * @param {unknown} data - Raw JSON object from manifest.json
 * @returns {Object} Parsed and validated Manifest object
 */
export function parseManifest(data) {
  if (!data || typeof data !== 'object') {
    throw new Error('Manifest must be an object');
  }

  if (typeof data.version !== 'number') {
    throw new Error('Manifest must have a numeric version');
  }
  if (!MANIFEST_VERSIONS.includes(data.version)) {
    throw new Error(
      `Unsupported manifest version: ${data.version}. This client reads versions ` +
        `${joinVersions(MANIFEST_VERSIONS)}; a newer dataset needs a newer client.`
    );
  }

  if (typeof data.format !== 'string') {
    throw new Error('Manifest must have a format string');
  }
  if (typeof data.created !== 'string') {
    throw new Error('Manifest must have a created timestamp');
  }
  if (typeof data.generator !== 'string') {
    throw new Error('Manifest must have a generator string');
  }

  return {
    version: data.version,
    format: data.format,
    created: data.created,
    generator: data.generator,
    blobs: parseBlobsConfig(data.blobs, data.version),
    indexes: parseIndexes(data.indexes),
    dimensions: parseDimensions(data.dimensions),
  };
}

/**
 * Format versions for an error message: "2, 3 and 4".
 *
 * @param {readonly number[]} versions
 * @returns {string}
 */
function joinVersions(versions) {
  if (versions.length === 1) return String(versions[0]);
  return `${versions.slice(0, -1).join(', ')} and ${versions[versions.length - 1]}`;
}

/**
 * Parse a non-negative integer field, or throw.
 *
 * @param {string} what - Field name, for error messages
 * @param {unknown} value - Raw value
 * @returns {number}
 */
function parseCount(what, value) {
  if (!Number.isSafeInteger(value) || /** @type {number} */ (value) < 0) {
    throw new Error(`Manifest ${what} must be a non-negative integer, got ${value}`);
  }
  return /** @type {number} */ (value);
}

/**
 * Parse `blobs.locations`: the location table's path and its row range.
 *
 * @param {unknown} data - Raw locations value
 * @returns {{file: string, first_id: number, count: number} | null}
 */
function parseLocations(data) {
  if (data === undefined || data === null) return null;
  if (typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Manifest blobs.locations must be an object');
  }
  if (typeof data.file !== 'string' || data.file === '') {
    throw new Error('Manifest blobs.locations.file must be a path');
  }
  return {
    file: data.file,
    first_id: parseCount('blobs.locations.first_id', data.first_id),
    count: parseCount('blobs.locations.count', data.count),
  };
}

/**
 * Parse `blobs.files`: blob file paths, indexed by a ref's `file` field.
 *
 * @param {unknown} data - Raw files value
 * @returns {string[]}
 */
function parseBlobFiles(data) {
  if (!Array.isArray(data) || !data.every((f) => typeof f === 'string' && f !== '')) {
    throw new Error('Manifest blobs.files must be an array of paths');
  }
  return [...data];
}

function parseBlobsConfig(data, version) {
  if (!data || typeof data !== 'object') {
    throw new Error('Manifest blobs must be an object');
  }

  if (data.mode !== 'single' && data.mode !== 'sharded') {
    throw new Error(`Invalid blobs mode: ${data.mode}`);
  }

  const config = {
    mode: data.mode,
    total_entries: Number(data.total_entries),
    unique_blobs: Number(data.unique_blobs),
    total_bytes: Number(data.total_bytes),
    hash_algorithm: String(data.hash_algorithm || 'xxhash64'),
  };

  if (version >= 3) {
    config.files = parseBlobFiles(data.files);
    config.locations = parseLocations(data.locations);
    if (config.mode === 'sharded' && !config.locations) {
      throw new Error(
        'Manifest has sharded blobs but no blobs.locations; blobs in it cannot be located'
      );
    }
  } else {
    // Version 2: no file list, no location table. Blob files are found by naming convention.
    config.files = null;
    config.locations = null;
  }

  if (data.deduplication && typeof data.deduplication === 'object') {
    config.deduplication = {
      enabled: Boolean(data.deduplication.enabled),
      dedup_ratio: Number(data.deduplication.dedup_ratio),
    };
  }

  return config;
}

/**
 * Parse a sharded index's shard_files map (shard key to file path). Manifests from
 * writers older than the shard file name encoding have none; return null for those.
 *
 * @param {string} name - Index name, for error messages
 * @param {unknown} data - Raw shard_files value
 * @returns {Record<string, string> | null}
 */
function parseShardFiles(name, data) {
  if (data === undefined || data === null) return null;
  if (typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`Index ${name} shard_files must be an object`);
  }
  const result = {};
  for (const [shard, file] of Object.entries(data)) {
    result[shard] = String(file);
  }
  return result;
}

/**
 * Parse a prefix-sharded index's shard list: `shards` (prefixes in order) and
 * `shard_files` (prefix to path). It is in the manifest, or (manifest version 4) in the
 * file the index's `directory` names.
 *
 * @param {string} name - Index name, for error messages
 * @param {any} data - An object holding the two fields
 * @param {boolean} [strict=true] - Require `shards` to be an array; the manifest's inline
 *   list has always tolerated a missing one
 * @returns {{shards: string[], shard_files: Record<string, string> | null}}
 */
export function parseShardList(name, data, strict = true) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`Index ${name} shard list must be an object`);
  }
  if (strict && !Array.isArray(data.shards)) {
    throw new Error(`Index ${name} shard list must have a shards array`);
  }
  return {
    shards: Array.isArray(data.shards) ? data.shards.map(String) : [],
    shard_files: parseShardFiles(name, data.shard_files),
  };
}

/**
 * Parse a range-partitioned index's shard bounds: the lowest folded key each shard can
 * hold. They are in the manifest, or in the file the index's `directory` names.
 *
 * @param {string} name - Index name, for error messages
 * @param {any} data - An object holding `bounds`
 * @returns {string[]} One bound per shard; the first is ""
 */
export function parseBounds(name, data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`Index ${name} shard list must be an object`);
  }
  const bounds = data.bounds;
  if (!Array.isArray(bounds) || !bounds.every((b) => typeof b === 'string')) {
    throw new Error(`Index ${name} shard list must have a bounds array of strings`);
  }
  if (bounds.length > 0 && bounds[0] !== '') {
    throw new Error(`Index ${name} bounds must start with the empty string`);
  }
  for (let i = 1; i < bounds.length; i++) {
    if (compareKeys(bounds[i - 1], bounds[i]) >= 0) {
      throw new Error(
        `Index ${name} bounds are not in increasing order: ` +
          `${JSON.stringify(bounds[i - 1])}, ${JSON.stringify(bounds[i])}`
      );
    }
  }
  return [...bounds];
}

function parseIndexes(data) {
  if (!data || typeof data !== 'object') {
    throw new Error('Manifest indexes must be an object');
  }

  const result = {};

  for (const [name, value] of Object.entries(data)) {
    if (!value || typeof value !== 'object') {
      throw new Error(`Index ${name} must be an object`);
    }

    if (value.sharded === true) {
      const partition = value.partition ?? 'prefix';
      if (!PARTITIONS.includes(partition)) {
        throw new Error(
          `Index ${name} has partition ${JSON.stringify(partition)}, which this client ` +
            "doesn't know; a newer dataset needs a newer client."
        );
      }
      const index = {
        sharded: true,
        partition,
        shard_depth: Number(value.shard_depth),
        pattern: String(value.pattern),
        directory: null,
        shards: [],
        shard_files: null,
        bounds: null,
        shard_count: 0,
        total_entries: Number(value.total_entries),
      };
      if (value.directory !== undefined && value.directory !== null) {
        if (typeof value.directory !== 'string' || value.directory === '') {
          throw new Error(`Index ${name} directory must be a path`);
        }
        index.directory = value.directory;
        index.shard_count = parseCount(`index ${name} shard_count`, value.shard_count);
      } else if (partition === 'range') {
        index.bounds = parseBounds(name, value);
        index.shard_count = index.bounds.length;
      } else {
        Object.assign(index, parseShardList(name, value, false));
        index.shard_count = index.shards.length;
      }
      result[name] = index;
    } else {
      result[name] = {
        file: String(value.file),
        entries: Number(value.entries),
        sharded: false,
      };
    }
  }

  return result;
}

function parseDimensions(data) {
  if (!data || typeof data !== 'object') {
    throw new Error('Manifest dimensions must be an object');
  }

  const result = {};

  for (const [name, value] of Object.entries(data)) {
    if (!value || typeof value !== 'object') {
      throw new Error(`Dimension ${name} must be an object`);
    }

    const indexType = value.index_type;
    if (indexType !== 'exact' && indexType !== 'lowercase') {
      throw new Error(`Invalid index_type for dimension ${name}: ${indexType}`);
    }

    result[name] = {
      field: String(value.field),
      index_type: indexType,
      cardinality: Number(value.cardinality),
      description: value.description ? String(value.description) : undefined,
    };
  }

  return result;
}

/**
 * Load a manifest from a URL.
 *
 * @param {string} baseUrl - Base URL of the dataset
 * @param {typeof globalThis.fetch} [fetchFn] - Optional custom fetch function
 * @returns {Promise<Object>} Parsed Manifest object
 */
export async function loadManifest(baseUrl, fetchFn) {
  const base = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  const url = `${base}/manifest.json`;

  const response = fetchFn ? await fetchFn(url) : await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to load manifest: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  return parseManifest(data);
}
