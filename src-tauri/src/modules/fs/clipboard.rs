//! Spills clipboard payloads (pasted screenshots) to disk so they can be
//! handed to a terminal agent as a plain file path.

use std::io::Write;
use std::path::PathBuf;
use std::time::SystemTime;

/// Cap a single pasted image. Screenshots are well under this; the limit keeps
/// a runaway clipboard from filling the disk.
const MAX_IMAGE_BYTES: usize = 32 * 1024 * 1024;

/// Files older than this are swept on the next paste, so the directory does
/// not grow without bound across sessions.
const MAX_AGE_SECS: u64 = 24 * 60 * 60;

fn paste_dir() -> Result<PathBuf, String> {
    let base = dirs::cache_dir()
        .ok_or_else(|| "could not resolve the user cache directory".to_string())?;
    let dir = base.join("terax").join("pasted");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("create paste directory {}: {e}", dir.display()))?;
    Ok(dir)
}

/// Drop stale pastes. Best-effort: a failure here must never block a paste.
fn sweep_old(dir: &std::path::Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let now = SystemTime::now();
    for entry in entries.flatten() {
        let stale = entry
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|m| now.duration_since(m).ok())
            .is_some_and(|age| age.as_secs() >= MAX_AGE_SECS);
        if stale {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// Only image types we are willing to name; anything else is rejected so a
/// caller cannot choose an arbitrary extension.
fn extension_for(mime: &str) -> Option<&'static str> {
    match mime.trim().to_ascii_lowercase().as_str() {
        "image/png" => Some("png"),
        "image/jpeg" | "image/jpg" => Some("jpg"),
        "image/gif" => Some("gif"),
        "image/webp" => Some("webp"),
        "image/bmp" => Some("bmp"),
        "image/svg+xml" => Some("svg"),
        "image/avif" => Some("avif"),
        _ => None,
    }
}

/// Write clipboard image bytes to a private cache file and return its path.
/// The frontend pastes that path into the terminal, which is what CLI agents
/// (Claude Code) expect for an image attachment.
#[tauri::command]
pub async fn fs_save_clipboard_image(request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let mime = request
        .headers()
        .get("x-image-mime")
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| "missing clipboard image MIME header".to_string())?;
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("clipboard image requires a raw body".to_string());
    };
    if bytes.is_empty() {
        return Err("clipboard image is empty".to_string());
    }
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err(format!(
            "clipboard image is {} MB, over the {} MB limit",
            bytes.len() / (1024 * 1024),
            MAX_IMAGE_BYTES / (1024 * 1024)
        ));
    }
    let ext =
        extension_for(mime).ok_or_else(|| format!("unsupported clipboard image type: {mime}"))?;
    let bytes = bytes.clone();
    super::blocking(move || save_image(&bytes, ext)).await
}

fn save_image(bytes: &[u8], ext: &str) -> Result<String, String> {
    let dir = paste_dir()?;
    sweep_old(&dir);
    let mut temp = tempfile::Builder::new()
        .prefix("paste-")
        .suffix(&format!(".{ext}"))
        .tempfile_in(&dir)
        .map_err(|e| format!("create temp file: {e}"))?;
    temp.write_all(bytes)
        .map_err(|e| format!("write clipboard image: {e}"))?;
    temp.as_file()
        .sync_all()
        .map_err(|e| format!("sync clipboard image: {e}"))?;
    let (_file, path) = temp
        .keep()
        .map_err(|e| format!("publish clipboard image: {}", e.error))?;

    Ok(super::to_canon(&path))
}

/// Paths of files copied in a file manager (Explorer's CF_HDROP), so a
/// terminal paste can turn them into arguments. Empty when the clipboard
/// holds something else. The web Clipboard API cannot see this format, which
/// is why it has to be read natively.
#[tauri::command]
pub async fn fs_clipboard_file_paths() -> Result<Vec<String>, String> {
    super::blocking(read_windows_clipboard_files).await
}

fn read_windows_clipboard_files() -> Result<Vec<String>, String> {
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::System::DataExchange::{
        CloseClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard,
    };
    use windows_sys::Win32::System::Ole::CF_HDROP;
    use windows_sys::Win32::UI::Shell::{DragQueryFileW, HDROP};

    /// Closes the clipboard however this function exits.
    struct ClipboardGuard;
    impl Drop for ClipboardGuard {
        fn drop(&mut self) {
            unsafe {
                CloseClipboard();
            }
        }
    }

    unsafe {
        if IsClipboardFormatAvailable(CF_HDROP as u32) == 0 {
            return Ok(Vec::new());
        }
        if OpenClipboard(std::ptr::null_mut()) == 0 {
            // Another process holds the clipboard; treat as "no files" rather
            // than failing the paste.
            return Ok(Vec::new());
        }
        let _guard = ClipboardGuard;

        let handle: HANDLE = GetClipboardData(CF_HDROP as u32);
        if handle.is_null() {
            return Ok(Vec::new());
        }
        let hdrop = handle as HDROP;

        // 0xFFFF_FFFF asks for the count rather than a path.
        let count = DragQueryFileW(hdrop, 0xFFFF_FFFF, std::ptr::null_mut(), 0);
        if count > 1024 {
            return Err("clipboard has more than 1024 file paths".to_string());
        }
        let mut paths = Vec::with_capacity(count as usize);
        let mut total_units = 0usize;
        for index in 0..count {
            let len = DragQueryFileW(hdrop, index, std::ptr::null_mut(), 0);
            if len == 0 {
                continue;
            }
            total_units += len as usize;
            if len > 32768 || total_units > 1024 * 1024 {
                return Err("clipboard file paths exceed the size limit".to_string());
            }
            // +1 for the NUL that DragQueryFileW writes.
            let mut buf = vec![0u16; len as usize + 1];
            let written = DragQueryFileW(hdrop, index, buf.as_mut_ptr(), buf.len() as u32);
            if written == 0 {
                continue;
            }
            buf.truncate(written as usize);
            let path = std::ffi::OsString::from_wide(&buf);
            paths.push(super::to_canon(std::path::Path::new(&path)));
        }
        Ok(paths)
    }
}
