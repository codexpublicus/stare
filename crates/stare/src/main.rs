use anyhow::Context;
use clap::{Parser, Subcommand};
use std::path::PathBuf;

#[derive(Parser)]
#[command(name = "stare", about = "Citation resolution for U.S. case law")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Build .bin index from a zip file
    BuildIndex {
        /// Path to the volume zip file
        zip_path: PathBuf,
        /// Output path for the .bin file
        #[arg(short, long)]
        output: Option<PathBuf>,
    },
    /// Resolve a citation to case text
    Resolve {
        /// Reporter slug (e.g., a2d, us, f2d)
        reporter: String,
        /// Volume number
        volume: u32,
        /// Page number
        page: u32,
        /// Base path for local data files
        #[arg(long, default_value = ".")]
        data_dir: PathBuf,
    },
}

fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();

    match cli.command {
        Commands::BuildIndex { zip_path, output } => {
            let zip_bytes = std::fs::read(&zip_path)
                .with_context(|| format!("failed to read {}", zip_path.display()))?;
            let cases = stare::case::list_cases_in_zip(&zip_bytes)?;
            let case_pages: Vec<(&str, usize)> = cases
                .iter()
                .map(|c| {
                    let page: usize = c.split('-').next().unwrap().parse().unwrap();
                    (c.as_str(), page)
                })
                .collect();
            let bin_data = stare::index::build(&case_pages);

            let out_path = output.unwrap_or_else(|| zip_path.with_extension("bin"));
            std::fs::write(&out_path, &bin_data)
                .with_context(|| format!("failed to write {}", out_path.display()))?;

            println!(
                "Built index: {} cases, {} bytes → {}",
                cases.len(),
                bin_data.len(),
                out_path.display()
            );
        }
        Commands::Resolve {
            reporter,
            volume,
            page,
            data_dir,
        } => {
            let result = stare::resolve::resolve_local(&data_dir, &reporter, volume, page)?;

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
    }

    Ok(())
}
