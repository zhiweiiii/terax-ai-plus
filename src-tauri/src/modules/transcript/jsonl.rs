use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicI64, Ordering},
    Arc, Mutex,
};
use std::time::SystemTime;

use super::Transcript;

static REVISION: AtomicI64 = AtomicI64::new(1);
const CACHE_LIMIT: usize = 8;
const MAX_RECORD_BYTES: u64 = 16 * 1024 * 1024;

pub(super) trait JsonlState: Default + Send {
    fn ingest(&mut self, text: &str);
    fn snapshot(&self, session_id: String, revision: i64) -> Option<Transcript>;
}

#[derive(PartialEq, Eq, Clone)]
struct Mark {
    length: u64,
    modified: Option<SystemTime>,
    created: Option<SystemTime>,
}

struct Entry<S> {
    state: S,
    session_id: Option<String>,
    offset: u64,
    mark: Option<Mark>,
    snapshot: Option<Arc<Transcript>>,
    used: std::time::Instant,
    revision: i64,
}

impl<S: Default> Default for Entry<S> {
    fn default() -> Self {
        Self {
            state: S::default(),
            session_id: None,
            offset: 0,
            mark: None,
            snapshot: None,
            used: std::time::Instant::now(),
            revision: 0,
        }
    }
}

pub(super) struct ReaderCache<S> {
    entries: Mutex<HashMap<PathBuf, Arc<Mutex<Entry<S>>>>>,
}

impl<S: JsonlState> ReaderCache<S> {
    pub fn new() -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
        }
    }

    pub fn read(
        &self,
        path: &Path,
        session_id: impl FnOnce() -> Option<String>,
    ) -> Option<Arc<Transcript>> {
        let entry = {
            let mut entries = self.entries.lock().ok()?;
            if !entries.contains_key(path) && entries.len() >= CACHE_LIMIT {
                let oldest = entries
                    .iter()
                    .filter_map(|(path, entry)| {
                        entry.try_lock().ok().map(|e| (e.used, path.clone()))
                    })
                    .min_by_key(|(used, _)| *used)
                    .map(|(_, path)| path);
                if let Some(oldest) = oldest {
                    entries.remove(&oldest);
                } else {
                    return None;
                }
            }
            entries
                .entry(path.to_path_buf())
                .or_insert_with(|| Arc::new(Mutex::new(Entry::default())))
                .clone()
        };
        let mut entry = entry.lock().ok()?;
        entry.used = std::time::Instant::now();
        let metadata = fs::metadata(path).ok()?;
        let mark = Mark {
            length: metadata.len(),
            modified: metadata.modified().ok(),
            created: metadata.created().ok(),
        };
        if entry.mark.as_ref() == Some(&mark) {
            return entry.snapshot.clone();
        }
        if entry.mark.as_ref().is_some_and(|old| {
            mark.length < old.length
                || mark.created != old.created
                || (mark.length == old.length && mark.modified != old.modified)
        }) {
            entry.state = S::default();
            entry.session_id = None;
            entry.offset = 0;
            entry.snapshot = None;
        }
        let mut file = File::open(path).ok()?;
        file.seek(SeekFrom::Start(entry.offset)).ok()?;
        let mut reader = BufReader::new(file.take(mark.length.saturating_sub(entry.offset)));
        let mut bytes = Vec::new();
        let mut consumed = 0u64;
        loop {
            bytes.clear();
            let size = Read::by_ref(&mut reader)
                .take(MAX_RECORD_BYTES + 1)
                .read_until(b'\n', &mut bytes)
                .ok()?;
            if size == 0 {
                break;
            }
            if bytes.last() != Some(&b'\n') {
                if size as u64 <= MAX_RECORD_BYTES {
                    break;
                }
                let mut skipped = 0u64;
                let mut complete = false;
                loop {
                    let chunk = reader.fill_buf().ok()?;
                    if chunk.is_empty() {
                        break;
                    }
                    let end = chunk.iter().position(|byte| *byte == b'\n');
                    let count = end.map_or(chunk.len(), |index| index + 1);
                    skipped += count as u64;
                    reader.consume(count);
                    if end.is_some() {
                        complete = true;
                        break;
                    }
                }
                if !complete {
                    break;
                }
                consumed += size as u64 + skipped;
                entry.offset += size as u64 + skipped;
                log::warn!("transcript: skipped record exceeding size limit");
                continue;
            }
            consumed += size as u64;
            entry.offset += size as u64;
            if let Ok(text) = std::str::from_utf8(&bytes) {
                entry.state.ingest(text);
            }
        }
        if consumed == 0 && entry.snapshot.is_some() {
            entry.mark = Some(mark);
            return entry.snapshot.clone();
        }
        let id = entry.session_id.clone().or_else(session_id)?;
        entry.session_id = Some(id.clone());
        entry.revision = REVISION.fetch_add(1, Ordering::Relaxed);
        entry.snapshot = entry.state.snapshot(id, entry.revision).map(Arc::new);
        entry.mark = Some(mark);
        entry.snapshot.clone()
    }
}

pub(super) fn compact_steps(
    steps: &mut Vec<super::Message>,
    pending: &mut HashMap<String, (usize, usize)>,
) {
    const MAX_STEPS: usize = 600;
    if steps.len() <= MAX_STEPS {
        return;
    }
    let removed = steps.len() - MAX_STEPS;
    steps.drain(..removed);
    pending.retain(|_, (index, _)| {
        if *index < removed {
            return false;
        }
        *index -= removed;
        true
    });
}
