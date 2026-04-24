# SenseHub MCP — Crop Data Sync Contract

**From:** A64Core Platform
**To:** SenseHub MCP Server team
**Status:** Draft v1 — for implementation
**Date:** 2026-04-22

---

## Purpose

A64Core is the authoritative source for crop definitions, plant data, and growth stage. SenseHub's role is to **consume** this data and drive automation decisions (irrigation, climate, lighting, alerts) against it. This document defines the contract for the four crop-data MCP tools (`set_crop_data`, `get_crop_data`, `update_growth_stage`, `complete_crop`) and the `sensehub://crops` resource.

Please align the existing tool implementations to the schemas below. The contract is set on the A64Core side — do not negotiate the field names or shapes; implement them as specified and flag anything that genuinely won't work.

> Note on naming: earlier SenseHub docs reference "A20Core" — the correct name is **A64Core**. Please update dashboard labels accordingly (e.g., "Synced from A64Core").

---

## Design Principles

1. **A64Core pushes; SenseHub stores and acts.** SenseHub does not pull crop data from us; we push on events.
2. **All optimal parameters are ranges**, expressed as `{min, max, unit}` objects. No bare scalars, no single "target" values. SenseHub decides where in the range to operate.
3. **Growth stage is always computed by A64Core** and sent explicitly via `current_stage` (in `set_crop_data`) or `stage` (in `update_growth_stage`). SenseHub must not infer stage from dates.
4. **All timestamps are ISO 8601 UTC.**
5. **All IDs are UUID v4 strings.**
6. **All tool calls are idempotent by `block_id`.** A repeated `set_crop_data` with the same `block_id` replaces the prior active assignment atomically.

---

## Tool: `set_crop_data`

Called when A64Core assigns a crop to a block (planting is executed). Replaces any prior active crop on that `block_id`.

### Request

```json
{
  "block_id": "uuid",
  "a64core_planting_id": "uuid",
  "crop": {
    "plant_data_id": "uuid",
    "name": "Tomato",
    "variety": "Cherry Roma",
    "scientific_name": "Solanum lycopersicum var. cerasiforme"
  },
  "timing": {
    "planted_date": "2026-03-15T00:00:00Z",
    "expected_harvest_date": "2026-06-15T00:00:00Z",
    "growth_cycle_days": 92
  },
  "population": {
    "plant_count": 48,
    "max_capacity": 60
  },
  "current_stage": "vegetative",
  "optimal_ranges": {
    "ec":          { "min": 2.0, "max": 3.5, "unit": "mS/cm" },
    "ph":          { "min": 5.8, "max": 6.5, "unit": "pH" },
    "temperature": { "min": 18,  "max": 26,  "unit": "C" },
    "humidity":    { "min": 60,  "max": 75,  "unit": "%RH" },
    "water":       { "volume_per_plant_per_day": 1.2, "unit": "L" },
    "light":       { "hours_per_day": 14, "unit": "h" }
  },
  "stage_durations_days": {
    "seedling":   14,
    "vegetative": 28,
    "flowering":  21,
    "fruiting":   21,
    "ripening":   8
  }
}
```

### Field Notes

- Any key inside `optimal_ranges` may be **omitted** if A64Core doesn't have data for that plant. SenseHub must handle missing keys gracefully: skip the corresponding automation, do not fail the call.
- `stage_durations_days` lets SenseHub preview upcoming transitions for scheduling, but the authoritative transitions still come via `update_growth_stage`.
- `max_capacity` is the block's physical plant capacity; `plant_count` is the current live count.

### Response

```json
{
  "ok": true,
  "sensehub_crop_id": "string"
}
```

Return the internal SenseHub crop ID so A64Core can correlate future events/webhooks.

---

## Tool: `update_growth_stage`

Called when A64Core's computed stage advances, or when a block-state change implies a stage transition. SenseHub should use this to adjust setpoints (e.g., switch nutrient profile flowering → fruiting) without re-receiving the full crop payload.

### Request

```json
{
  "block_id": "uuid",
  "stage": "flowering",
  "transitioned_at": "2026-04-12T00:00:00Z",
  "days_since_planting": 28
}
```

### Allowed `stage` Values

Exhaustive, ordered, lowercase:

1. `seedling`
2. `vegetative`
3. `flowering`
4. `fruiting`
5. `ripening`
6. `harvested`

