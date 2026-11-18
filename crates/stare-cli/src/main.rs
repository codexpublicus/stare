use anyhow::{bail, Context, Result};
use clap::{Parser, Subcommand};
use stare::config;
use stare_cli::engine::check::{CheckReport, CheckStatus, CheckedCitation};
use stare_cli::engine::resolve::source_line;
use stare_cli::engine::Sources;

#[derive(Parser)]
#[command(name = "stare", version, about = "Look up U.S. case law by citation")]
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
    /// Install and check a self-hosted copy of stare.pub from a signed mirror release
    Mirror {
        #[command(subcommand)]
        action: MirrorAction,
    },
    /// Serve the Model Context Protocol over stdin and stdout, for agents
    #[cfg(feature = "mcp")]
    Mcp {
        /// Read this index build (v2026.10.22) instead of the live one
        #[arg(long)]
        index_version: Option<String>,
    },
}

#[derive(Subcommand)]
enum MirrorAction {
    /// Install a new copy from the newest signed release: download, check both signatures
    /// and every hash, extract, and check every file
    Install {
        /// The copy's directory; it must not exist yet, or be empty
        root: std::path::PathBuf,
        /// The tier to install (tier 1 is the site and the citation index)
        #[arg(long, default_value_t = 1)]
        tier: u32,
        /// Install this release (v2026.11.11) instead of the one latest.json names
        #[arg(long)]
        release: Option<String>,
        /// Another release base to fetch from first: an https:// URL or a directory laid
        /// out like https://data.stare.pub/releases/ (repeatable)
        #[arg(long = "origin")]
        origins: Vec<String>,
        /// Fetch only from the --origin bases, never from stare.pub's origins
        #[arg(long)]
        only_origins: bool,
        #[command(flatten)]
        key: MirrorKey,
    },
    /// Rehash every file of a copy against its installed release
    Verify {
        /// The copy's directory
        root: std::path::PathBuf,
        #[command(flatten)]
        key: MirrorKey,
    },
    /// Show a copy's release, and the files missing from it or not in its release
    Scan {
        /// The copy's directory
        root: std::path::PathBuf,
        #[command(flatten)]
        key: MirrorKey,
    },
}

#[derive(clap::Args)]
struct MirrorKey {
    /// Check signatures with this minisign public key instead of stare.pub's release key
    #[arg(long, value_name = "FILE")]
    pubkey: Option<std::path::PathBuf>,
}

