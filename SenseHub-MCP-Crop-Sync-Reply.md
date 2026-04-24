# SenseHub MCP — Crop Data Sync Implementation Reply

**From:** SenseHub MCP Server team
**To:** A64Core Platform
**Status:** Implemented — ready for integration testing
**Date:** 2026-04-22

---

## Implementation Status

All four crop data tools and the `sensehub://crops` resource have been implemented per the contract. The naming correction from "A20Core" to **A64Core** has been applied across the dashboard and codebase.

---

## 1. Fields We Need That Aren't in the Contract

**None required at this time.** The contract covers our current needs. The following would be *nice-to-have* in a future revision (non-blocking):

- `optimal_ranges.ec_drain` — if A64Core tracks optimal drain EC separately from feed EC, we could use it for our drain sensor calibration system.
- `irrigation_schedule_hint` — if A64Core has a recommended irrigation frequency (cycles/day), it would help us cross-check our scheduled fertigation count.

These are informational only — we will not fail if they're absent.

---

## 2. Validation Rules We Enforce

### Stage transitions
- **We do NOT enforce forward-only transitions.** Any valid stage can be set at any time. The valid enum is:
  `seedling`, `vegetative`, `flowering`, `fruiting`, `ripening`, `harvested`
- An invalid stage string returns a validation error with the list of valid values.
- `complete_crop` automatically sets stage to `harvested` regardless of current stage.

### block_id resolution
- SenseHub maps `block_id` → internal `zone_id` via a `zones.block_id` column. This mapping must be configured once per site (we provide an endpoint: `POST /api/crops/zones/:zone_id/block-id`).
- If no zone mapping exists for a `block_id`, the crop is still stored and accessible via `get_crop_data`, but it won't appear on the zone-filtered dashboard until mapped.
- **Recommendation:** include a `configure_block_mapping` step in your onboarding flow, or push the mapping as part of site provisioning.

### Partial optimal_ranges
- Accepted as-is. Missing keys are skipped in the dashboard and in automation dependency checks. No validation errors.

---

## 3. Idempotency Confirmation

`set_crop_data` is **fully idempotent by `block_id`**:

1. Any existing active crop on that `block_id` is atomically deactivated (set `active = 0`).
2. The new crop is inserted as `active = 1`.
3. This happens in a single synchronous transaction — no separate `deactivate` call needed.
4. The deactivated record is preserved (archived) for historical reporting, not deleted.
5. No automation state is leaked: stage-based automations key off the active crop record, so deactivation stops them immediately.

**A64Core does not need to call a separate deactivate step.** Just push `set_crop_data` with the new crop data and the old one is replaced.

---

## 4. Units Confirmation

| Parameter | Expected Unit | Confirmed |
|-----------|--------------|-----------|
| EC | mS/cm | Yes |
| pH | pH (dimensionless) | Yes |
| Temperature | Celsius (C) | Yes |
| Humidity | %RH | Yes |
| Water | Liters (L) per plant per day | Yes |
| Light | Hours per day (h) | Yes |
| Yield | kg | Yes |

SenseHub internally stores soil sensor EC in µS/cm and uses a calibration system (linear regression from manual pen readings) to estimate real EC in mS/cm. The `optimal_ranges.ec` values from A64Core are used as-is in mS/cm for dashboard display and dependency thresholds.

---

## 5. Sample Successful Request/Response Payloads

### set_crop_data

**Request:**
```json
{
  "block_id": "550e8400-e29b-41d4-a716-446655440001",
  "a64core_planting_id": "660e8400-e29b-41d4-a716-446655440099",
  "crop": {
    "plant_data_id": "pd-001",
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
  "current_stage": "flowering",
  "optimal_ranges": {
    "ec": { "min": 2.0, "max": 3.5, "unit": "mS/cm" },
    "ph": { "min": 5.8, "max": 6.5, "unit": "pH" },
    "temperature": { "min": 18, "max": 26, "unit": "C" },
    "humidity": { "min": 60, "max": 75, "unit": "%RH" },
    "water": { "volume_per_plant_per_day": 1.2, "unit": "L" },
    "light": { "hours_per_day": 14, "unit": "h" }
  },
  "stage_durations_days": {
    "seedling": 14,
    "vegetative": 28,
    "flowering": 21,
    "fruiting": 21,
    "ripening": 8
  }
}
```

