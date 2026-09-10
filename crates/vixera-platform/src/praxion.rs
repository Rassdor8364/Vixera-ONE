//! Fast loopback probe for the Praxion local connector.
//!
//! This is only a hint ("something is listening on 127.0.0.1:47815"). The
//! versioned contract negotiation (`GET /v1/health`, `X-Praxion-Contract`) is
//! done over HTTP by `@vixera/praxion` in TypeScript; a positive probe never
//! means Praxion is compatible, and a negative probe lets the UI skip a request.

use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::time::Duration;

pub const PRAXION_DEFAULT_HOST: &str = "127.0.0.1";
pub const PRAXION_DEFAULT_PORT: u16 = 47815;

/// True when a TCP connection to `host:port` succeeds within `timeout`.
/// Only loopback hosts are probed; anything else returns `false` without connecting.
pub fn is_port_open(host: &str, port: u16, timeout: Duration) -> bool {
    let Ok(addrs) = (host, port).to_socket_addrs() else {
        return false;
    };
    let loopback: Vec<SocketAddr> = addrs.filter(|a| a.ip().is_loopback()).collect();
    loopback
        .iter()
        .any(|addr| TcpStream::connect_timeout(addr, timeout).is_ok())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn detects_a_listening_loopback_port() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(is_port_open("127.0.0.1", port, Duration::from_millis(300)));
        drop(listener);
        assert!(!is_port_open("127.0.0.1", port, Duration::from_millis(300)));
    }

    #[test]
    fn refuses_non_loopback_hosts() {
        assert!(!is_port_open("example.com", 80, Duration::from_millis(50)));
        assert!(!is_port_open("10.0.0.1", 47815, Duration::from_millis(50)));
    }
}
