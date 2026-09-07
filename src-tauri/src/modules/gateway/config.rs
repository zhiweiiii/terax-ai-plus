//! Relay definitions and the credential that guards the local gateway.

use std::fs;
use std::path::PathBuf;
use std::sync::{OnceLock, RwLock};

use serde::{Deserialize, Serialize};

/// The wire format a relay speaks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApiFormat {
    /// Native Anthropic Messages. Bodies pass through untouched.
    Anthropic,
    /// OpenAI Chat Completions. Bodies are converted in both directions.
    OpenaiChat,
}

/// How a relay wants its credential presented. It cannot be inferred from the
/// format: OpenCode Zen serves Anthropic on `/zen/go` but silently ignores a
/// Bearer header there and only honours `x-api-key`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthStyle {
    Bearer,
    ApiKey,
}

/// Upstream model per Claude Code role. An empty field falls back to
/// `default`, and an empty `default` passes the requested name through.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelRoutes {
    #[serde(default)]
    pub default: String,
    #[serde(default)]
    pub opus: String,
    #[serde(default)]
    pub sonnet: String,
    #[serde(default)]
    pub haiku: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Provider {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub api_key: String,
    pub api_format: ApiFormat,
    pub auth_style: AuthStyle,
    #[serde(default)]
    pub models: ModelRoutes,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    #[serde(default)]
    pub providers: Vec<Provider>,
    #[serde(default)]
    pub current: Option<String>,
}

impl Config {
    pub fn current_provider(&self) -> Option<&Provider> {
        let id = self.current.as_deref()?;
        self.providers.iter().find(|p| p.id == id)
    }
}

fn state() -> &'static RwLock<Config> {
    static STATE: OnceLock<RwLock<Config>> = OnceLock::new();
    STATE.get_or_init(|| RwLock::new(Config::default()))
}

pub fn replace(config: Config) {
    *state().write().expect("gateway config lock") = config;
}

pub fn current_provider() -> Option<Provider> {
    state()
        .read()
        .expect("gateway config lock")
        .current_provider()
        .cloned()
}

/// Look one up by the id carried in the request path. This is what keeps two
/// terminals independent: each shell was pointed at its own provider's URL, so
/// selecting a different one elsewhere cannot redirect a session already
/// running.
pub fn provider_by_id(id: &str) -> Option<Provider> {
    state()
        .read()
        .expect("gateway config lock")
        .providers
        .iter()
        .find(|provider| provider.id == id)
        .cloned()
}

impl Provider {
    /// The upstream URL for an Anthropic Messages request.
    pub fn messages_url(&self) -> String {
        let base = self.base_url.trim().trim_end_matches('/');
        match self.api_format {
            ApiFormat::Anthropic => join_once(base, "/v1/messages"),
            ApiFormat::OpenaiChat => join_once(base, "/chat/completions"),
        }
    }

    /// OpenCode Zen's Go plan rejects any request without `x-opencode-session`
    /// ("cannot be routed efficiently"), which it uses to keep a conversation on
    /// one backend. Matched on the host because the requirement belongs to that
    /// service, not to the wire format.
    pub fn wants_session_header(&self) -> bool {
        self.base_url.to_ascii_lowercase().contains("opencode.ai")
    }

    /// Resolve what Claude Code asked for into what this relay serves.
    pub fn upstream_model(&self, requested: &str) -> String {
        let requested = strip_context_marker(requested);
        let by_role = match role_of(requested) {
            Some("opus") => self.models.opus.trim(),
            Some("sonnet") => self.models.sonnet.trim(),
            Some("haiku") => self.models.haiku.trim(),
            _ => "",
        };
        for candidate in [by_role, self.models.default.trim()] {
            if !candidate.is_empty() {
                return candidate.to_string();
            }
        }
        requested.to_string()
    }
}

/// Append `suffix` unless the base already ends with it, which is what happens
/// when a user pastes a full endpoint into the base URL field.
fn join_once(base: &str, suffix: &str) -> String {
    let lower = base.to_ascii_lowercase();
    if lower.ends_with(suffix) {
        return base.to_string();
    }
    // `/v1/messages` under a base that already ends in `/v1` would double the
    // version segment.
    if let Some(tail) = suffix.strip_prefix("/v1") {
        if lower.ends_with("/v1") {
            return format!("{base}{tail}");
        }
    }
    format!("{base}{suffix}")
}

/// Claude Code appends `[1m]` to declare a 1M context window. It is a client
/// side marker and upstreams reject it as part of a model name.
fn strip_context_marker(model: &str) -> &str {
    let model = model.trim();
    let marker = "[1m]";
    if model.len() >= marker.len()
        && model[model.len() - marker.len()..].eq_ignore_ascii_case(marker)
    {
        return model[..model.len() - marker.len()].trim_end();
    }
    model
}

/// Claude Code also asks for dated full names such as
/// `claude-haiku-4-5-20251001`, so match on the role word rather than equality.
fn role_of(model: &str) -> Option<&'static str> {
    let model = model.to_ascii_lowercase();
    ["opus", "haiku", "sonnet"]
        .into_iter()
        .find(|role| model.contains(role))
}

fn token_path() -> Option<PathBuf> {
    let dir = dirs::data_local_dir()?.join("terax");
    fs::create_dir_all(&dir).ok()?;
    Some(dir.join("gateway-token"))
}

/// The bearer value Claude Code must present. Persisted so a shell configured
/// before a restart keeps working; without that every restart would silently
/// break every open terminal.
pub fn token() -> String {
    static TOKEN: OnceLock<String> = OnceLock::new();
    TOKEN
        .get_or_init(|| {
            let path = token_path();
            if let Some(existing) = path
                .as_ref()
                .and_then(|p| fs::read_to_string(p).ok())
                .map(|text| text.trim().to_string())
                .filter(|text| !text.is_empty())
            {
                return existing;
            }
            let mut bytes = [0u8; 16];
            getrandom::fill(&mut bytes).expect("os random source");
            let token: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
            if let Some(path) = path {
                let _ = fs::write(path, &token);
            }
            token
        })
        .clone()
}
