use anyhow::{bail, Context, Result};
use clap::{Parser, Subcommand};
use stare::config;
use std::path::PathBuf;

#[derive(Parser)]
#[command(name = "stare", about = "Look up U.S. case law by citation")]
struct Cli {
    /// Override index source (path or URL)
    #[arg(long, global = true, env = "STARE_INDEX")]
    index: Option<String>,

    /// Override data source (path or URL)
    #[arg(long, global = true, env = "STARE_DATA")]
    data: Option<String>,

    /// Output as JSON
    #[arg(long, global = true)]
    json: bool,

    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Resolve a citation to case text
    Resolve {
        /// Citation: "31 A.2d 647" or "a2d 31 647" or slug volume page as separate args
        citation: Vec<String>,
    },
    /// List all cases in a volume
    List {
        /// Reporter slug and volume: "a2d 31" or separate args
        args: Vec<String>,
    },
    /// Check citations in a text file (or - for stdin)
    Check {
        /// Path to text file (or - for stdin)
        file: String,
    },
    /// Manage configuration
    Config {
        #[command(subcommand)]
        action: ConfigAction,
    },
    /// Manage local cache
    Cache {
        #[command(subcommand)]
        action: CacheAction,
    },
    /// Download the citation index and case data for one or more reporters
    Download {
        /// Reporter slugs to download, comma-separated (e.g. a2d,a3d)
        #[arg(long, value_delimiter = ',', required = true)]
        reporters: Vec<String>,
    },
}

#[derive(Subcommand)]
enum ConfigAction {
    /// Show current configuration
    Show,
    /// Set a config value (key: index, data)
    Set { key: String, value: String },
    /// Reset to defaults
    Reset,
}

#[derive(Subcommand)]
enum CacheAction {
    /// Show cache statistics
    Status,
    /// Clear cache (all, bins, zips, tars)
    Clear {
        /// What to clear: all, bins, zips, tars
        #[arg(default_value = "all")]
        kind: String,
    },
}

/// Resolved sources after config + env + flag merge.
struct Sources {
    index: String,
    data: String,
    /// The index manifest, fetched on first use (see [`Sources::manifest`]).
    manifest: std::cell::OnceCell<Option<stare::manifest::Manifest>>,
}

impl Sources {
    fn from_cli(cli: &Cli) -> Self {
        let cfg = config::load_config();
        Sources {
            index: cli
                .index
                .clone()
                .unwrap_or_else(|| cfg.index_source().to_string()),
            data: cli
                .data
                .clone()
                .unwrap_or_else(|| cfg.data_source().to_string()),
            manifest: std::cell::OnceCell::new(),
        }
    }

    /// The index manifest, fetched once per run. When the index source can't be
    /// reached, the copy saved by the last successful fetch is used, so cached index
    /// files are still found offline. None when there's neither.
    fn manifest(&self) -> Option<&stare::manifest::Manifest> {
        self.manifest
            .get_or_init(|| fetch_manifest(self).ok())
            .as_ref()
    }

    /// Where an index file (`a3d/138.bin`) is, relative to the index source, and its
    /// cache key: under the manifest's `base` (`v/v2026.10.03/a3d/138.bin`) when it has
    /// one, at the root otherwise. A build's files never change under their versioned
    /// path, so a new index version is new cache keys.
    fn index_key(&self, path: &str) -> String {
        match self.manifest() {
            Some(m) => m.index_path(path),
            None => path.to_string(),
        }
    }

    fn is_url(s: &str) -> bool {
        stare_cli::is_url(s)
    }
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    let json = cli.json;
    let src = Sources::from_cli(&cli);

