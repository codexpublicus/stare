use anyhow::{bail, Context, Result};
use clap::{Parser, Subcommand};
use std::path::PathBuf;
use stare::config;

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
        /// Reporter slug (e.g., a2d, us, f2d)
        reporter: String,
        /// Volume number
        volume: u32,
        /// Page number
        page: u32,
    },
    /// List all cases in a volume
    List {
        /// Reporter slug (e.g., a2d, us, f2d)
        reporter: String,
        /// Volume number
        volume: u32,
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
}

#[derive(Subcommand)]
enum ConfigAction {
    /// Show current configuration
    Show,
    /// Set a config value (key: index, data)
    Set {
        key: String,
        value: String,
    },
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
            index: cli.index.clone()
                .unwrap_or_else(|| cfg.index_source().to_string()),
            data: cli.data.clone()
                .unwrap_or_else(|| cfg.data_source().to_string()),
        }
    }

    fn is_url(s: &str) -> bool {
        s.starts_with("http://") || s.starts_with("https://") || s.starts_with("ipfs://")
    }
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    let json = cli.json;
    let src = Sources::from_cli(&cli);

    match cli.command {
        Commands::Resolve { reporter, volume, page } => {
            let result = resolve_case(&src, &reporter, volume, page)?;
            if json {
                println!("{}", serde_json::to_string_pretty(&result.case)?);
            } else {
                print_case(&result);
            }
        }
        Commands::List { reporter, volume } => {
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
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Fetch helpers — check cache first, then source (path or URL)
// ---------------------------------------------------------------------------

fn fetch_bin(src: &Sources, reporter: &str, volume: u32) -> Result<Vec<u8>> {
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
            std::fs::read(&path)
                .with_context(|| format!("index not found: {}", path.display()))?
        }
    } else {
        bail!("No index source configured. Run: stare config set index <path-or-url>");
    };

    // Cache for next time
    let _ = config::cache_set("bins", &key, &data);
    Ok(data)
}

fn fetch_zip(src: &Sources, reporter: &str, volume: u32) -> Result<Vec<u8>> {
    let key = format!("{}/{}.zip", reporter, volume);

    if let Some(data) = config::cache_get("zips", &key) {
        return Ok(data);
    }

    let source = &src.data;
    let data = if Sources::is_url(source) {
        fetch_url(&format!("{}/{}", source, key))?
    } else {
        let path = PathBuf::from(source).join(&key);
        std::fs::read(&path)
            .with_context(|| format!("zip not found: {}", path.display()))?
    };

    let _ = config::cache_set("zips", &key, &data);
    Ok(data)
}

fn fetch_url(url: &str) -> Result<Vec<u8>> {
    let client = reqwest::blocking::Client::builder()
        .user_agent("stare/0.1.0 (case law tool; github.com/lokkju/codex-publicus)")
        .build()?;
    let response = client.get(url).send()
        .with_context(|| format!("failed to fetch {}", url))?;
    if !response.status().is_success() {
        bail!("HTTP {} fetching {}", response.status(), url);
    }
    Ok(response.bytes()?.to_vec())
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

fn resolve_case(src: &Sources, reporter: &str, volume: u32, page: u32) -> Result<stare::resolve::CaseResult> {
    let bin_data = fetch_bin(src, reporter, volume)?;
    let case_file = stare::index::lookup(&bin_data, page as usize)
        .with_context(|| format!("no case at page {} in {}/{}", page, reporter, volume))?;
    let zip_data = fetch_zip(src, reporter, volume)?;
    let case = stare::case::extract_from_zip(&zip_data, case_file)?;
    Ok(stare::resolve::CaseResult {
        case_file: case_file.to_string(),
        case,
    })
}

fn print_case(result: &stare::resolve::CaseResult) {
    let cite = result.case.citations.first().map(|c| c.cite.as_str()).unwrap_or("—");
    println!("{}", result.case.name_abbreviation);
    println!("{}  |  {}  |  {}", cite, result.case.decision_date, result.case.court.name);
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

fn list_cases(src: &Sources, reporter: &str, volume: u32, json: bool) -> Result<()> {
    let zip_data = fetch_zip(src, reporter, volume)?;
    let metadata = stare::case::extract_cases_metadata(&zip_data)?;

    if json {
        println!("{}", serde_json::to_string_pretty(&metadata)?);
    } else {
        println!("{} vol. {} — {} cases\n", reporter, volume, metadata.len());
        for entry in &metadata {
            let cite = entry.citations.first().map(|c| c.cite.as_str()).unwrap_or("");
            println!("  {}  {}  (pp. {}-{})", entry.file_name, entry.name_abbreviation, entry.first_page, entry.last_page);
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
            c.reporter.as_deref().unwrap_or("").to_lowercase().replace('.', "").replace(' ', "")
        });
        let volume: u32 = c.volume.as_deref().and_then(|v| v.parse().ok()).unwrap_or(0);
        let resolvable = if !slug.is_empty() && volume > 0 {
            fetch_bin(src, &slug, volume).is_ok()
        } else {
            false
        };

        citations.push(serde_json::json!({
            "raw": c.matched_text, "type": c.citation_type,
            "reporter": c.reporter, "slug": slug,
            "volume": volume, "page": c.page, "resolvable": resolvable,
        }));
    }

    let mut seen = std::collections::HashSet::new();
    citations.retain(|c| seen.insert(c["raw"].as_str().unwrap_or("").to_string()));
    let resolvable_count = citations.iter().filter(|c| c["resolvable"].as_bool().unwrap_or(false)).count();

    if json {
        println!("{}", serde_json::to_string_pretty(&citations)?);
    } else {
        println!("Found {} citations ({} resolvable)\n", citations.len(), resolvable_count);
        for c in &citations {
            let status = if c["resolvable"].as_bool().unwrap_or(false) { "✓" } else { "✗" };
            println!("  {} {}", status, c["raw"].as_str().unwrap_or(""));
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
    println!("  index = {}", cfg.index_source().is_empty().then(|| "(not set)").unwrap_or(cfg.index_source()));
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
        println!("  {:5}  {:>5} files  {:>10}", s.kind, s.count, config::format_bytes(s.total_bytes));
    }
    println!("  ─────────────────────────────");
    println!("  total  {:>5} files  {:>10}", total_count, config::format_bytes(total_bytes));
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
