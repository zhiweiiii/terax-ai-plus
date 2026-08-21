//! Encrypt a small secret so it can sit in an ordinary settings file.
//!
//! The agent-parameter panel keeps a history of configurations so they can be
//! re-applied with one click, and one of the fields is an API token. Ordinary
//! preferences are plain JSON on disk and are mirrored between windows, so
//! putting a token in there as-is would write a live credential in the clear.
//!
//! DPAPI is the Windows answer: the ciphertext is bound to the current user
//! account, so the file is useless to anyone else on the machine and to anyone
//! who copies it off. It is not protection against code running as the user -
//! nothing local is - but it is the difference between "a token in a text file"
//! and "a token".
//!
//! Values cross the IPC boundary base64-encoded. Nothing here is logged.

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;

#[cfg(windows)]
mod dpapi {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB,
    };

    fn blob(data: &mut [u8]) -> CRYPT_INTEGER_BLOB {
        CRYPT_INTEGER_BLOB {
            cbData: data.len() as u32,
            pbData: data.as_mut_ptr(),
        }
    }

    /// Copy a blob the API allocated, then hand its memory back.
    unsafe fn take(out: CRYPT_INTEGER_BLOB) -> Vec<u8> {
        let copied = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();
        LocalFree(out.pbData as *mut std::ffi::c_void);
        copied
    }

    pub fn protect(plain: &str) -> Result<Vec<u8>, String> {
        let mut input = plain.as_bytes().to_vec();
        let in_blob = blob(&mut input);
        let mut out_blob = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: std::ptr::null_mut(),
        };
        let ok = unsafe {
            CryptProtectData(
                &in_blob,
                std::ptr::null(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                0,
                &mut out_blob,
            )
        };
        if ok == 0 {
            return Err("加密失败".into());
        }
        Ok(unsafe { take(out_blob) })
    }

    pub fn unprotect(cipher: &[u8]) -> Result<String, String> {
        let mut input = cipher.to_vec();
        let in_blob = blob(&mut input);
        let mut out_blob = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: std::ptr::null_mut(),
        };
        let ok = unsafe {
            CryptUnprotectData(
                &in_blob,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                0,
                &mut out_blob,
            )
        };
        if ok == 0 {
            return Err("解密失败，凭据可能来自其他用户账户".into());
        }
        let bytes = unsafe { take(out_blob) };
        String::from_utf8(bytes).map_err(|_| "凭据不是有效文本".to_string())
    }
}

/// Encrypt a secret for storage. Returns base64 ciphertext.
#[tauri::command]
pub fn secret_protect(value: String) -> Result<String, String> {
    #[cfg(windows)]
    {
        dpapi::protect(&value).map(|bytes| B64.encode(bytes))
    }
    #[cfg(not(windows))]
    {
        let _ = value;
        Err("此平台不支持凭据加密".into())
    }
}

/// Decrypt a stored secret. Takes base64 ciphertext.
#[tauri::command]
pub fn secret_unprotect(value: String) -> Result<String, String> {
    #[cfg(windows)]
    {
        let bytes = B64.decode(value).map_err(|_| "凭据格式无效".to_string())?;
        dpapi::unprotect(&bytes)
    }
    #[cfg(not(windows))]
    {
        let _ = value;
        Err("此平台不支持凭据加密".into())
    }
}
