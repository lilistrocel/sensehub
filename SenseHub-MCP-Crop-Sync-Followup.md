# SenseHub MCP — Crop Data Sync Follow-Up

**From:** A64Core Platform
**To:** SenseHub MCP Server team
**Status:** Follow-up to implementation reply — clarifications + one new ask
**Date:** 2026-04-22
**Prior docs:**
- `SenseHub-MCP-Crop-Sync-Contract.md` (v1, our contract)
- `SenseHub-MCP-Crop-Sync-Reply.md` (your implementation reply)

---

## TL;DR

- Contract is accepted as-is on your end — thank you, no schema changes on our side.
- We have **one new request**: expose the block-to-zone mapping as an MCP tool (`configure_block_mapping`) so everything A64Core pushes goes through MCP rather than mixing MCP + REST.
- A few small clarifications below.
- We'll start implementation on our side (plant_data schema extension, sync service, trigger wiring) in parallel.

---

## 1. New Request: `configure_block_mapping` as an MCP Tool

Your reply documented `POST /api/crops/zones/:zone_id/block-id` as the way to associate a SenseHub `zone_id` with an A64Core `block_id`. That works, but it means our integration is split across two transports (MCP for crop data, REST for mapping), with two auth surfaces and two failure modes.

**Please add an MCP tool with this contract:**

### Tool: `configure_block_mapping`

Associates a SenseHub `zone_id` with an A64Core `block_id`. Idempotent — re-calling with the same pair is a no-op; re-calling with a different `block_id` for the same `zone_id` replaces the mapping.

**Request:**
```json
{
  "zone_id": 1,
  "block_id": "550e8400-e29b-41d4-a716-446655440001",
  "block_code": "GH1-A",
  "block_name": "Green House 1"
}
```

- `zone_id` (integer, required) — your internal zone identifier
- `block_id` (UUID, required) — our authoritative block identifier
- `block_code` (string, optional) — our human-readable block code (e.g., "F001-005"), useful for your dashboard
- `block_name` (string, optional) — display name; for dashboard context only

**Response:**
```json
{
  "ok": true,
  "previous_block_id": null
}
```

- `previous_block_id` is the block_id that was previously mapped to this zone (if any), or `null`. Lets us detect collisions.

**Error behavior:**
- Unknown `zone_id` → `404` with available zone list, or auto-create if that's your preferred behavior (please confirm which).

### Also expose the inverse, for reconciliation:

### Tool: `list_zone_mappings`

Read-only. Returns the current zone → block mapping table so A64Core can reconcile on startup.

**Request:** `{}`

**Response:**
```json
{
  "mappings": [
    { "zone_id": 1, "block_id": "550e8400-...", "zone_name": "Green House 1", "configured_at": "2026-04-22T17:00:00Z" },
    { "zone_id": 2, "block_id": null, "zone_name": "Green House 2", "configured_at": null }
  ]
}
```

Zones with no mapping should appear with `block_id: null` so we can see which still need configuring.

> If you'd prefer to keep the REST endpoint alongside the MCP tool, that's fine — we'll use the MCP tool by default. But **please do expose it via MCP** so it uses the same `Authorization: Bearer <mcpApiKey>` auth as everything else.

---

## 2. Clarifications on Your Reply

### 2a. `sensehub_crop_id` — persistence contract?

Your `set_crop_data` response returns `"sensehub_crop_id": "1"`. We'll store this alongside our planting record for correlation.

**Please confirm:**
- Is `sensehub_crop_id` stable across re-pushes (idempotent replay of the same `set_crop_data`)? Or does it increment each time?
- Is it numeric/auto-increment (per your `"1"` example), or should we treat it as opaque string?

If it's a fresh ID per replace, that's fine, but we need to know so we don't rely on it as a stable identity.

### 2b. `update_growth_stage` + stage backfill

You confirmed non-strict transitions. One edge case: if A64Core is offline during a stage transition and we reconcile later, we may need to push `update_growth_stage` with a `transitioned_at` in the past. Is this acceptable, or do you want us to re-send the full `set_crop_data` with the current stage in those cases?

Our preference: **accept past `transitioned_at`** and store it as-is.

### 2c. `complete_crop` — what happens to the block after?

You confirmed the crop is archived and automations stop. Just to be explicit: after `complete_crop`, does calling `get_crop_data` on that `block_id` return `null` until a new `set_crop_data` arrives? We'll code against that assumption.

### 2d. Rate limits / concurrency?

Are there per-site or per-block rate limits we should respect? On a bulk reconciliation pass (e.g., 200 blocks on startup) we might fire `set_crop_data` calls in quick succession. Preference or requirement on:
- Max concurrent calls per site?
- Min delay between calls?
- Batch tool (e.g., `set_crop_data_bulk`)?

If there are no limits, we'll proceed with modest concurrency (5 in-flight per site) and back off on any 429-equivalent response.

### 2e. `a64core_planting_id` — do you store it?

We send `a64core_planting_id` in `set_crop_data`. Do you persist and return it on `get_crop_data`? (Your sample response shows it echoed back — just confirming that's the contract, not a one-off.) We'd like to rely on it being round-tripped so we can correlate without holding local state.

---

## 3. Acknowledgements

- **Units:** Confirmed, matches our internal representation. No conversion needed on our side.
- **Idempotency of `set_crop_data`:** Understood — we will not call a separate deactivate. We'll just push the new crop and trust your atomic replace.
- **Stage transitions non-strict:** Good, lets us send corrections.
- **Partial `optimal_ranges`:** Good — we'll send only what our `plant_data` has populated. EC/humidity/water volume/light hours aren't on all our crop records today; we're extending the schema but will roll out incrementally.
- **Dashboard naming (A64Core):** Thanks for the rename.

---

## 4. Future Additions We're Considering

Informational — not asking you to implement yet, but flagging direction:

- **Per-stage `optimal_ranges`** — likely within 1–2 quarters. You confirmed your schema can already consume it; we'll send `optimal_ranges_by_stage` as an optional top-level key when ready.
- **`ec_drain`** — we're not currently tracking this but will evaluate adding it based on your drain-sensor calibration needs.
- **`irrigation_schedule_hint`** — same — will consider. If useful, we'd send `{ cycles_per_day: N, duration_minutes: M }`.

If you have strong preferences on the shape of either, send them now and we'll bake it into the schema extension.

---

## 5. Our Next Steps (for visibility)

On the A64Core side, we're starting:

1. `plant_data` schema extension (EC, humidity, water volume L/plant/day, light hours) + UI
2. `block.iotController.zoneId` field + mapping push via `configure_block_mapping` (pending your MCP tool)
3. `SenseHubCropSync` service wrapping your 4 (soon 6) tools
4. Trigger wiring: planting → `set_crop_data`, status change → `update_growth_stage`, harvest → `complete_crop`
5. Reconciliation in the existing 3h `SenseHubSyncService` loop — on startup and periodically, diff `list_zone_mappings` + `get_crop_data` per block vs A64Core state, repush where they drift

Integration testing begins once items 1–4 land. We'll reach out to coordinate a test site.

---

## What We Need From You

1. **Confirm or push back on `configure_block_mapping` / `list_zone_mappings` as MCP tools** (Section 1)
2. **Answer the five clarifications** in Section 2
3. Any opinion on `ec_drain` / `irrigation_schedule_hint` shape for when we add them (Section 4)

Thanks — contract implementation looks clean and the sample payloads matched our client expectations.
