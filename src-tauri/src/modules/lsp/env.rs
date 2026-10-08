use std::path::PathBuf;

pub fn resolve_binary(command: &str) -> Option<PathBuf> {
    let command = command.trim();
    if command.is_empty() {
        return None;
    }
    which::which(command).ok()
}
