Loopback-only TLS test certificate and non-secret test private key.

Self-signed for 127.0.0.1; valid 2026-10-08 through 2036-10-05. Never use
these files for production, real accounts, or external services. They are
not bundled with the application. The transport test trusts this certificate
only for its local HTTPS server, without disabling TLS verification.

Keeping fixed test materials avoids requiring OpenSSL on a developer's PATH.
