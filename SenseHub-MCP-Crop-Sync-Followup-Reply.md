# SenseHub MCP — Follow-Up Reply

**From:** SenseHub MCP Server team
**To:** A64Core Platform
**Status:** All items implemented, clarifications answered
**Date:** 2026-04-22
**Prior docs:**
- `SenseHub-MCP-Crop-Sync-Contract.md` (v1)
- `SenseHub-MCP-Crop-Sync-Reply.md` (our implementation reply)
- `SenseHub-MCP-Crop-Sync-Followup.md` (your follow-up)

---

## Section 1: `configure_block_mapping` + `list_zone_mappings` — Implemented

Both tools are live on the MCP endpoint, same auth (`Bearer <mcpApiKey>`).

### `configure_block_mapping`

Matches your contract exactly. Request/response:

```json
// Request
{
  "zone_id": 1,
  "block_id": "550e8400-e29b-41d4-a716-446655440001",
  "block_code": "GH1-A",
  "block_name": "Green House 1"
}

// Response
{
  "ok": true,
  "previous_block_id": null
}
```

Behavior:
- Idempotent. Re-calling with the same pair is a no-op (returns the same `previous_block_id`).
- Different `block_id` for the same `zone_id` replaces the mapping and returns the old one in `previous_block_id`.
- `block_code` is stored on the zone record for your dashboard/reconciliation use.
- `block_name` updates the zone's display name if provided.
- Unknown `zone_id` returns **404 with available zone list** (we do not auto-create zones — they correspond to physical locations with equipment assignments and must be configured manually):

```json
{
  "error": "Zone 99 not found",
  "available_zones": [
    { "id": 1, "name": "Green House 1" },
    { "id": 2, "name": "Fertigation System" },
    { "id": 3, "name": "Drain System" }
  ]
}
```

### `list_zone_mappings`

```json
// Request
{}

// Response
{
  "mappings": [
    { "zone_id": 1, "block_id": "550e8400-...", "zone_name": "Green House 1", "block_code": "GH1-A", "configured_at": "2026-04-22T17:30:00Z" },
    { "zone_id": 2, "block_id": null, "zone_name": "Fertigation System", "block_code": null, "configured_at": null },
    { "zone_id": 3, "block_id": null, "zone_name": "Drain System", "block_code": null, "configured_at": null }
  ]
}
```

All zones are listed. Unmapped zones show `block_id: null`, `configured_at: null`.

The REST endpoint (`POST /api/crops/zones/:zone_id/block-id`) still exists for manual/UI use but is redundant with the MCP tool. Use whichever you prefer.

---

## Section 2: Clarification Answers

### 2a. `sensehub_crop_id` — persistence contract

- **Not stable across re-pushes.** Each `set_crop_data` call creates a new record (the old one is archived with `active = 0`). The `sensehub_crop_id` increments.
- It is a **numeric auto-increment** represented as a string. Treat it as **opaque string** — we may switch to UUID in a future version.
- If you need a stable correlation key across replaces, use `a64core_planting_id` (see 2e below) — we persist and round-trip it faithfully.

### 2b. `update_growth_stage` with past `transitioned_at`

**Accepted.** We store `transitioned_at` as-is, no validation against current time. Past timestamps are fine for reconciliation/backfill. We also store `days_since_planting` as provided — we do not recompute it.

You do **not** need to re-send the full `set_crop_data` for past stage transitions. `update_growth_stage` with a historical `transitioned_at` is the correct approach.

### 2c. `complete_crop` — block state after completion

**Confirmed:** after `complete_crop`, calling `get_crop_data` on that `block_id` returns **`null`** until a new `set_crop_data` arrives. The archived record exists in our database (queryable with `include_inactive=true`) but is not surfaced as an active crop.

Code against `get_crop_data → null` for completed blocks.

### 2d. Rate limits / concurrency

**No enforced rate limits.** The MCP endpoint is synchronous (one request at a time per session), but you can open multiple sessions.

For bulk reconciliation (200 blocks):
- **5 concurrent sessions** is fine. Our SQLite WAL mode handles concurrent reads well, and writes are serialized internally.
- No minimum delay needed between calls.
- We do **not** have a `set_crop_data_bulk` tool today. If your 200-block reconciliation with 5 concurrent calls is too slow (~40 sequential batches), we can add one. Let us know after your first test run.
- We will **not** return 429. If the system is overloaded, you'll see increased latency rather than rejections.

### 2e. `a64core_planting_id` — persistence confirmed

**Yes, persisted and round-tripped.** It is stored in the `a64core_planting_id` column and returned on every `get_crop_data` response. This is the contract — not a one-off. You can rely on it for correlation without local state.

---

## Section 4: `ec_drain` and `irrigation_schedule_hint` shapes

If useful, our preferred shapes:

### `optimal_ranges.ec_drain`
```json
"ec_drain": { "min": 2.5, "max": 4.0, "unit": "mS/cm" }
```
Same shape as `ec`. We'll display it separately on the dashboard as "Drain EC target" and use it as the threshold for our drain sensor calibration system.

### `irrigation_schedule_hint`
```json
"irrigation": {
  "cycles_per_day": 6,
  "duration_minutes": 12,
  "unit": "cycles"
}
```
We'd cross-reference this against our scheduled fertigation count and flag a warning if they diverge.

Both are non-blocking. Implement at your convenience — we handle missing keys gracefully.

---

## Tool Count Summary

SenseHub MCP now exposes **19 tools** + **6 resources**:

| Tool | Source |
|------|--------|
| `get_equipment_list` | Original |
| `get_sensor_readings` | Original |
| `get_automations` | Original |
| `get_alerts` | Original |
| `get_system_status` | Original |
| `control_relay` | Original |
| `trigger_automation` | Original |
| `toggle_automation` | Original |
| `get_lab_readings` | Original |
| `get_lab_latest` | Original |
| `get_lab_stats` | Original |
| `get_lab_nutrients` | Original |
| `get_cameras` | Camera |
| `capture_camera_snapshot` | Camera |
| `get_camera_snapshots` | Camera |
| `get_camera_snapshot_image` | Camera |
| **`set_crop_data`** | **A64Core contract** |
| **`get_crop_data`** | **A64Core contract** |
| **`update_growth_stage`** | **A64Core contract** |
| **`complete_crop`** | **A64Core contract** |
| **`configure_block_mapping`** | **A64Core follow-up** |
| **`list_zone_mappings`** | **A64Core follow-up** |

Ready for integration testing. Reach out when your sync service is wired up and we'll coordinate on a test site.
