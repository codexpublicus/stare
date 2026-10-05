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
    let key = src.index_key(&format!("{}/{}.multi", reporter, volume));
    if let Some(data) = config::cache_get("bins", &key) {
        return Ok(Some(String::from_utf8(data)?));
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
    Ok(Some(String::from_utf8(data)?))
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

/// Resolve a citation to `volume` (a cited number or a CAP folder name). The volume's
/// own folder is tried first; only when the page isn't there is the manifest consulted
/// for the other parts of a volume CAP split over several folders.
fn resolve_case(
    src: &Sources,
    reporter: &str,
    volume: &str,
    page: u32,
) -> Result<stare::resolve::CaseResult> {
    let read = |v: &str| fetch_bin(src, reporter, v);
    let located = match stare::manifest::locate(&[volume.to_string()], page, read) {
        Ok(found) => found,
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
            })?
        }
    };
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

/// Resolve a case on an unnumbered page (`xxix`, `Supp. 1`) of a volume folder.
fn resolve_label(
    src: &Sources,
    reporter: &str,
    volume: &str,
    label: &str,
) -> Result<stare::resolve::CaseResult> {
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
            case_links: &a.case_links,
        });
    }
    Some(CheckTarget {
        slug: slug_for(&c.harvard_slug, &c.reporter),
        reporter: c.reporter.as_deref(),
        volume: c.volume.as_deref().and_then(|v| v.parse().ok()),
        page: c.page.as_deref(),
        external_url: c.external_url.as_deref(),
        case_links: &c.case_links,
    })
}

/// Whether stare.pub holds `volume` of `slug`, and whether a case starts at
/// `page` in it (or in another part of a volume CAP split).
fn check_page(src: &Sources, slug: &str, volume: u32, page: u32) -> (bool, bool) {
    let cited = volume.to_string();
    let mut candidates = vec![cited.clone()];
    if let Some(m) = src.manifest() {
        for v in m.candidates(slug, &cited, page) {
            if !candidates.contains(&v) {
                candidates.push(v);
            }
        }
    }
    let found = stare::manifest::locate(&candidates, page, |v| fetch_bin(src, slug, v)).is_ok();
    let held = found
        || src.manifest().is_some_and(|m| {
            m.has_volume(slug, &cited) || m.parts.get(slug).is_some_and(|p| p.contains_key(&cited))
        })
        || fetch_bin(src, slug, &cited).is_ok();
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
            CheckStatus::Unchecked
        } else {
            CheckStatus::External
        };
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

    if json {
        println!("{}", serde_json::to_string_pretty(&citations)?);
    } else {
        println!(
            "Found {} citations ({} resolvable)\n",
            citations.len(),
            resolvable_count
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