Transitions should normally proceed in order, but **do not enforce strict forward-only transitions** — replanting or corrective updates may send an earlier stage. If you do enforce rules, document them in your reply (see "Confirm Back to A64Core" below).

### Response

```json
{ "ok": true }
```

---

## Tool: `complete_crop`

Called when harvest is finalized on A64Core (block transitions to `CLEANING` or `EMPTY` after harvest recording).

### Request

```json
{
  "block_id": "uuid",
  "harvested_at": "2026-06-18T00:00:00Z",
  "total_yield_kg": 42.6,
  "average_quality_grade": "A",
  "harvest_count": 3
}
```

- `total_yield_kg` is the cumulative sum across all harvest events on that crop cycle.
- `average_quality_grade` is one of `A`, `B`, `C`, `D` (letter grade).
- `harvest_count` is the number of discrete harvest events during the cycle.

### Response

```json
{ "ok": true }
```

SenseHub should mark the crop cycle complete, archive the record, and stop issuing stage-based automations for that `block_id` until a new `set_crop_data` arrives.

---

## Tool: `get_crop_data`

Read-only. Returns the currently stored active-crop payload for a `block_id`, or `null` if no active crop.

### Request

```json
{ "block_id": "uuid" }
```

### Response

Mirrors the `set_crop_data` request body exactly (same keys, same nesting), plus:

```json
{
  "sensehub_crop_id": "string",
  "received_at": "ISO8601",
  "last_stage_update_at": "ISO8601"
}
```

Or `null` if no active crop is assigned.

---

## Resource: `sensehub://crops`

List of all active crops across the SenseHub site. Each entry uses the same shape as `get_crop_data` response.

---

## Error Handling

| Scenario | Expected Behavior |
|---|---|
| Unknown `block_id` on `update_growth_stage` / `complete_crop` | Return a `404`-equivalent MCP error. A64Core will re-push via `set_crop_data` and retry. |
| Invalid `stage` enum value | Return validation error listing the valid values. |
| Partial `optimal_ranges` (some keys missing) | Accept; store what's provided. Do not fail. |
| Repeated `set_crop_data` with same `block_id` | Atomically replace the prior assignment. No duplicate records. |
| Malformed payload (missing required top-level field) | Return validation error naming the field. |

---

## Dashboard Requirements

The SenseHub dashboard's "Active Crops" panel should display:

- Crop `name` and `variety`
- Current `stage` (from `current_stage` / last `update_growth_stage` — **never** computed locally)
- Days since planting → days to expected harvest (progress bar)
- `plant_count` / `max_capacity`
- Each provided optimal range, shown alongside the current live sensor reading for that parameter (highlight out-of-range values)
- Source label: **"Synced from A64Core"**

---

## Transport / Auth (unchanged from existing MCP client)

- JSON-RPC 2.0 over HTTPS `POST /mcp`
- `Authorization: Bearer <mcpApiKey>` — static per-site key
- MCP session handshake: `initialize` → `notifications/initialized` → `tools/call`
- A64Core already has a working client at `src/modules/farm_manager/services/sensehub/sensehub_mcp_client.py` and will call these tools from its planting, block-status, and harvest service layers.

---

## Confirm Back to A64Core

Once implemented, please reply with:

1. **Fields you need that aren't in this contract** — we'll extend our `plant_data` model on our side.
2. **Any validation rules you enforce** — especially around stage transition ordering, so we respect them.
3. **Idempotency confirmation** — whether `set_crop_data` clears prior automation state atomically, or if we should call a separate `deactivate` step first.
4. **Units** — confirm you expect EC in mS/cm (not µS/cm), temperature in Celsius, water in liters.
5. **Sample successful request/response payloads** for each tool, captured from your test environment, so we can verify our client matches byte-for-byte.

---

## Test Crop (already in your system)

Your existing test crop should map to this contract as:

```json
{
  "block_id": "<green-house-1 block_id>",
  "crop": {
    "name": "Tomato",
    "variety": "Cherry Roma"
  },
  "timing": {
    "planted_date": "2026-03-15T00:00:00Z",
    "expected_harvest_date": "2026-06-15T00:00:00Z"
  },
  "current_stage": "flowering",
  "optimal_ranges": {
    "ec": { "min": 2.0, "max": 3.5, "unit": "mS/cm" }
  }
}
```

Please confirm the existing record round-trips cleanly through `get_crop_data` once you've migrated it to the new shape.
