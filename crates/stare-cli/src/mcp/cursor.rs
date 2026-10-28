//! Cursors (design, "Response sizing"): opaque base64 of what a read is of, where the
//! next page starts, and the index version it was read from. A cursor from another
//! index version is refused with `stale_cursor`, never applied to different data.

use super::error::{Code, ToolError, ToolResult};
use base64::Engine;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Cursor {
    /// The tool that made it.
    pub tool: String,
    /// What it reads: a case ref and opinion for `get_case`, a hash of the text for
    /// `check_brief`.
    pub of: String,
    /// Where the next page starts: a character offset, or an item index.
    pub offset: usize,
    /// The index version it was made under; None before the session had one.
    pub version: Option<String>,
}

impl Cursor {
    pub fn encode(&self) -> String {
        let json = serde_json::to_vec(self).expect("a cursor serializes");
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(json)
    }

    /// Read `cursor`, checking it is `tool`'s, of `of`, under `version`.
    pub fn decode(cursor: &str, tool: &str, of: &str, version: Option<&str>) -> ToolResult<Self> {
        let bad = || ToolError::new(Code::BadInput, "cursor is not one this server made");
        let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(cursor.trim())
            .map_err(|_| bad())?;
        let c: Cursor = serde_json::from_slice(&bytes).map_err(|_| bad())?;
        if c.tool != tool {
            return Err(ToolError::new(
                Code::BadInput,
                format!("cursor is for {}, not {tool}", c.tool),
            ));
        }
        if c.version.as_deref() != version {
            return Err(ToolError::new(
                Code::StaleCursor,
                format!(
                    "cursor was made under index version {}, and the session now reads {}; start the read again",
                    c.version.as_deref().unwrap_or("none"),
                    version.unwrap_or("none")
                ),
            ));
        }
        if c.of != of {
            return Err(ToolError::new(
                Code::BadInput,
                "cursor is for another input; start the read again without it",
            ));
        }
        Ok(c)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_cursor_round_trips_and_refuses_another_version() {
        let c = Cursor {
            tool: "get_case".into(),
            of: "cap:a2d/31/0647-01#all".into(),
            offset: 20_000,
            version: Some("v2026.10.26.2".into()),
        };
        let s = c.encode();
        assert_eq!(
            Cursor::decode(&s, "get_case", &c.of, Some("v2026.10.26.2")).unwrap(),
            c
        );
        let stale = Cursor::decode(&s, "get_case", &c.of, Some("v2026.10.27")).unwrap_err();
        assert_eq!(stale.code, Code::StaleCursor);
        let other = Cursor::decode(&s, "check_brief", &c.of, Some("v2026.10.26.2")).unwrap_err();
        assert_eq!(other.code, Code::BadInput);
        assert_eq!(
            Cursor::decode("not base64!", "get_case", "", None)
                .unwrap_err()
                .code,
            Code::BadInput
        );
    }
}
