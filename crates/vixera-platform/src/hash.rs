//! SHA-256 for document identity. Files are streamed so multi-GB PDFs never load into memory.

use serde::Serialize;
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileHash {
    /// Lowercase hex SHA-256 digest.
    pub sha256: String,
    pub size: u64,
}

#[derive(Debug, thiserror::Error)]
pub enum HashError {
    #[error("cannot hash {path}: {source}")]
    Io { path: PathBuf, #[source] source: std::io::Error },
}

/// Lowercase hex SHA-256 of `bytes`.
pub fn sha256_bytes(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

/// Stream `path` through SHA-256; returns the hex digest and the byte count actually read.
pub fn sha256_file(path: &Path) -> Result<FileHash, HashError> {
    let io = |source| HashError::Io { path: path.to_path_buf(), source };
    let mut file = std::fs::File::open(path).map_err(io)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 256 * 1024];
    let mut size: u64 = 0;
    loop {
        let n = file.read(&mut buf).map_err(io)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        size += n as u64;
    }
    Ok(FileHash { sha256: hex::encode(hasher.finalize()), size })
}

#[cfg(test)]
mod tests {
    use super::*;

    const ABC: &str = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
    const EMPTY: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

    #[test]
    fn known_vectors() {
        assert_eq!(sha256_bytes(b"abc"), ABC);
        assert_eq!(sha256_bytes(b""), EMPTY);
    }

    #[test]
    fn file_hash_matches_bytes_and_reports_size() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("abc.txt");
        std::fs::write(&path, b"abc").unwrap();
        let h = sha256_file(&path).unwrap();
        assert_eq!(h.sha256, ABC);
        assert_eq!(h.size, 3);

        // Larger than one read buffer: streaming must agree with one-shot hashing.
        let big: Vec<u8> = (0..(600 * 1024)).map(|i| (i % 251) as u8).collect();
        let big_path = dir.path().join("big.bin");
        std::fs::write(&big_path, &big).unwrap();
        let hb = sha256_file(&big_path).unwrap();
        assert_eq!(hb.sha256, sha256_bytes(&big));
        assert_eq!(hb.size, big.len() as u64);
    }

    #[test]
    fn missing_file_is_an_io_error_with_path() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nope.pdf");
        let err = sha256_file(&path).unwrap_err();
        assert!(err.to_string().contains("nope.pdf"));
    }
}
