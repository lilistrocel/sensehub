# SenseHub MCP — Integration Ready Reply

**From:** SenseHub MCP Server team
**To:** A64Core Platform
**Status:** Ready for live test — fixtures cleaned, site confirmed
**Date:** 2026-04-23

---

## Site Details for First Test

| Item | Value |
|------|-------|
| **MCP Address** | `100.124.168.35:3001` (confirmed, Tailscale) |
| **MCP Endpoint** | `POST http://100.124.168.35:3001/mcp` |
| **Auth** | `Authorization: Bearer sensehub-mcp-default-key` |
| **Primary crop zone** | Zone 1 ("Green House 1") — `is_crop_zone = true` |
| **Current state** | Clean — 0 active crops, no block mappings, zone 1 ready to receive |

---

## Fixture Cleanup — Done

Good catch on the two test crops. Here's what happened and what we did:

### Why two crops showed simultaneously

They were bound to **different `block_id` values** that both auto-resolved to zone 1 (our primary crop zone):

| ID | Crop | block_id | zone | active | Origin |
|----|------|----------|------|--------|--------|
| 3 | Tomato Cherry Roma | `550e8400-...0001` | 1 | active | `configure_block_mapping` testing |
| 4 | Cucumber Lebanese | `new-block-uuid-001` | 1 | active | auto-bind testing |

Per contract, `set_crop_data` replaces atomically **per `block_id`** — and it did. The two crops had different `block_id` values, so both were legitimately active. Your dashboard query hit `GET /api/crops?zone_id=1` which returned both.

This is actually correct behavior for a multi-block site (two blocks sharing infrastructure on one zone). But for your single-block deployment, it looked like stale fixtures.

### What we cleaned

All 4 crop records (2 active + 2 archived) have been deleted. Block mappings on all zones cleared. State is now:

```
Zone 1 (Green House 1) — primary crop zone, no block mapped, 0 crops
Zone 2 (Fertigation System) — not a crop zone
Zone 3 (Drain System) — not a crop zone
```

When your first `set_crop_data` arrives, zone 1 will auto-bind to the `block_id` in your payload.

---

## Test Window

We're available anytime. No scheduling needed on our side — the system is production-ready and unattended. Push whenever you're ready and we'll review the logs afterward.

If you'd like someone watching live, let us know a slot and we'll have eyes on `docker logs sensehub-mcp` and `docker logs sensehub-backend` during the window.

For your proposed 5-step flow:

| Step | Your action | What we expect in our logs |
|------|------------|--------------------------|
| 1 | Point block at `100.124.168.35:3001` | MCP session initialized |
| 2 | Plant crop → `set_crop_data` | `[mcp] Session ... initialized`, crop created on zone 1, `sensehub_crop_id` returned |
| 3 | Transition → `update_growth_stage` | Stage updated, `{ ok: true }` |
| 4 | Harvest → `complete_crop` | Crop archived, `{ ok: true }` |
| 5 | Reconciliation → `get_crop_data` | Returns `null` (crop completed), no drift |

---

## Operational Notes for Your Team

- **Partial `optimal_ranges: {}`** — fully handled. Dashboard shows "Active Crops" card with crop name and stage but no optimal range rows. No errors.
- **UTC `Z` timestamps** — stored as-is. Our dashboard converts to the site's local timezone (Asia/Dubai, UTC+4) for display.
- **HTTP 422 on unconfigured zone** — won't happen for this site (zone 1 is marked primary). If you test against a different SenseHub instance that hasn't been set up, you'll get the 422.
- **`sensehub_crop_id` is opaque and non-stable** — confirmed. New ID on every `set_crop_data`, even for same `block_id`.

---

## Nothing Else From Us

Site is clean, MCP is healthy, primary zone configured. Push when ready.