    match cli.command {
        Commands::Resolve { citation } => {
            let input = citation.join(" ");
            let result = match parse_labeled_input(&input) {
                Some((reporter, volume, label)) => resolve_label(&src, &reporter, &volume, &label)?,
                None => {
                    let (reporter, volume, page) = parse_citation_input(&input)?;
                    resolve_case(&src, &reporter, &volume, page)?
                }
            };
            if json {
                println!("{}", serde_json::to_string_pretty(&result.case)?);
            } else {
                print_case(&result);
            }
        }
        Commands::List { args } => {
            let input = args.join(" ");
            let parts: Vec<&str> = input.split_whitespace().collect();
            if parts.len() != 2 {
                anyhow::bail!("Usage: stare list <reporter> <volume> (e.g., stare list a2d 31)");
            }
            let reporter = parts[0].to_lowercase();
            let volume = parts[1];
            if !stare::manifest::is_volume_key(volume) {
                anyhow::bail!("invalid volume: {}", volume);
            }
            list_cases(&src, &reporter, volume, json)?;
        }
        Commands::Check { file } => {
            check_citations(&file, &src, json)?;
        }
        Commands::Config { action } => match action {
            ConfigAction::Show => config_show(),
            ConfigAction::Set { key, value } => config_set(&key, &value)?,
            ConfigAction::Reset => config_reset()?,
        },
        Commands::Cache { action } => match action {
            CacheAction::Status => cache_status(),
            CacheAction::Clear { kind } => cache_clear(&kind)?,
        },
        Commands::Download { reporters } => download_reporters(&src, reporters)?,
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Citation parsing
// ---------------------------------------------------------------------------

/// Parse citation input — tries slug format first, then citare.
///
/// Accepts:
///   "a2d 31 647"       → slug format
///   "a3d 138-2 1012"   → slug format naming a CAP volume folder
///   "31 A.2d 647"      → natural citation (via citare)
///   "410 U.S. 113"     → natural citation
///
/// The volume is a string: a cited volume number, or a CAP folder name in slug format.
fn parse_citation_input(input: &str) -> Result<(String, String, u32)> {
    // Try slug format: "a2d 31 647"
    let parts: Vec<&str> = input.split_whitespace().collect();
    if parts.len() == 3 && stare::manifest::is_volume_key(parts[1]) {
        if let Ok(page) = parts[2].parse::<u32>() {
            return Ok((parts[0].to_lowercase(), parts[1].to_string(), page));
        }
    }

    // Try citare
    let detected = stare::cite::detect_citations(input);
    for c in &detected {
        if let (Some(slug), Some(vol_str), Some(page_str)) = (&c.harvard_slug, &c.volume, &c.page) {
            if let (Ok(vol), Ok(page)) = (vol_str.parse::<u32>(), page_str.parse::<u32>()) {
                return Ok((slug.clone(), vol.to_string(), page));
            }
        }
    }

    bail!(
        "Could not parse citation: \"{}\"\nTry: \"31 A.2d 647\" or \"a2d 31 647\"",
        input
    )
}

/// Slug format with a page that isn't a number: "cai-cas 1 xxix", "cal-app-4th 15
/// Supp. 1". Those pages are front matter or supplements, indexed by label.
fn parse_labeled_input(input: &str) -> Option<(String, String, String)> {
    // A natural citation ("31 A.2d 647") fails here on its volume, "A.2d".
    let mut parts = input.split_whitespace();
    let reporter = parts.next()?;
    let volume = parts.next()?;
    let label = parts.collect::<Vec<_>>().join(" ");
    let slug = reporter
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-');
    if !slug
        || !stare::manifest::is_volume_key(volume)
        || label.is_empty()
        || label.starts_with(|c: char| c.is_ascii_digit())
    {
        return None;
    }
    Some((reporter.to_lowercase(), volume.to_string(), label))
}

// ---------------------------------------------------------------------------
// Fetch helpers — check cache first, then source (path or URL)
// ---------------------------------------------------------------------------

fn fetch_bin(src: &Sources, reporter: &str, volume: &str) -> Result<Vec<u8>> {
    let key = src.index_key(&format!("{}/{}.bin", reporter, volume));

    // 1. Check cache
    if let Some(data) = config::cache_get("bins", &key) {
        return Ok(data);
    }

    // 2. Check configured index source
    let source = &src.index;
    let data = if !source.is_empty() {
        if Sources::is_url(source) {
            fetch_url(&format!("{}/{}", source, key))?
        } else {
            let path = PathBuf::from(source).join(&key);
            std::fs::read(&path).with_context(|| format!("index not found: {}", path.display()))?
        }
    } else {
        bail!("No index source configured. Run: stare config set index <path-or-url>");
    };

    // Cache for next time
    let _ = config::cache_set("bins", &key, &data);
    Ok(data)
}

/// A volume's `.multi` file, or None if it has none.
fn fetch_multi(src: &Sources, reporter: &str, volume: &str) -> Result<Option<String>> {
    fetch_optional_index(src, &format!("{}/{}.multi", reporter, volume))?
        .map(String::from_utf8)
        .transpose()
        .map_err(Into::into)
}

/// One part of a volume's unified index (`<reporter>/<volume>.idx.gz`, or a later
/// `.<n>.idx.gz`), parsed; None when the source has no such file.
fn fetch_idx(
    src: &Sources,
    reporter: &str,
    volume: &str,
    part: usize,
) -> Result<Option<stare::idx::VolumeIndex>> {
    let path = stare::idx::path(reporter, volume, part)?;
    let Some(bytes) = fetch_optional_index(src, &path)? else {
        return Ok(None);
    };
    stare::idx::parse_bytes(&bytes)
        .with_context(|| format!("failed to read {}", path))
        .map(Some)
}

/// A file of the index that a volume may not have, by its path under the manifest's
/// `base`: None when the source has no such file.
fn fetch_optional_index(src: &Sources, path: &str) -> Result<Option<Vec<u8>>> {
    let key = src.index_key(path);
    if let Some(data) = config::cache_get("bins", &key) {
        return Ok(Some(data));
    }
    let source = &src.index;
    let data = if Sources::is_url(source) {
        let url = format!("{}/{}", source, key);
        let client = reqwest::blocking::Client::builder()
            .user_agent("stare/0.1.0 (case law tool; github.com/codexpublicus/stare)")
            .build()?;
        let response = client
            .get(&url)
            .send()
            .with_context(|| format!("failed to fetch {}", url))?;
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !response.status().is_success() {
            bail!("HTTP {} fetching {}", response.status(), url);
        }
        response.bytes()?.to_vec()
    } else {
        let path = PathBuf::from(source).join(&key);
        if !path.exists() {
            return Ok(None);
        }
        std::fs::read(&path).with_context(|| format!("failed to read {}", path.display()))?
    };
    let _ = config::cache_set("bins", &key, &data);
    Ok(Some(data))
}

fn fetch_zip(src: &Sources, reporter: &str, volume: &str) -> Result<Vec<u8>> {
    let key = format!("{}/{}.zip", reporter, volume);

    if let Some(data) = config::cache_get("zips", &key) {
        return Ok(data);
    }

    let source = &src.data;
    let data = if Sources::is_url(source) {
        fetch_url(&format!("{}/{}", source, key))?
    } else {
        let path = PathBuf::from(source).join(&key);
        std::fs::read(&path).with_context(|| format!("zip not found: {}", path.display()))?
    };

    let _ = config::cache_set("zips", &key, &data);
    Ok(data)
}

/// A CourtListener record's bytes (gzip, as stored), from the data bucket's `cl/`
/// prefix, which sits beside the `cap/` the data source names. Records never change
/// under their path, so they're cached like the zips.
fn fetch_record(src: &Sources, cluster_id: u64, hash: &str) -> Result<Vec<u8>> {
    let key = stare::cl::record_path(cluster_id, hash)?;
    if let Some(data) = config::cache_get("zips", &key) {
        return Ok(data);
    }
    let base = stare::cl::data_base_for(&src.data);
    let data = if Sources::is_url(base) {
        fetch_url(&stare::cl::record_url(base, cluster_id, hash)?)?
    } else {
        let path = PathBuf::from(base).join(&key);
        std::fs::read(&path).with_context(|| format!("record not found: {}", path.display()))?
    };
    let _ = config::cache_set("zips", &key, &data);
    Ok(data)
}

fn fetch_url(url: &str) -> Result<Vec<u8>> {
    let client = reqwest::blocking::Client::builder()
        .user_agent("stare/0.1.0 (case law tool; github.com/codexpublicus/stare)")
        .build()?;
    let response = client
        .get(url)
        .send()
        .with_context(|| format!("failed to fetch {}", url))?;
    if !response.status().is_success() {
        bail!("HTTP {} fetching {}", response.status(), url);
    }
    Ok(response.bytes()?.to_vec())
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Fetch the index manifest from the index source. It changes when the index is
/// rebuilt, so it's always fetched; the copy saved in the cache
/// (`bins/manifest.json`, which `stare download` writes too) is only read when the
/// source can't be reached.
fn fetch_manifest(src: &Sources) -> Result<stare::manifest::Manifest> {
    let fetched = if Sources::is_url(&src.index) {
        fetch_url(&format!("{}/manifest.json", src.index))
    } else {
        let path = PathBuf::from(&src.index).join("manifest.json");
        std::fs::read(&path).with_context(|| format!("manifest not found: {}", path.display()))
    };
    match fetched {
        Ok(bytes) => {
            let manifest = stare::manifest::Manifest::parse(&bytes)?;
            let _ = config::cache_set("bins", stare_cli::MANIFEST_CACHE_KEY, &bytes);
            Ok(manifest)
        }
        Err(e) => match config::cache_get("bins", stare_cli::MANIFEST_CACHE_KEY) {
            Some(bytes) => stare::manifest::Manifest::parse(&bytes),
            None => Err(e),
        },
    }
}

/// Resolve a citation to `volume` (a cited number or a CAP folder name).
///
/// When the manifest says the build has the unified index (`idx`), the volume's
/// `.idx.gz` answers for every source in one read (plus a later part for a split
/// volume). Otherwise, or when the volume has no `.idx.gz` (a CAP folder named
/// directly, `a3d 138-2`), the `.bin`/`.multi` files do: the volume's own folder first,
/// then the manifest's other parts of a volume CAP split over several folders.
fn resolve_case(
    src: &Sources,
    reporter: &str,
    volume: &str,
    page: u32,
) -> Result<stare::resolve::CaseResult> {
    let key = stare::index::PageKey::Number(page as usize);
    if let Some(entries) = idx_entries(src, reporter, volume, &key)? {
        return resolve_entries(
            src,
            reporter,
            volume,
            &stare::idx::page_text(&key),
            &entries,
        );
    }
    let located = locate_cap(src, reporter, volume, page)?;
    let mut case_file = located.case_file;
    if case_file == stare::index::LONG_NAME {
        // The page's cases have names too long for the .bin; they're all in the .multi.
        let multi = fetch_multi(src, reporter, &located.volume)?
            .with_context(|| format!("{}/{}.multi is missing", reporter, located.volume))?;
        let multi = stare::index::parse_multi(&multi);
        let bin = fetch_bin(src, reporter, &located.volume)?;
        case_file = stare::index::lookup_all(&bin, &multi, page as usize)
            .first()
            .with_context(|| format!("no case at page {} in {}", page, located.volume))?
            .to_string();
    }
    let zip_data = fetch_zip(src, reporter, &located.volume)?;
    let case = stare::case::extract_from_zip(&zip_data, &case_file)?;
    Ok(stare::resolve::CaseResult { case_file, case })
}

/// The unified index's entries at `page` of `volume`, CAP's first: following part 0's
/// `#parts` header to the part the page is in. None when the manifest doesn't announce
/// the unified index or the volume has no `.idx.gz`, so the caller falls back to the
/// `.bin`/`.multi` files.
fn idx_entries(
    src: &Sources,
    reporter: &str,
    volume: &str,
    page: &stare::index::PageKey,
) -> Result<Option<Vec<stare::idx::Entry>>> {
    if !src.manifest().is_some_and(|m| m.has_idx()) {
        return Ok(None);
    }
    let Some(head) = fetch_idx(src, reporter, volume, 0)? else {
        return Ok(None);
    };
    let part = head.part_for(page);
    let index = if part == 0 {
        head
    } else {
        fetch_idx(src, reporter, volume, part)?.with_context(|| {
            format!(
                "{} is missing",
                stare::idx::path(reporter, volume, part).unwrap_or_default()
            )
        })?
    };
    Ok(Some(index.lookup(page).into_iter().cloned().collect()))
}

/// The first of a page's entries, read from its source: a CAP case from its folder's
/// zip, or a CourtListener record from the data bucket's `cl/`.
fn resolve_entries(
    src: &Sources,
    reporter: &str,
    volume: &str,
    page: &str,
    entries: &[stare::idx::Entry],
) -> Result<stare::resolve::CaseResult> {
    let entry = entries
        .first()
        .with_context(|| format!("no case at page {} in {} vol. {}", page, reporter, volume))?;
    if let Some((folder, case_file)) = entry.cap_case() {
        let zip_data = fetch_zip(src, reporter, folder.unwrap_or(volume))?;
        let case = stare::case::extract_from_zip(&zip_data, case_file)?;
        return Ok(stare::resolve::CaseResult {
            case_file: case_file.to_string(),
            case,
        });
    }
    let (cluster_id, hash) = entry
        .cl_record()
        .with_context(|| format!("unreadable index line {}", entry.line()))?;
    let bytes = fetch_record(src, cluster_id, hash)?;
    let case = stare::cl::decode_record(&bytes).with_context(|| {
        format!(
            "CourtListener record {}",
            stare::cl::record_path(cluster_id, hash).unwrap_or_default()
        )
    })?;
    Ok(stare::resolve::CaseResult {
        case_file: format!("cl/{}", cluster_id),
        case,
    })
}

/// The CAP folder with a case at `page` for a citation to `volume`; an error is a miss.
fn locate_cap(
    src: &Sources,
    reporter: &str,
    volume: &str,
    page: u32,
) -> Result<stare::manifest::Located> {
    let read = |v: &str| fetch_bin(src, reporter, v);
    match stare::manifest::locate(&[volume.to_string()], page, read) {
        Ok(found) => Ok(found),
        Err(direct) => {
            let Some(manifest) = src.manifest() else {
                return Err(direct.context(format!("{}/{}", reporter, volume)));
            };
            let others: Vec<String> = manifest
                .candidates(reporter, volume, page)
                .into_iter()
                .filter(|v| v != volume)
                .collect();
            if others.is_empty() {
                return Err(direct.context(format!("{}/{}", reporter, volume)));
            }
            stare::manifest::locate(&others, page, read).with_context(|| {
                format!("no case at page {} in {} vol. {}", page, reporter, volume)
            })
        }
    }
}

/// Resolve a case on an unnumbered page (`xxix`, `Supp. 1`) of a volume.
fn resolve_label(
    src: &Sources,
    reporter: &str,
    volume: &str,
    label: &str,
) -> Result<stare::resolve::CaseResult> {
    let key = stare::idx::parse_page(label).with_context(|| format!("not a page: {:?}", label))?;
    if let Some(entries) = idx_entries(src, reporter, volume, &key)? {
        return resolve_entries(src, reporter, volume, label, &entries);
    }
    let multi = fetch_multi(src, reporter, volume)?.unwrap_or_default();
    let labeled = stare::index::parse_labeled(&multi);
    let case_file = stare::index::lookup_label(&labeled, label)
        .first()
        .with_context(|| format!("no case at page {} in {}/{}", label, reporter, volume))?
        .to_string();
    let zip_data = fetch_zip(src, reporter, volume)?;
    let case = stare::case::extract_from_zip(&zip_data, &case_file)?;
    Ok(stare::resolve::CaseResult { case_file, case })
}

fn print_case(result: &stare::resolve::CaseResult) {
    let cite = result
        .case
        .citations
        .first()
        .map(|c| c.cite.as_str())
        .unwrap_or("—");
    println!("{}", result.case.name_abbreviation);
    println!(
        "{}  |  {}  |  {}",
        cite, result.case.decision_date, result.case.court.name
    );
    if let Some(line) = source_line(&result.case) {
        println!("{}", line);
    }
    println!();
    for opinion in &result.case.casebody.opinions {
        if let Some(author) = &opinion.author {
            println!("[{} — {}]", opinion.opinion_type, author);
        } else {
            println!("[{}]", opinion.opinion_type);
        }
        println!();
        println!("{}", opinion.text);
        println!();
    }
}

/// "Source: CourtListener (export 2026-09-30)" for a CourtListener record; None for
/// CAP's, which is the default source.
fn source_line(case: &stare::case::CaseJson) -> Option<String> {
    let source = case.source.as_ref().filter(|s| s.name == "courtlistener")?;
    Some(match &source.export {
        Some(export) => format!("Source: CourtListener (export {})", export),
        None => "Source: CourtListener".to_string(),
    })
}

fn list_cases(src: &Sources, reporter: &str, volume: &str, json: bool) -> Result<()> {
    let zip_data = fetch_zip(src, reporter, volume)?;
    let metadata = stare::case::extract_cases_metadata(&zip_data)?;

    if json {
        println!("{}", serde_json::to_string_pretty(&metadata)?);
    } else {
        println!("{} vol. {} — {} cases\n", reporter, volume, metadata.len());
        for entry in &metadata {
            let cite = entry
                .citations
                .first()
                .map(|c| c.cite.as_str())
                .unwrap_or("");
            println!(
                "  {}  {}  (pp. {}-{})",
                entry.file_name, entry.name_abbreviation, entry.first_page, entry.last_page
            );
            if !cite.is_empty() {
                println!("        {}", cite);
            }
        }
    }
    Ok(())
}

/// How a citation in `stare check` resolves, as the site shows it
/// (`web/public/js/citations.js`, `checkCitation`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CheckStatus {
    /// A case starts at the page: stare.pub has it.
    Found,
    /// A statute or regulation, linked to its text.
    External,
    /// A statute or regulation with no link to its text yet.
    Statute,
    /// stare.pub holds the volume, but no case starts at the page.
    HeldMiss,
    /// stare.pub doesn't hold the volume; the case links may have it.
    NotHeld,
    /// A short form citare couldn't tie to an earlier citation.
    NoAntecedent,
    /// Nothing to look up: no reporter, volume or page.
    Unchecked,
}

impl CheckStatus {
    fn as_str(self) -> &'static str {
        match self {
            CheckStatus::Found => "found",
            CheckStatus::External => "external",
            CheckStatus::Statute => "statute",
            CheckStatus::HeldMiss => "held_miss",
            CheckStatus::NotHeld => "not_held",
            CheckStatus::NoAntecedent => "no_antecedent",
            CheckStatus::Unchecked => "unchecked",
        }
    }
}

/// What one citation is looked up as: the citation itself, or a short
/// form's antecedent. A short form is never looked up at its pin page.
struct CheckTarget<'a> {
    slug: Option<String>,
    reporter: Option<&'a str>,
    volume: Option<u32>,
    page: Option<&'a str>,
    external_url: Option<&'a str>,
    /// A statute or regulation (it has a `LawRef`).
    law: bool,
    case_links: &'a [stare::cite::CaseLink],
}

