//! The JSON Schemas for the index build's reports and the reporter map, compiled in from the repo's
//! `schemas/` directory, which stays their source. They are published-format
//! specs: stare.pub's `/data` page reads both files, and the index builder,
//! which writes them, validates what it writes against these at the stare rev it pins.

/// `schemas/index-report.v1.schema.json`: `/index/v/<version>/report.json`, one index
/// build's report, format 1.
pub const INDEX_REPORT_V1: &str = include_str!("../../../schemas/index-report.v1.schema.json");

/// `schemas/reports-index.v1.schema.json`: `/index/reports/index.json`, every published
/// build's report totals, format 1.
pub const REPORTS_INDEX_V1: &str = include_str!("../../../schemas/reports-index.v1.schema.json");

/// `schemas/reporters.v1.schema.json`: `stare.pub/reporters.json`, the reporter map
/// ([`crate::reporters`]), format 1.
pub const REPORTERS_V1: &str = include_str!("../../../schemas/reporters.v1.schema.json");

/// [`REPORTERS_V1`]'s `$id`, which `reporters.json` names as its `$schema`.
pub const REPORTERS_V1_ID: &str = "https://stare.pub/schemas/reporters.v1.schema.json";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_schema_parses_and_names_its_file_and_format() {
        for (schema, file) in [
            (INDEX_REPORT_V1, "index-report.v1.schema.json"),
            (REPORTS_INDEX_V1, "reports-index.v1.schema.json"),
            (REPORTERS_V1, "reporters.v1.schema.json"),
        ] {
            let value: serde_json::Value = serde_json::from_str(schema).unwrap();
            assert_eq!(
                value["$id"],
                format!("https://stare.pub/schemas/{file}"),
                "{file}"
            );
            assert_eq!(value["properties"]["format"]["const"], 1, "{file}");
        }
    }
}
