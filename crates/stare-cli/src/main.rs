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
    let key = format!("{}/{}.bin", reporter, volume);

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
    let key = format!("{}/{}.multi", reporter, volume);
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

/// Fetch the index manifest from the index source. Never cached: it changes when the
/// index is rebuilt.
fn fetch_manifest(src: &Sources) -> Result<stare::manifest::Manifest> {
    let bytes = if Sources::is_url(&src.index) {
        fetch_url(&format!("{}/manifest.json", src.index))?
    } else {
        let path = PathBuf::from(&src.index).join("manifest.json");
        std::fs::read(&path).with_context(|| format!("manifest not found: {}", path.display()))?
    };
    stare::manifest::Manifest::parse(&bytes)
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
            let Ok(manifest) = fetch_manifest(src) else {
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

    let mut citations = Vec::new();
    for c in &detected {
        let slug = c.harvard_slug.clone().unwrap_or_else(|| {
            c.reporter
                .as_deref()
                .unwrap_or("")
                .to_lowercase()
                .replace(['.', ' '], "")
        });
        let volume: u32 = c
            .volume
            .as_deref()
            .and_then(|v| v.parse().ok())
            .unwrap_or(0);
        // A blank page (`1 U.S. ___`) has `page: None` and nothing to look up.
        let resolvable = if !slug.is_empty() && volume > 0 && c.page.is_some() {
            fetch_bin(src, &slug, &volume.to_string()).is_ok()
        } else {
            false
        };

        citations.push(serde_json::json!({
            "raw": c.matched_text, "type": c.citation_type,
            "reporter": c.reporter, "slug": slug,
            "volume": volume, "page": c.page, "resolvable": resolvable,
            "external_url": c.external_url,
            "case_links": c.case_links,
        }));
    }

    let mut seen = std::collections::HashSet::new();
    citations.retain(|c| seen.insert(c["raw"].as_str().unwrap_or("").to_string()));
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
            let resolvable = c["resolvable"].as_bool().unwrap_or(false);
            let has_url = c["external_url"].as_str().is_some();
            let status = if resolvable {
                "✓"
            } else if has_url {
                "↗"
            } else {
                "✗"
            };
            print!("  {} {}", status, c["raw"].as_str().unwrap_or(""));
            if let Some(url) = c["external_url"].as_str() {
                print!("  → {}", url);
            } else if !resolvable {
                // A volume stare.pub doesn't hold: point at the first place that
                // may have the case. Nothing checks that it does (citare#39).
                if let Some(url) = c["case_links"][0]["url"].as_str() {
                    print!("  → not in stare.pub, may be at {}", url);
                }
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
