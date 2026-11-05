//! `stare mcp`: an MCP server over stdio for agents that write or review legal text
//! (#162, design accepted as D148). It reads only the
//! static files stare.pub publishes, or a mirror of them, through the same engine as
//! `stare resolve` and `stare check`, and shares their cache.
//!
//! The engine is synchronous; each tool call runs on tokio's blocking pool.

pub mod cursor;
pub mod error;
pub mod meta;
pub mod refs;
pub mod schema;
pub mod session;
pub mod text;
pub mod tools;

use rmcp::model::{
    CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, Implementation,
    ListToolsResult, PaginatedRequestParams, ServerCapabilities, ServerConfig,
};
use rmcp::service::RequestContext;
use rmcp::{ErrorData as McpError, RoleServer, ServerHandler, ServiceExt};
use serde_json::{json, Value};
use std::sync::Arc;

pub use session::Options;

/// What the server tells a client at initialize.
const INSTRUCTIONS: &str = "stare checks U.S. case law citations against stare.pub's index (the Caselaw Access Project's cases and CourtListener's records) and reads the cases. Before presenting, filing or relying on text with case citations, run check_brief on the whole text. For each citation that supports a proposition, read the case with get_case and find (the quoted or paraphrased words) and compare the excerpt with the claim. held_miss is the strongest sign of a fabricated or mistyped citation; not_held means unverified, not false; found_alias and found_partner are found, with a provenance label to quote, and nothing is ever 'verified'. stare.pub has no treatment, history or citator data: never claim a case is still good law. Each result's meta names the index version and the licence of every source it used.";

/// The server: one session, pinned to one index build.
#[derive(Clone)]
pub struct StareServer {
    session: Arc<session::Session>,
}

impl StareServer {
    pub fn new(options: Options) -> Self {
        StareServer {
            session: Arc::new(session::Session::new(options)),
        }
    }

    /// Run tool `name` on `args` on this thread: the answer as a tool result, or None
    /// for an unknown tool, or `Err` for arguments that don't match its schema.
    pub fn call_blocking(&self, name: &str, args: Value) -> Option<Result<CallToolResult, String>> {
        let before = crate::engine::fetch::requests_sent();
        let mut call = tools::Call::new(&self.session);
        let outcome = tools::call(&mut call, name, args)?;
        let answer = match outcome {
            Ok(answer) => answer,
            Err(schema) => return Some(Err(schema)),
        };
        let cached = crate::engine::fetch::requests_sent() == before;
        let meta = meta::meta(call.pin.as_deref(), cached, call.sources);
        Some(Ok(match answer {
            Ok(a) => {
                let mut structured = a.structured;
                structured["meta"] = meta;
                let mut r = CallToolResult::structured(structured);
                r.content = vec![ContentBlock::text(a.text)];
                r
            }
            Err(e) => {
                let mut text = format!("{}: {}", e.code.as_str(), e.message);
                if let Some(url) = &e.url {
                    text.push_str(&format!(" ({url})"));
                }
                let mut r = CallToolResult::structured_error(json!({ "error": e, "meta": meta }));
                r.content = vec![ContentBlock::text(text)];
                r
            }
        }))
    }

    /// Pin the index build now, so the first lookup doesn't wait for it. A failure is
    /// left for the first tool that needs the index to report.
    pub fn pin_blocking(&self) {
        if let Err(e) = self.session.pin() {
            eprintln!(
                "stare mcp: index not pinned yet: {}: {}",
                e.code.as_str(),
                e.message
            );
        }
    }
}

impl ServerHandler for StareServer {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(
                Implementation::new("stare", meta::SERVER_VERSION)
                    .with_title("stare.pub citations")
                    .with_website_url("https://stare.pub"),
            )
            .with_instructions(INSTRUCTIONS)
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, McpError> {
        Ok(ListToolsResult::with_all_items(schema::tools()))
    }

    fn get_tool(&self, name: &str) -> Option<rmcp::model::Tool> {
        schema::tools().into_iter().find(|t| t.name == name)
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, McpError> {
        let server = self.clone();
        let name = request.name.to_string();
        let args = Value::Object(request.arguments.unwrap_or_default());
        let result = tokio::task::spawn_blocking(move || server.call_blocking(&name, args))
            .await
            .map_err(|e| McpError::internal_error(format!("tool panicked: {e}"), None))?;
        match result {
            None => Err(McpError::invalid_params(
                format!("unknown tool: {}", request.name),
                None,
            )),
            Some(Err(schema)) => Err(McpError::invalid_params(
                format!(
                    "arguments don't match {}'s input schema: {schema}",
                    request.name
                ),
                None,
            )),
            Some(Ok(result)) => Ok(result.into()),
        }
    }
}

/// `stare mcp`: serve over stdin and stdout until the client closes them. Logs go to
/// stderr.
pub fn serve_stdio(options: Options) -> anyhow::Result<()> {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    runtime.block_on(async move {
        let server = StareServer::new(options);
        {
            let s = server.clone();
            tokio::task::spawn_blocking(move || s.pin_blocking());
        }
        let running = server
            .serve(rmcp::transport::stdio())
            .await
            .map_err(|e| anyhow::anyhow!("stare mcp: {e}"))?;
        running
            .waiting()
            .await
            .map_err(|e| anyhow::anyhow!("stare mcp: {e}"))?;
        anyhow::Ok(())
    })
}
