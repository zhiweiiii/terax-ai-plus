//! The web bridge's access credential, and where it lives.
//!
//! It used to be a compile-time constant: an XOR-obfuscated SHA-1 digest baked
//! into the binary, which meant the password could not be changed without a
//! rebuild. Obfuscation is not secrecy either - anyone who can run the code can
//! recover the bytes.
//!
//! So the credential is stored instead, and stored properly:
//!
//! - **Argon2id, not SHA-1.** This guards a remote shell. An unsalted fast hash
//!   sitting in a file is exactly what an offline cracker wants; a memory-hard
//!   KDF with a per-password salt is not. The stored form is a PHC string, so
//!   the algorithm and its parameters travel with the hash and can be changed
//!   later without guessing what produced an old value.
//! - **The cookie token is regenerated with every password change.** The token
//!   used to be a second constant that never rotated, and the cookie it sets
//!   lasts a week - so changing the password would have locked nobody out.
//!   Rotating it is what makes a change mean something.
//!
//! Until a password is set the compile-time constant still answers, so an
//! existing install keeps working and nobody is locked out by an update.

use std::fs;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use serde::{Deserialize, Serialize};

/// What is on disk. Only the verifier and the session token: the password
/// itself is never written anywhere, in any form that can be reversed.
#[derive(Serialize, Deserialize, Clone)]
struct StoredCredential {
    /// Argon2 PHC string (`$argon2id$v=19$m=...,t=...,p=...$salt$hash`).
    hash: String,
    /// Session token for the `terax_web` cookie. New on every password change,
    /// which is what invalidates phones that were already signed in.
    token: String,
}

fn credential_path() -> Option<PathBuf> {
    let dir = dirs::data_local_dir()?.join("terax");
    fs::create_dir_all(&dir).ok()?;
    Some(dir.join("web-auth.json"))
}

fn cache() -> &'static Mutex<Option<Option<StoredCredential>>> {
    static CACHE: OnceLock<Mutex<Option<Option<StoredCredential>>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

/// Read the stored credential, caching the result. The outer Option is "have
/// we looked yet", the inner is "is there one".
fn stored() -> Option<StoredCredential> {
    let mut guard = cache().lock().unwrap();
    if let Some(hit) = guard.as_ref() {
        return hit.clone();
    }
    let loaded = credential_path()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|text| serde_json::from_str::<StoredCredential>(&text).ok());
    *guard = Some(loaded.clone());
    loaded
}

fn invalidate_cache() {
    *cache().lock().unwrap() = None;
}

/// Whether the user has set their own password, as opposed to still running on
/// the one compiled in. Drives what the settings page offers.
pub fn has_custom_password() -> bool {
    stored().is_some()
}

/// Check a password from the login form.
pub fn verify(password: &str) -> bool {
    match stored() {
        Some(cred) => {
            let Ok(parsed) = PasswordHash::new(&cred.hash) else {
                return false;
            };
            Argon2::default()
                .verify_password(password.as_bytes(), &parsed)
                .is_ok()
        }
        // No stored credential yet: fall back to the compile-time digest so an
        // install that predates this keeps working.
        None => super::legacy_password_matches(password),
    }
}

/// The value the `terax_web` cookie carries.
pub fn session_token() -> String {
    stored().map(|c| c.token).unwrap_or_else(super::legacy_token)
}

/// Replace the password. Returns an error string suitable for showing to the
/// user; nothing here is logged, because everything here is a secret.
pub fn set_password(password: &str) -> Result<(), String> {
    if password.chars().count() < MIN_PASSWORD_CHARS {
        return Err(format!("密码至少需要 {MIN_PASSWORD_CHARS} 个字符"));
    }
    // Salt from the OS source directly: argon2 only exposes its own RNG helper
    // when rand_core's std feature is on, and `getrandom` is already a
    // dependency here.
    let mut salt_bytes = [0u8; 16];
    getrandom::fill(&mut salt_bytes).map_err(|_| "无法读取系统随机源".to_string())?;
    let salt = SaltString::encode_b64(&salt_bytes)
        .map_err(|_| "无法生成密码盐".to_string())?;
    let hash = Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map_err(|_| "无法生成密码哈希".to_string())?
        .to_string();

    let cred = StoredCredential {
        hash,
        token: random_token(),
    };
    let path = credential_path().ok_or_else(|| "找不到可写的配置目录".to_string())?;
    let body = serde_json::to_string(&cred).map_err(|_| "无法序列化凭据".to_string())?;
    fs::write(&path, body).map_err(|e| format!("无法写入凭据文件：{e}"))?;
    invalidate_cache();
    Ok(())
}

/// Short enough to type on a phone, long enough not to be brute-forced through
/// a rate-limited form.
const MIN_PASSWORD_CHARS: usize = 6;

/// 32 hex characters from the OS random source. The token is a bearer value:
/// whoever holds it is signed in, so it must not be derived from the password.
fn random_token() -> String {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).expect("os random source");
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