impl MirrorKey {
    fn load(&self) -> Result<stare_cli::mirror::release::Key> {
        match &self.pubkey {
            Some(p) => stare_cli::mirror::release::Key::from_file(p),
            None => Ok(stare_cli::mirror::release::Key::release()),
        }
    }
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

fn main() -> Result<()> {
    let cli = Cli::parse();
    let json = cli.json;
    let src = Sources::from_config(cli.index.clone(), cli.data.clone());

    match cli.command {
        Commands::Resolve { citation } => {
            let result = stare_cli::engine::resolve::resolve_input(&src, &citation.join(" "))?;
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
        Commands::Mirror { action } => mirror(action, json)?,
        #[cfg(feature = "mcp")]
        Commands::Mcp { index_version } => stare_cli::mcp::serve_stdio(stare_cli::mcp::Options {
            index: cli.index.clone(),
            data: cli.data.clone(),
            index_version,
        })?,
    }

    Ok(())
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
    if let Some(via) = &result.via {
        println!("{}", stare::idx::via_label(via));
    }
    if let Some(blocked) = result
        .case
        .source
        .as_ref()
        .and_then(|s| s.cl_blocked.as_ref())
    {
        println!("{}", blocked.notice());
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

fn list_cases(src: &Sources, reporter: &str, volume: &str, json: bool) -> Result<()> {
    let metadata = stare_cli::engine::case_text::read_cases_metadata(src, reporter, volume)?;

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
    let report = stare_cli::engine::check::check_text(src, &text);
    if json {
        println!("{}", report.to_json()?);
    } else {
        print_report(&report);
    }
    Ok(())
}

/// `stare check`'s listing: a summary line, then each cited case, resolvable ones
/// first, with its other forms under it.
fn print_report(report: &CheckReport) {
    let citations = &report.citations;
    let grouping = &report.grouping;
    let primaries = &report.primaries;
    let review = match report.needs_review {
        0 => String::new(),
        1 => ", 1 needs review".to_string(),
        n => format!(", {n} need review"),
    };
    println!(
        "Found {} cited cases ({} resolvable), {} statutes{}\n",
        report.cited_cases(),
        report.resolvable,
        report.statutes,
        review
    );
    // Resolvable cases first, as the site lists them.
    let mut order: Vec<usize> = (0..primaries.len()).collect();
    order.sort_by_key(|&g| {
        let c = &citations[primaries[g]];
        match (c.resolvable, c.status) {
            (true, _) => 0,
            (_, CheckStatus::External) => 1,
            (_, CheckStatus::NotHeld) => 2,
            (_, CheckStatus::Statute) => 3,
            _ => 4,
        }
    });
    for g in order {
        let primary = primaries[g];
        let members = &grouping.groups[g].members;
        // Each form's own places, when the case was cited in more than one.
        let form_count = |i: usize| (members.len() > 1).then(|| grouping.entry_counts[i]);
        print!("  ");
        print_checked(&citations[primary], form_count(primary));
        match grouping.groups[g].count {
            0 | 1 => println!(),
            n => println!("  ({n}× in the text)"),
        }
        for &i in members.iter().filter(|&&i| i != primary) {
            print!("      ");
            print_checked(&citations[i], form_count(i));
            println!();
        }
    }
}

/// One listed citation's line in `stare check`, without the newline: with `form_count`,
/// the places that cite its case in this form (`261 Conn. 941 (1×)`).
fn print_checked(c: &CheckedCitation, form_count: Option<usize>) {
    let mark = match c.status {
        CheckStatus::Found | CheckStatus::FoundAlias | CheckStatus::FoundPartner => "✓",
        CheckStatus::External | CheckStatus::NotHeld => "↗",
        CheckStatus::NoAntecedent => "·",
        _ => "✗",
    };
    print!("{} {}", mark, c.raw);
    if let Some(n) = form_count {
        print!(" ({n}×)");
    }
    if let Some(a) = &c.antecedent {
        print!("  (refers to {}", a);
        if let Some(pin) = &c.pin {
            print!(", at {}", pin);
        }
        print!(")");
    }
    match c.status {
        CheckStatus::External => print!("  → {}", c.external_url.as_deref().unwrap_or("")),
        CheckStatus::HeldMiss => print!(
            "  → no case found at this page in {} vol. {}",
            c.reporter.as_deref().or(c.slug.as_deref()).unwrap_or(""),
            c.volume.map_or("null".to_string(), |v| v.to_string())
        ),
        CheckStatus::FoundAlias => {
            if let Some(via) = &c.via {
                print!("  ({})", stare::idx::via_label(via));
            }
        }
        CheckStatus::FoundPartner => {
            if let Some(partner) = &c.partner {
                print!("  (reported at {partner}, inferred from the citing text)");
            }
        }
        CheckStatus::Statute => print!("  (statute; no free source linked yet)"),
        // Nothing checks that the case is there (citare#39).
        CheckStatus::NotHeld => {
            if let Some(link) = c.case_links.first() {
                print!("  → not in stare.pub, may be at {}", link.url);
            }
        }
        CheckStatus::NoAntecedent => {
            print!("  (refers to an earlier citation that couldn't be identified)")
        }
        _ => {}
    }
    if let Some(b) = &c.by_name {
        print!("  ({})", b.note);
    }
    if !c.conflicts.is_empty() {
        let others: Vec<&str> = c.conflicts.iter().map(String::as_str).collect();
        print!(
            "  (cited in parallel with {}, which {} a different case; needs review)",
            others.join(" and "),
            if others.len() > 1 { "open" } else { "opens" }
        );
    }
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

fn mirror(action: MirrorAction, json: bool) -> Result<()> {
    use stare_cli::mirror::copy;
    match action {
        MirrorAction::Install {
            root,
            tier,
            release,
            origins,
            only_origins,
            key,
        } => {
            let report = copy::install(
                &root,
                copy::InstallOptions {
                    tier,
                    release,
                    origins,
                    only_origins,
                    key: key.load()?,
                    log: Box::new(|m| eprintln!("{m}")),
                },
            )?;
            if json {
                println!("{}", serde_json::to_string_pretty(&report)?);
            } else {
                println!(
                    "{}: release {} (sequence {}), tier {}, data as of {}, {} files, {} bytes",
                    report.root.display(),
                    report.release,
                    report.sequence,
                    report.tier,
                    report.data_date,
                    report.files,
                    report.bytes
                );
            }
        }
        MirrorAction::Verify { root, key } => {
            let report = copy::verify(&root, &key.load()?)?;
            if json {
                println!("{}", serde_json::to_string_pretty(&report)?);
            } else if report.problems == 0 {
                println!(
                    "{}: all {} files match release {} (sequence {})",
                    report.root.display(),
                    report.files,
                    report.release,
                    report.sequence
                );
            } else {
                for p in &report.listed {
                    println!("{p}");
                }
                if report.problems > report.listed.len() {
                    println!("... and {} more", report.problems - report.listed.len());
                }
            }
            if report.problems > 0 {
                bail!(
                    "{} of {} files in {} don't match release {}",
                    report.problems,
                    report.files,
                    report.root.display(),
                    report.release
                );
            }
        }
        MirrorAction::Scan { root, key } => {
            let report = copy::scan(&root, &key.load()?)?;
            if json {
                println!("{}", serde_json::to_string_pretty(&report)?);
                return Ok(());
            }
            println!(
                "{}: release {} (sequence {}), tier {}, data as of {}",
                report.root.display(),
                report.release,
                report.sequence,
                report
                    .tiers
                    .iter()
                    .map(|t| t.to_string())
                    .collect::<Vec<_>>()
                    .join(", "),
                report.data_date
            );
            for c in &report.components {
                let state = match (c.missing, c.wrong_size) {
                    (0, 0) => "complete".to_string(),
                    (m, w) => format!("{m} missing, {w} at the wrong size"),
                };
                println!(
                    "  {:<13} {:<16} {:>7} files  {}",
                    c.id, c.version, c.files, state
                );
            }
            for m in &report.missing {
                println!("  {m}");
            }
            if report.extra.is_empty() {
                println!("no files outside the release");
            } else {
                println!(
                    "{} files ({} bytes) not in the release, e.g.:",
                    report.extra.len(),
                    report.extra_bytes
                );
                for e in report.extra.iter().take(copy::MAX_LISTED) {
                    println!("  {e}");
                }
            }
        }
    }
    Ok(())
}
