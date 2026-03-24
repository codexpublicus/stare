use anyhow::Context;
use clap::{Parser, Subcommand};
use std::path::PathBuf;

#[derive(Parser)]
#[command(name = "stare", about = "Look up U.S. case law by citation")]
struct Cli {
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
        /// Directory containing .bin index files (default: ./data)
        #[arg(long, default_value = "data")]
        index_dir: PathBuf,
        /// Base URL for fetching zip files (default: static.case.law)
        #[arg(long, default_value = stare::resolve::DEFAULT_BASE_URL)]
        base_url: String,
        /// Use local zip files instead of fetching remotely
        #[arg(long)]
        local: bool,
        /// Output as JSON
        #[arg(long)]
        json: bool,
    },
    /// List all cases in a volume
    List {
        /// Reporter slug (e.g., a2d, us, f2d)
        reporter: String,
        /// Volume number
        volume: u32,
        /// Base URL for fetching zip files
        #[arg(long, default_value = stare::resolve::DEFAULT_BASE_URL)]
        base_url: String,
        /// Output as JSON
        #[arg(long)]
        json: bool,
    },
    /// Check citations in a text file
    Check {
        /// Path to text file (or - for stdin)
        file: String,
        /// Directory containing .bin index files (default: ./data)
        #[arg(long, default_value = "data")]
        index_dir: PathBuf,
        /// Output as JSON
        #[arg(long)]
        json: bool,
    },
}

fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();

    match cli.command {
        Commands::Resolve {
            reporter,
            volume,
            page,
            index_dir,
            base_url,
            local,
            json,
        } => {
            let result = if local {
                stare::resolve::resolve_local(&index_dir, &reporter, volume, page)?
            } else {
                stare::resolve::resolve_remote(&index_dir, &base_url, &reporter, volume, page)?
            };

            if json {
                println!("{}", serde_json::to_string_pretty(&result.case)?);
            } else {
                print_case(&result);
            }
        }
        Commands::List {
            reporter,
            volume,
            base_url,
            json,
        } => {
            list_cases(&reporter, volume, &base_url, json)?;
        }
        Commands::Check {
            file,
            index_dir,
            json,
        } => {
            check_citations(&file, &index_dir, json)?;
        }
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

fn list_cases(reporter: &str, volume: u32, base_url: &str, json: bool) -> anyhow::Result<()> {
    let url = format!("{}/{}/{}.zip", base_url, reporter, volume);
    let client = reqwest::blocking::Client::builder()
        .user_agent("stare/0.1.0 (case law tool; github.com/lokkju/codex-publicus)")
        .build()?;
    let response = client.get(&url).send()
        .with_context(|| format!("failed to fetch {}", url))?;
    if !response.status().is_success() {
        anyhow::bail!("HTTP {} fetching {}", response.status(), url);
    }
    let zip_bytes = response.bytes()?.to_vec();

    let metadata = stare::case::extract_cases_metadata(&zip_bytes)?;

    if json {
        println!("{}", serde_json::to_string_pretty(&metadata)?);
    } else {
        println!("{} vol. {} — {} cases\n", reporter, volume, metadata.len());
        for entry in &metadata {
            let cite = entry.citations.first().map(|c| c.cite.as_str()).unwrap_or("");
            println!(
                "  {}  {}  (pp. {}-{})",
                entry.file_name,
                entry.name_abbreviation,
                entry.first_page,
                entry.last_page
            );
            if !cite.is_empty() {
                println!("        {}", cite);
            }
        }
    }

    Ok(())
}

fn check_citations(file: &str, index_dir: &std::path::Path, json: bool) -> anyhow::Result<()> {
    let text = if file == "-" {
        use std::io::Read;
        let mut buf = String::new();
        std::io::stdin().read_to_string(&mut buf)?;
        buf
    } else {
        std::fs::read_to_string(file)
            .with_context(|| format!("failed to read {}", file))?
    };

    // Simple regex citation detection (will be replaced by citare)
    let re = regex::Regex::new(r"(\d{1,4})\s+([A-Z][A-Za-z.]+(?:\s+\d+[a-z]{1,2})?(?:\.\d+[a-z]{0,2})?)\s+(\d{1,4})")?;

    let mut citations = Vec::new();
    for cap in re.captures_iter(&text) {
        let raw = cap[0].to_string();
        let volume: u32 = cap[1].parse().unwrap_or(0);
        let reporter = cap[2].trim().to_string();
        let page: u32 = cap[3].parse().unwrap_or(0);

        // Guess slug
        let slug = reporter.to_lowercase().replace('.', "").replace(' ', "");

        // Check if .bin exists locally
        let bin_path = index_dir.join(&slug).join(format!("{}.bin", volume));
        let resolvable = bin_path.exists();

        citations.push(serde_json::json!({
            "raw": raw,
            "reporter": reporter,
            "slug": slug,
            "volume": volume,
            "page": page,
            "resolvable": resolvable,
        }));
    }

    // Deduplicate by raw
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
