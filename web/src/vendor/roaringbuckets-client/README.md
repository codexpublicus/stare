# The RoaringBuckets JS client, vendored

The `.js` files are byte-for-byte copies of the RoaringBuckets JS client's source
(`packages/client/src/` in its repository) at the commit `../search-client.json` names
(v0.3.0, the version the index builder's search build pins, plus a fix that aborts a ranged
read a server answers with the whole file; no release has it yet), and `LICENSE` is that
repository's licence, PolyForm Shield 1.0.0. The index builder's reference query
(`../stare-search/` for search format 3, `../stare-search-format2/` for format 2) reads the
search tree with it. Don't edit them; copy them in again at a new pin.
