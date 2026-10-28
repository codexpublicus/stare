//! Tool errors (design, "Errors"): a tool result with `isError: true` and a structured
//! `error` the agent can act on. A miss is never one of these; `held_miss`, `not_held`,
//! `ambiguous` and `needs_review` are statuses in successful results.

use serde::Serialize;

/// The codes an agent sees, each with what it should do.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Code {
    /// Input that fails validation beyond the schema: fix the call.
    BadInput,
    /// citare finds no citation in `citation`: rephrase, or pass the parts.
    Unparsed,
    /// A `case_ref` that isn't one: use a ref from a result.
    BadRef,
    /// A cursor from another index version: restart the read.
    StaleCursor,
    /// A host unreachable with nothing cached, after the retries: retry later, or use a
    /// mirror.
    Network,
    /// `--offline` and not cached: report the URL to the user (M2).
    OfflineMiss,
    /// A mirror without that tier's files: use the public host.
    NotInCopy,
    /// A manifest format newer than this binary: update `stare`.
    IndexTooNew,
    /// A file that doesn't parse: report it.
    DataError,
}

impl Code {
    pub fn as_str(self) -> &'static str {
        match self {
            Code::BadInput => "bad_input",
            Code::Unparsed => "unparsed",
            Code::BadRef => "bad_ref",
            Code::StaleCursor => "stale_cursor",
            Code::Network => "network",
            Code::OfflineMiss => "offline_miss",
            Code::NotInCopy => "not_in_copy",
            Code::IndexTooNew => "index_too_new",
            Code::DataError => "data_error",
        }
    }

    /// Every code, for the schemas and the tests.
    pub const ALL: [Code; 9] = [
        Code::BadInput,
        Code::Unparsed,
        Code::BadRef,
        Code::StaleCursor,
        Code::Network,
        Code::OfflineMiss,
        Code::NotInCopy,
        Code::IndexTooNew,
        Code::DataError,
    ];
}

/// A tool error: its code, a message for the agent, and the URL the server would have
/// read, when there is one to report.
#[derive(Debug, Clone, Serialize)]
pub struct ToolError {
    pub code: Code,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

impl ToolError {
    pub fn new(code: Code, message: impl Into<String>) -> Self {
        ToolError {
            code,
            message: message.into(),
            url: None,
        }
    }

    pub fn with_url(mut self, url: impl Into<String>) -> Self {
        self.url = Some(url.into());
        self
    }

    /// An engine error as a tool error: `network` when a request failed, `not_in_copy`
    /// when a mirror directory lacks the file, else `data_error`.
    pub fn from_engine(err: &anyhow::Error, data_is_dir: bool) -> Self {
        let message = format!("{err:#}");
        for cause in err.chain() {
            if cause.downcast_ref::<reqwest::Error>().is_some() {
                return ToolError::new(Code::Network, message);
            }
            if let Some(io) = cause.downcast_ref::<std::io::Error>() {
                if io.kind() == std::io::ErrorKind::NotFound && data_is_dir {
                    return ToolError::new(Code::NotInCopy, message);
                }
            }
        }
        if message.contains("HTTP 5") || message.contains("HTTP 429") {
            return ToolError::new(Code::Network, message);
        }
        ToolError::new(Code::DataError, message)
    }
}

pub type ToolResult<T> = Result<T, ToolError>;