fn check_target(c: &stare::cite::DetectedCitation) -> Option<CheckTarget<'_>> {
    let slug_for = |slug: &Option<String>, reporter: &Option<String>| {
        slug.clone().or_else(|| {
            reporter
                .as_deref()
                .map(|r| r.to_lowercase().replace(['.', ' '], ""))
                .filter(|s| !s.is_empty())
        })
    };
    if c.is_short_form() {
        let a = c.antecedent.as_ref()?;
        return Some(CheckTarget {
            slug: slug_for(&a.harvard_slug, &a.reporter),
            reporter: a.reporter.as_deref(),
            volume: a.volume.as_deref().and_then(|v| v.parse().ok()),
            page: a.page.as_deref(),
            external_url: a.external_url.as_deref(),
            law: a.law.is_some(),
            case_links: &a.case_links,
        });
    }
    Some(CheckTarget {
        slug: slug_for(&c.harvard_slug, &c.reporter),
        reporter: c.reporter.as_deref(),
        volume: c.volume.as_deref().and_then(|v| v.parse().ok()),
        page: c.page.as_deref(),
        external_url: c.external_url.as_deref(),
        law: c.law.is_some() || c.citation_type == "FullLawCitation",
        case_links: &c.case_links,
    })
}

/// Whether stare.pub holds `volume` of `slug`, and whether a case starts at `page` in
/// it: from the unified index when the build has one, else from the `.bin` files (and
/// the other parts of a volume CAP split).
fn check_page(src: &Sources, slug: &str, volume: u32, page: u32) -> (bool, bool) {
    let cited = volume.to_string();
    let held_by_manifest = src.manifest().is_some_and(|m| m.holds_volume(slug, &cited));
    let key = stare::index::PageKey::Number(page as usize);
    if let Ok(Some(entries)) = idx_entries(src, slug, &cited, &key) {
        return (true, !entries.is_empty());
    }
    let mut candidates = vec![cited.clone()];
    if let Some(m) = src.manifest() {
        for v in m.candidates(slug, &cited, page) {
            if !candidates.contains(&v) {
                candidates.push(v);
            }
        }
    }
    let found = stare::manifest::locate(&candidates, page, |v| fetch_bin(src, slug, v)).is_ok();
    let held = found || held_by_manifest || fetch_bin(src, slug, &cited).is_ok();
    (held, found)
}

