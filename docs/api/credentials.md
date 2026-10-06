# Platform credential status (ADR-056)

Na Pista calls the UL Platform **on the organization's behalf** (entitlements, usage) with a Platform credential
stored encrypted in Na Pista. You can check its state:

```http
GET /v1/organizations/{organizationId}/platform-credential
Authorization: Bearer <OWNER or ADMIN user token>
```

```json
{ "data": { "configured": true, "status": "ACTIVE", "createdAt": "…", "updatedAt": "…", "revokedAt": null } }
```

| `configured` | `status` | Meaning | Effect on the API |
| --- | --- | --- | --- |
| `false` | `null` | No credential has been set up for this organization | Business routes fail closed: `503 UPSTREAM_UNAVAILABLE` |
| `true` | `ACTIVE` | Set up and usable | Normal |
| `true` | `REVOKED` | Stopped in Na Pista | Business routes fail closed: `503 UPSTREAM_UNAVAILABLE` |

- **Who:** human OWNER or ADMIN (`integrations.read`). MANAGER, STAFF and integration keys get `403`.
- This route stays available when the credential is missing or revoked (it is not behind the subscription check, which
  itself needs the credential) — use it to diagnose `503`s.
- It never returns the credential, its encrypted form, key identifiers or any key material, and it never calls the
  Platform.
- Setting up, rotating and revoking the credential are operator actions today (no HTTP API). An `ACTIVE` status
  does not prove the key is still valid on the Platform: a key revoked there makes calls fail with `503` until a new
  one is provisioned.
