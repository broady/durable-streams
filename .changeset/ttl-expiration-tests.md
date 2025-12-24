---
"@durable-streams/server-conformance-tests": minor
"@durable-streams/server": minor
---

Add TTL expiration conformance tests and implement expiration in stores

- Add 6 new conformance tests verifying streams return 404 after TTL/Expires-At passes
- Implement expiration checking in both in-memory and file-backed stores
- Expired streams are automatically deleted when accessed via any operation (GET, HEAD, POST, etc.)