fn check_status(src: &Sources, c: &stare::cite::DetectedCitation) -> CheckStatus {
    let Some(t) = check_target(c) else {
        return CheckStatus::NoAntecedent;
    };
    if t.external_url.is_some() {
        // A statute's text is the place for a plain `Id.`; with a pin
        // (`Id. § 1985`) it is a different section, which nothing here
        // can link to.
        return if c.is_short_form() && c.pin.is_some() {
            CheckStatus::Statute
        } else {
            CheckStatus::External
        };
    }
    if t.law {
        return CheckStatus::Statute;
    }
    let (Some(slug), Some(volume), Some(page)) = (
        t.slug.as_deref(),
        t.volume,
        t.page.and_then(|p| p.parse::<u32>().ok()),
    ) else {
        return CheckStatus::Unchecked;
    };
    match check_page(src, slug, volume, page) {
        (_, true) => CheckStatus::Found,
        (true, false) => CheckStatus::HeldMiss,
        (false, false) if !t.case_links.is_empty() => CheckStatus::NotHeld,
        _ => CheckStatus::Unchecked,
    }
}

fn check_citations(file: &str, src: &Sources, json: bool) -> Result<()> {
    let text = if file == "-" {
        use std::io::Read;
        let mut buf = String::new();
        std::io::stdin().read_to_string(&mut buf)?;
        buf
    } else {
        std::fs::read_to_string(file).with_context(|| format!("failed to read {}", file))?
    };

    let detected = stare::cite::detect_citations(&text);

    // One entry per citation and antecedent: every `Id.` that refers to
    // the same case shares one, and `Id.`s that refer to different cases
    // don't.
    let mut seen = std::collections::HashSet::new();
    let mut citations = Vec::new();
    for c in &detected {
        // A bare `§` citare can't tie to a code names nothing to look up,
        // and the site neither lists nor counts it.
        if c.citation_type == "UnknownCitation" {
            continue;
        }
        let antecedent = c.antecedent.as_ref().map(|a| a.matched_text.clone());
        if !seen.insert((c.matched_text.clone(), antecedent.clone())) {
            continue;
        }
        let status = check_status(src, c);
        let target = check_target(c);
        citations.push(serde_json::json!({
            "raw": c.matched_text, "type": c.citation_type,
            "reporter": target.as_ref().and_then(|t| t.reporter),
            "slug": target.as_ref().and_then(|t| t.slug.clone()),
            "volume": target.as_ref().and_then(|t| t.volume),
            "page": target.as_ref().and_then(|t| t.page),
            "pin": c.pin,
            "antecedent": antecedent,
            "status": status.as_str(),
            "resolvable": status == CheckStatus::Found,
            "external_url": target.as_ref().and_then(|t| t.external_url)
                .filter(|_| status == CheckStatus::External),
            "case_links": target.as_ref().map(|t| t.case_links).unwrap_or(&[]),
        }));
    }
    let resolvable_count = citations
        .iter()
        .filter(|c| c["resolvable"].as_bool().unwrap_or(false))
        .count();
    let statute_count = citations
        .iter()
        .filter(|c| matches!(c["status"].as_str(), Some("statute" | "external")))
        .count();

    if json {
        println!("{}", serde_json::to_string_pretty(&citations)?);
    } else {
        println!(
            "Found {} case citations ({} resolvable), {} statutes\n",
            citations.len() - statute_count,
            resolvable_count,
            statute_count
        );
        for c in &citations {
            let status = c["status"].as_str().unwrap_or("");
            let mark = match status {
                "found" => "✓",
                "external" | "not_held" => "↗",
                "no_antecedent" => "·",
                _ => "✗",
            };
            print!("  {} {}", mark, c["raw"].as_str().unwrap_or(""));
            if let Some(a) = c["antecedent"].as_str() {
                print!("  (refers to {}", a);
                if let Some(pin) = c["pin"].as_str() {
                    print!(", at {}", pin);
                }
                print!(")");
            }
            match status {
                "external" => print!("  → {}", c["external_url"].as_str().unwrap_or("")),
                "held_miss" => print!(
                    "  → no case found at this page in {} vol. {}",
                    c["reporter"].as_str().or(c["slug"].as_str()).unwrap_or(""),
                    c["volume"]
                ),
                "statute" => print!("  (statute; no free source linked yet)"),
                // Nothing checks that the case is there (citare#39).
                "not_held" => {
                    if let Some(url) = c["case_links"][0]["url"].as_str() {
                        print!("  → not in stare.pub, may be at {}", url);
                    }
                }
                "no_antecedent" => {
                    print!("  (refers to an earlier citation that couldn't be identified)")
                }
                _ => {}
            }
            println!();
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Config commands
// ---------------------------------------------------------------------------

fn config_show() {
    let cfg = config::load_config();
    let config_path = config::config_dir().join("config.toml");
    let cache_dir = config::cache_dir();

    println!("Config: {}", config_path.display());
    println!("Cache:  {}\n", cache_dir.display());
    println!(
        "  index = {}",
        if cfg.index_source().is_empty() {
            "(not set)"
        } else {
            cfg.index_source()
        }
    );
    println!("  data  = {}", cfg.data_source());
}

fn config_set(key: &str, value: &str) -> Result<()> {
    let mut cfg = config::load_config();
    match key {
        "index" => cfg.sources.index = Some(value.to_string()),
        "data" => cfg.sources.data = Some(value.to_string()),
        _ => bail!("Unknown config key: {}. Valid keys: index, data", key),
    }
    config::save_config(&cfg)?;
    println!("Set {} = {}", key, value);
    Ok(())
}

fn config_reset() -> Result<()> {
    config::save_config(&config::Config::default())?;
    println!("Config reset to defaults");
    Ok(())
}

// ---------------------------------------------------------------------------
// Cache commands
// ---------------------------------------------------------------------------

fn cache_status() {
    let stats = config::cache_stats();
    let total_bytes: u64 = stats.iter().map(|s| s.total_bytes).sum();
    let total_count: usize = stats.iter().map(|s| s.count).sum();

    println!("Cache: {}\n", config::cache_dir().display());
    for s in &stats {
        println!(
            "  {:5}  {:>5} files  {:>10}",
            s.kind,
            s.count,
            config::format_bytes(s.total_bytes)
        );
    }
    println!("  ─────────────────────────────");
    println!(
        "  total  {:>5} files  {:>10}",
        total_count,
        config::format_bytes(total_bytes)
    );
}

fn cache_clear(kind: &str) -> Result<()> {
    match kind {
        "all" | "bins" | "zips" | "tars" => {
            config::cache_clear(kind)?;
            println!("Cleared {} cache", kind);
        }
        _ => bail!("Unknown cache type: {}. Valid: all, bins, zips, tars", kind),
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Download command
// ---------------------------------------------------------------------------

fn download_reporters(src: &Sources, reporters: Vec<String>) -> Result<()> {
    // Normalization (lowercasing) happens once, in `download::run`, which is the
    // library entry point and the only place that needs to match manifest keys.
    let reporters: Vec<String> = reporters
        .into_iter()
        .map(|r| r.trim().to_string())
        .filter(|r| !r.is_empty())
        .collect();
    if reporters.is_empty() {
        bail!("no reporters specified. Usage: stare download --reporters a2d,a3d");
    }

    let cache_dir = config::cache_dir();
    let cfg = stare_cli::download::DownloadConfig {
        index_source: &src.index,
        data_source: &src.data,
        cache_dir: &cache_dir,
        reporters: &reporters,
        data_rate_limit: stare_cli::download::DEFAULT_DATA_RATE_LIMIT,
    };

    println!("Downloading into {}", cache_dir.display());
    let report = stare_cli::download::run(&cfg, |event| print_download_event(&event))?;

    println!();
    println!(
        "Done: {} volumes seen, {} bins downloaded ({} cached), {} zips downloaded ({} cached), {} downloaded",
        report.volumes_seen,
        report.bins_downloaded,
        report.bins_cached,
        report.zips_downloaded,
        report.zips_cached,
        config::format_bytes(report.bytes_downloaded),
    );
    if !report.errors.is_empty() {
        println!("\n{} error(s):", report.errors.len());
        for err in &report.errors {
            println!("  - {}", err);
        }
    }
    Ok(())
}

fn print_download_event(event: &stare_cli::download::Event) {
    use stare_cli::download::{Event, FileStatus};

    let status_char = |s: &FileStatus| match s {
        FileStatus::Cached => "=",
        FileStatus::Downloaded(_) => "↓",
        FileStatus::Error(_) => "✗",
    };

    match event {
        Event::ReporterMissing { reporter } => {
            println!("{}: not found in manifest, skipping", reporter);
        }
        Event::ReporterStart { reporter, volumes } => {
            println!("{}: {} volumes", reporter, volumes);
        }
        Event::Volume {
            reporter,
            volume,
            index,
            total,
            bin,
            zip,
        } => {
            println!(
                "  [{}/{}] {}/{}  bin {}  zip {}",
                index,
                total,
                reporter,
                volume,
                status_char(bin),
                status_char(zip),
            );
            if let FileStatus::Error(msg) = bin {
                println!("        bin error: {}", msg);
            }
            if let FileStatus::Error(msg) = zip {
                println!("        zip error: {}", msg);
            }
        }
        Event::ReporterDone { reporter } => {
            println!("{}: done", reporter);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sources(index: &std::path::Path) -> Sources {
        Sources {
            index: index.to_string_lossy().into_owned(),
            data: String::new(),
            manifest: std::cell::OnceCell::new(),
        }
    }

    /// Held by every test that points the cache at a temporary directory
    /// through the environment, which all tests share.
    static CACHE_ENV: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn index_files_resolve_through_the_manifest_base() {
        let _env = CACHE_ENV.lock().unwrap_or_else(|e| e.into_inner());
        let cache = tempfile::tempdir().unwrap();
        std::env::set_var("XDG_CACHE_HOME", cache.path());

        // A versioned index: the old build at the root, the live one under its base.
        let idx = tempfile::tempdir().unwrap();
        std::fs::write(
            idx.path().join("manifest.json"),
            r#"{"format": 2, "base": "v/v2026.10.03/", "reporters": {"a2d": ["31"]}}"#,
        )
        .unwrap();
        std::fs::create_dir_all(idx.path().join("a2d")).unwrap();
        std::fs::write(idx.path().join("a2d/31.bin"), b"old").unwrap();
        std::fs::create_dir_all(idx.path().join("v/v2026.10.03/a2d")).unwrap();
        std::fs::write(idx.path().join("v/v2026.10.03/a2d/31.bin"), b"new").unwrap();

        let src = sources(idx.path());
        assert_eq!(src.index_key("a2d/31.bin"), "v/v2026.10.03/a2d/31.bin");
        assert_eq!(fetch_bin(&src, "a2d", "31").unwrap(), b"new");
        // Cached under the versioned path, with the manifest beside it.
        assert_eq!(
            config::cache_get("bins", "v/v2026.10.03/a2d/31.bin").unwrap(),
            b"new"
        );
        assert!(config::cache_get("bins", "a2d/31.bin").is_none());
        assert!(config::cache_get("bins", stare_cli::MANIFEST_CACHE_KEY).is_some());

        // The source gone, the saved manifest still finds the cached file.
        let gone = sources(&idx.path().join("missing"));
        assert_eq!(gone.index_key("a2d/31.bin"), "v/v2026.10.03/a2d/31.bin");
        assert_eq!(fetch_bin(&gone, "a2d", "31").unwrap(), b"new");

        // A manifest without base, and no manifest at all, read the root.
        let fresh = tempfile::tempdir().unwrap();
        std::env::set_var("XDG_CACHE_HOME", fresh.path());
        std::fs::write(idx.path().join("manifest.json"), r#"{"a2d": [31]}"#).unwrap();
        assert_eq!(sources(idx.path()).index_key("a2d/31.bin"), "a2d/31.bin");
        let empty = tempfile::tempdir().unwrap();
        let cache2 = tempfile::tempdir().unwrap();
        std::env::set_var("XDG_CACHE_HOME", cache2.path());
        assert_eq!(sources(empty.path()).index_key("a2d/31.bin"), "a2d/31.bin");
    }

    const H1: &str = "0f3a9c2e7b1d4a65";

    /// A versioned build with the unified index and the old files beside it (the
    /// transition release), a CourtListener record beside the data source's `cap/`,
    /// and CAP zips for a2d 31:
    ///
    /// - a2d 31 page 647 has a CAP case and a CourtListener alias line;
    /// - a3d 250 is a volume only CourtListener has (two records at page 100);
    /// - a2d 31 is split, with pages from 700 in part 1.
    fn idx_fixture(with_idx: bool) -> (tempfile::TempDir, tempfile::TempDir, Sources) {
        use std::io::Write;
        let idx = tempfile::tempdir().unwrap();
        let idx_field = if with_idx { r#""idx": 1,"# } else { "" };
        std::fs::write(
            idx.path().join("manifest.json"),
            format!(
                r#"{{"format": 2, {idx_field} "base": "v/v1/",
                    "reporters": {{"a2d": ["31"], "a3d": ["250"]}}}}"#
            ),
        )
        .unwrap();
        let v = idx.path().join("v/v1");
        std::fs::create_dir_all(v.join("a2d")).unwrap();
        std::fs::create_dir_all(v.join("a3d")).unwrap();

        let zip = std::fs::read("../stare/tests/fixtures/a2d-31.zip").unwrap();
        let names = stare::case::list_cases_in_zip(&zip).unwrap();
        let keyed: Vec<(&str, usize)> = names
            .iter()
            .map(|n| (n.as_str(), n[..4].parse().unwrap()))
            .collect();
        let built = stare::index::build(&keyed);
        std::fs::write(v.join("a2d/31.bin"), &built.bin).unwrap();

        let mut entries =
            stare::idx::entries_from_bin(&built.bin, built.multi_file().as_deref(), None).unwrap();
        entries.push(stare::idx::Entry::cl(stare::index::PageKey::Number(647), 1, H1).unwrap());
        // Split before page 700, the way a big volume would be.
        let mut head = String::from("#parts,700\n");
        let mut tail = String::new();
        stare::idx::sort_entries(&mut entries);
        for e in &entries {
            let out = match e.page {
                stare::index::PageKey::Number(n) if n >= 700 => &mut tail,
                _ => &mut head,
            };
            out.push_str(&e.line());
            out.push('\n');
        }
        std::fs::write(v.join("a2d/31.idx.gz"), stare::idx::gzip(&head)).unwrap();
        std::fs::write(v.join("a2d/31.1.idx.gz"), stare::idx::gzip(&tail)).unwrap();
        std::fs::write(
            v.join("a3d/250.idx.gz"),
            stare::idx::gzip(&format!(
                "100,cl,9876543/{H1}\n100,cl,9876544/a1b2c3d4e5f60718\nbad line\n"
            )),
        )
        .unwrap();

        let data = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(data.path().join("cap/a2d")).unwrap();
        std::fs::write(data.path().join("cap/a2d/31.zip"), &zip).unwrap();
        let dir = data.path().join("cl/c/9876543");
        std::fs::create_dir_all(&dir).unwrap();
        let json = std::fs::read("../stare/tests/fixtures/cl-record.json").unwrap();
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        gz.write_all(&json).unwrap();
        std::fs::write(dir.join(format!("{H1}.json.gz")), gz.finish().unwrap()).unwrap();

        let src = Sources {
            index: idx.path().to_string_lossy().into_owned(),
            data: data.path().join("cap").to_string_lossy().into_owned(),
            manifest: std::cell::OnceCell::new(),
        };
        (idx, data, src)
    }

    #[test]
    fn the_unified_index_resolves_every_source() {
        let _env = CACHE_ENV.lock().unwrap_or_else(|e| e.into_inner());
        let cache = tempfile::tempdir().unwrap();
        std::env::set_var("XDG_CACHE_HOME", cache.path());
        let (_idx, _data, src) = idx_fixture(true);

        // A CAP page with a CourtListener alias line shows CAP's case.
        let result = resolve_case(&src, "a2d", "31", 647).unwrap();
        assert_eq!(result.case_file, "0647-01");
        assert_eq!(result.case.name_abbreviation, "D'Elia & Marks Co. v. Lyon");

        // A page past the split comes from the later part.
        let tail = stare::idx::parse_bytes(
            &std::fs::read(_idx.path().join("v/v1/a2d/31.1.idx.gz")).unwrap(),
        )
        .unwrap();
        let first = &tail.entries[0];
        let stare::index::PageKey::Number(page) = first.page else {
            unreachable!()
        };
        let r = resolve_case(&src, "a2d", "31", page as u32).unwrap();
        assert_eq!(r.case_file, first.reference);
        assert!(config::cache_get("bins", "v/v1/a2d/31.1.idx.gz").is_some());

        // A volume only CourtListener has: the first record at the page.
        let result = resolve_case(&src, "a3d", "250", 100).unwrap();
        assert_eq!(result.case_file, "cl/9876543");
        assert_eq!(result.case.source_name(), "courtlistener");
        assert_eq!(
            source_line(&result.case).as_deref(),
            Some("Source: CourtListener (export 2026-09-30)")
        );

        // A miss in a held volume is a miss, never another volume's case.
        let err = resolve_case(&src, "a3d", "250", 101).err().unwrap();
        assert!(
            format!("{err:#}").contains("no case at page 101"),
            "{err:#}"
        );

        // `stare check` counts both as held, and only the hit as found.
        assert_eq!(check_page(&src, "a3d", 250, 100), (true, true));
        assert_eq!(check_page(&src, "a3d", 250, 101), (true, false));
        assert_eq!(check_page(&src, "a2d", 31, 647), (true, true));
        assert_eq!(check_page(&src, "a2d", 99, 1), (false, false));
    }

    #[test]
    fn a_manifest_without_idx_reads_the_bin() {
        let _env = CACHE_ENV.lock().unwrap_or_else(|e| e.into_inner());
        let cache = tempfile::tempdir().unwrap();
        std::env::set_var("XDG_CACHE_HOME", cache.path());
        let (_idx, _data, src) = idx_fixture(false);

        let result = resolve_case(&src, "a2d", "31", 647).unwrap();
        assert_eq!(result.case_file, "0647-01");
        // Nothing reads the .idx.gz files the old manifest doesn't announce.
        assert!(config::cache_get("bins", "v/v1/a2d/31.idx.gz").is_none());
        // CourtListener cases need the unified index.
        assert!(resolve_case(&src, "a3d", "250", 100).is_err());
    }

    /// A statute with no link is a statute, not an unchecked case; one
    /// with a link is external, and an `Id.` to another of its sections a
    /// statute too. None of them touches the index.
    #[test]
    fn check_tells_statutes_from_cases() {
        let _env = CACHE_ENV.lock().unwrap_or_else(|e| e.into_inner());
        let cache = tempfile::tempdir().unwrap();
        std::env::set_var("XDG_CACHE_HOME", cache.path());
        let src = sources(tempfile::tempdir().unwrap().path());
        let detected = stare::cite::detect_citations(
            "See Conn. Gen. Stat. § 52-584; Minn. Stat. § 609.185. Id. § 609.19.",
        );
        let statuses: Vec<_> = detected
            .iter()
            .map(|c| (c.matched_text.as_str(), check_status(&src, c)))
            .collect();
        assert_eq!(
            statuses,
            [
                ("Conn. Gen. Stat. § 52-584", CheckStatus::Statute),
                ("Minn. Stat. § 609.185", CheckStatus::External),
                ("Id.", CheckStatus::Statute),
            ]
        );
    }

    /// #120 in `stare check`: a short form is looked up through its
    /// antecedent, never at its pin page, and one with no antecedent isn't
    /// looked up at all.
    #[test]
    fn check_looks_short_forms_up_through_their_antecedent() {
        let _env = CACHE_ENV.lock().unwrap_or_else(|e| e.into_inner());
        let cache = tempfile::tempdir().unwrap();
        std::env::set_var("XDG_CACHE_HOME", cache.path());

        // Roe starts at 1021 and Burnett v. State at 1023, Roe's pin page.
        let idx = tempfile::tempdir().unwrap();
        std::fs::write(
            idx.path().join("manifest.json"),
            r#"{"format": 2, "reporters": {"p2d": ["997"]}}"#,
        )
        .unwrap();
        std::fs::create_dir_all(idx.path().join("p2d")).unwrap();
        let built = stare::index::build(&[("1021-01", 1021usize), ("1023-01", 1023)]);
        std::fs::write(idx.path().join("p2d/997.bin"), &built.bin).unwrap();
        let src = sources(idx.path());

        let text = "Id. at 5. Roe v. Board of County Commissioners, 997 P.2d 1021 (Wyo. 2000). \
                    Roe, 997 P.2d at 1023. Id. at 1024. \
                    Axon Enterprise, Inc. v. FTC, 598 U.S. 175 (2023). Axon, 598 U.S. at 180.";
        let detected = stare::cite::detect_citations(text);
        let status = |raw: &str, ty: &str| {
            let c = detected
                .iter()
                .find(|c| c.matched_text == raw && c.citation_type == ty)
                .unwrap_or_else(|| panic!("no {ty} {raw}"));
            (check_status(&src, c), check_target(c).and_then(|t| t.page))
        };
        assert_eq!(
            status("997 P.2d at 1023", "ShortCaseCitation"),
            (CheckStatus::Found, Some("1021"))
        );
        let ids: Vec<_> = detected
            .iter()
            .filter(|c| c.citation_type == "IdCitation")
            .map(|c| (check_status(&src, c), c.pin.as_deref()))
            .collect();
        assert_eq!(
            ids,
            [
                (CheckStatus::NoAntecedent, Some("5")),
                (CheckStatus::Found, Some("1024")),
            ]
        );
        // The antecedent is a volume stare.pub doesn't hold: the short cite
        // links out with it.
        assert_eq!(
            status("598 U.S. at 180", "ShortCaseCitation"),
            (CheckStatus::NotHeld, Some("175"))
        );
    }
}