**Response:**
```json
{
  "ok": true,
  "sensehub_crop_id": "1"
}
```

### get_crop_data

**Request (MCP tool call):**
```json
{ "block_id": "550e8400-e29b-41d4-a716-446655440001" }
```

**Response:**
```json
{
  "sensehub_crop_id": "1",
  "block_id": "550e8400-e29b-41d4-a716-446655440001",
  "zone_id": 1,
  "zone_name": "Green House 1",
  "a64core_planting_id": "660e8400-e29b-41d4-a716-446655440099",
  "crop": {
    "plant_data_id": "pd-001",
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
  "current_stage": "flowering",
  "optimal_ranges": {
    "ec": { "min": 2.0, "max": 3.5, "unit": "mS/cm" },
    "ph": { "min": 5.8, "max": 6.5, "unit": "pH" },
    "temperature": { "min": 18, "max": 26, "unit": "C" },
    "humidity": { "min": 60, "max": 75, "unit": "%RH" },
    "water": { "volume_per_plant_per_day": 1.2, "unit": "L" },
    "light": { "hours_per_day": 14, "unit": "h" }
  },
  "stage_durations_days": {
    "seedling": 14,
    "vegetative": 28,
    "flowering": 21,
    "fruiting": 21,
    "ripening": 8
  },
  "active": true,
  "received_at": "2026-04-22T17:13:31.989Z",
  "last_stage_update_at": "2026-04-22T17:13:31.989Z"
}
```

Returns `null` if no active crop on the block.

### update_growth_stage

**Request:**
```json
{
  "block_id": "550e8400-e29b-41d4-a716-446655440001",
  "stage": "fruiting",
  "transitioned_at": "2026-04-22T00:00:00Z",
  "days_since_planting": 38
}
```

**Response:**
```json
{ "ok": true }
```

Returns 404-equivalent error if no active crop for that `block_id`.

### complete_crop

**Request:**
```json
{
  "block_id": "550e8400-e29b-41d4-a716-446655440001",
  "harvested_at": "2026-06-18T00:00:00Z",
  "total_yield_kg": 42.6,
  "average_quality_grade": "A",
  "harvest_count": 3
}
```

**Response:**
```json
{ "ok": true }
```

Crop is archived (`active = false`, `current_stage = harvested`). Returns 404 if no active crop.

---

## 6. Test Crop Round-Trip Confirmation

The existing test crop has been migrated to the contract schema. It round-trips cleanly through `get_crop_data`:

```
block_id: 550e8400-e29b-41d4-a716-446655440001
crop.name: Tomato
crop.variety: Cherry Roma
current_stage: flowering (was updated to fruiting, then completed and replaced by Lettuce for testing — re-push the Tomato to restore)
optimal_ranges.ec: {min: 2.0, max: 3.5, unit: "mS/cm"}
```

---

## 7. Next Steps (Suggested)

### From A64Core side:
1. **Block-to-zone mapping**: Push `block_id` UUIDs for each block that maps to a SenseHub zone. We provide `POST /api/crops/zones/:zone_id/block-id` for this, or you can include it in your site provisioning flow.
2. **Wire planting events**: Call `set_crop_data` from your planting service layer when a block transitions to `PLANTED`.
3. **Wire stage transitions**: Call `update_growth_stage` when your block-status service computes a new stage.
4. **Wire harvest finalization**: Call `complete_crop` when a block transitions to `CLEANING`/`EMPTY`.

### From SenseHub side (we will build):
1. **Optimal range alerts**: When live sensor readings fall outside the crop's `optimal_ranges`, generate a warning alert with the crop context.
2. **Stage-aware automation**: Allow automation dependencies to reference the current crop stage (e.g., "only run this fertigation profile during flowering").
3. **Crop history dashboard**: A timeline view of past crop cycles per zone with yield data, for trend analysis.
4. **Per-stage optimal_ranges**: If A64Core sends different optimal ranges per growth stage in the future, we're ready to consume them — our schema stores the full `optimal_ranges` JSON and can be extended.

---

## Transport / Auth

No changes from existing MCP client setup:
- **Endpoint:** `POST https://<sensehub-host>:3001/mcp`
- **Auth:** `Authorization: Bearer sensehub-mcp-default-key`
- **Protocol:** MCP Streamable HTTP (2025-03-26)

Ready for integration testing whenever A64Core is.
