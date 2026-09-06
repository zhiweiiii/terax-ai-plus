use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use grep_regex::{RegexMatcher, RegexMatcherBuilder};
use grep_searcher::sinks::UTF8;
use grep_searcher::{BinaryDetection, SearcherBuilder};
use ignore::{WalkBuilder, WalkState};
use serde::Serialize;

use super::search::PRUNE_DIRS;
use super::{blocking, to_canon};
use crate::modules::workspace::{resolve_path, WorkspaceEnv};

const FILE_SIZE_CAP: u64 = 5 * 1024 * 1024;
const DEFAULT_MAX_RESULTS: usize = 200;
const HARD_MAX_RESULTS: usize = 2000;

/// Hard cap on files opened for one interactive query. Keeps a search rooted at
/// a huge tree from pinning the CPU long after the user stopped caring.
const MAX_FILES_SCANNED: usize = 20_000;

/// Threads the parallel walker may use. Deliberately below the core count:
/// saturating every core starves the webview and makes the whole app janky
/// while typing in the search box.
fn walk_threads() -> usize {
    let cores = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4);
    (cores.saturating_sub(1)).clamp(1, 4)
}

/// Supersession counter for interactive content search. Each new interactive
/// query bumps the generation; in-flight walks observe the change and quit,
/// so fast typing stops superseded searches server-side instead of letting
/// them run to completion.
#[derive(Default)]
pub struct ContentSearchState {
    generation: Arc<AtomicU64>,
}

#[derive(Serialize)]
pub struct GrepHit {
    pub path: String,
    pub rel: String,
    pub line: u64,
    pub text: String,
}

#[derive(Serialize)]
pub struct GrepResponse {
    pub hits: Vec<GrepHit>,
    pub truncated: bool,
    pub files_scanned: usize,
}

fn escape_literal(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 8);
    for c in s.chars() {
        if "\\.+*?()|[]{}^$".contains(c) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

#[allow(clippy::too_many_arguments)]
fn search_tree(
    root_path: &Path,
    root_display: &str,
    workspace: &WorkspaceEnv,
    matcher: &RegexMatcher,
    cap: usize,
    cancel: &(dyn Fn() -> bool + Sync),
) -> GrepResponse {
    let walker = WalkBuilder::new(root_path)
        .hidden(true)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .ignore(true)
        .parents(true)
        .follow_links(false)
        .threads(walk_threads())
        .filter_entry(|dent| {
            if dent.depth() == 0 {
                return true;
            }
            match dent.file_name().to_str() {
                Some(name) => !PRUNE_DIRS.contains(&name),
                None => true,
            }
        })
        .build_parallel();

    let hits: Arc<Mutex<Vec<GrepHit>>> = Arc::new(Mutex::new(Vec::new()));
    let scanned = Arc::new(AtomicUsize::new(0));
    let truncated = Arc::new(AtomicBool::new(false));

    walker.run(|| {
        let matcher = matcher.clone();
        let hits = hits.clone();
        let scanned = scanned.clone();
        let truncated = truncated.clone();
        let root_path = root_path.to_path_buf();
        let root_display = root_display.to_string();
        let workspace = workspace.clone();

        Box::new(move |dent_res| {
            if truncated.load(Ordering::Relaxed) || cancel() {
                return WalkState::Quit;
            }
            let dent = match dent_res {
                Ok(d) => d,
                Err(_) => return WalkState::Continue,
            };
            if !dent.file_type().map(|t| t.is_file()).unwrap_or(false) {
                return WalkState::Continue;
            }
            let path = dent.path();
            let rel = match path.strip_prefix(&root_path) {
                Ok(r) => to_canon(r),
                Err(_) => return WalkState::Continue,
            };
            if let Ok(meta) = std::fs::metadata(path) {
                if meta.len() > FILE_SIZE_CAP {
                    return WalkState::Continue;
                }
            }

            if scanned.fetch_add(1, Ordering::Relaxed) >= MAX_FILES_SCANNED {
                truncated.store(true, Ordering::Relaxed);
                return WalkState::Quit;
            }

            let abs = display_path(path, &root_path, &root_display, &workspace);
            let rel_clone = rel.clone();
            let mut searcher = SearcherBuilder::new()
                .binary_detection(BinaryDetection::quit(b'\x00'))
                .line_number(true)
                .build();

            let _ = searcher.search_path(
                &matcher,
                path,
                UTF8(|line_num, text| {
                    if cancel() {
                        return Ok(false);
                    }
                    let line_text = text.trim_end_matches('\n').to_string();
                    let mut guard = hits.lock().unwrap();
                    if guard.len() >= cap {
                        truncated.store(true, Ordering::Relaxed);
                        return Ok(false);
                    }
                    guard.push(GrepHit {
                        path: abs.clone(),
                        rel: rel_clone.clone(),
                        line: line_num,
                        text: line_text,
                    });
                    Ok(true)
                }),
            );

            WalkState::Continue
        })
    });

    let final_hits = Arc::try_unwrap(hits)
        .map(|m| m.into_inner().unwrap())
        .unwrap_or_default();

    GrepResponse {
        hits: final_hits,
        truncated: truncated.load(Ordering::Relaxed),
        files_scanned: scanned.load(Ordering::Relaxed),
    }
}

/// Interactive content search for the header search bar and command palette.
/// Treats the query as a literal (smart-case), and self-cancels when a newer
/// query arrives.
#[tauri::command]
pub async fn fs_grep_interactive(
    state: tauri::State<'_, ContentSearchState>,
    pattern: String,
    root: String,
    max_results: Option<usize>,
    workspace: Option<WorkspaceEnv>,
) -> Result<GrepResponse, String> {
    if pattern.trim().is_empty() {
        return Err("empty pattern".into());
    }
    let generation = state.generation.clone();
    let my_gen = generation.fetch_add(1, Ordering::SeqCst) + 1;

    let workspace = WorkspaceEnv::from_option(workspace);
    let root_path = resolve_path(&root, &workspace);
    if !root_path.is_dir() {
        return Err(format!("not a directory: {root}"));
    }
    let cap = max_results
        .unwrap_or(DEFAULT_MAX_RESULTS)
        .clamp(1, HARD_MAX_RESULTS);

    let matcher = RegexMatcherBuilder::new()
        .case_smart(true)
        .line_terminator(Some(b'\n'))
        .build(&escape_literal(&pattern))
        .map_err(|e| format!("bad pattern: {e}"))?;

    // The walk is CPU-bound and can take seconds on a large tree: it must never
    // run on the main thread, or every frame of the app stalls behind it.
    blocking(move || {
        let cancel = || generation.load(Ordering::SeqCst) != my_gen;
        Ok(search_tree(
            &root_path,
            &root,
            &workspace,
            &matcher,
            cap,
            &cancel,
        ))
    })
    .await
}

fn display_path(
    path: &std::path::Path,
    root_path: &std::path::Path,
    root_display: &str,
    workspace: &WorkspaceEnv,
) -> String {
    if workspace.is_wsl() {
        if let Ok(rel) = path.strip_prefix(root_path) {
            let rel = to_canon(rel);
            return if rel.is_empty() {
                root_display.to_string()
            } else if root_display.ends_with('/') {
                format!("{root_display}{rel}")
            } else {
                format!("{root_display}/{rel}")
            };
        }
    }
    to_canon(path)
}


