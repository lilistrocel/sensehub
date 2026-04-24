# SenseHub MCP — Zone Binding Reply

**From:** SenseHub MCP Server team
**To:** A64Core Platform
**Status:** Implemented — `zone_id` removed from A64Core-facing contract
**Date:** 2026-04-22
**Prior doc:** `SenseHub-MCP-Zone-Binding-Request.md`

---

## Decision: Option 1 — Configured Primary Crop Zone

We went with your preferred option. Here's how it works:

### How Zone Routing Works Now

1. **Site admin marks one zone as the primary crop zone** (one-time setup via SenseHub admin UI or `POST /api/crops/set-primary-zone`).
2. When `set_crop_data({ block_id, ... })` arrives, SenseHub:
   - First checks if `block_id` has an explicit zone mapping (from a prior `configure_block_mapping` call).
   - If not, falls back to the **primary crop zone** and **auto-binds** the `block_id` to it for future lookups.
3. All subsequent calls (`update_growth_stage`, `complete_crop`, `get_crop_data`) resolve via `block_id` alone — no `zone_id` needed.

### What A64Core Sends

Exactly what you proposed — `block_id` only, no `zone_id`:

```json
{
  "block_id": "uuid",
  "crop": { "name": "Tomato", "variety": "Cherry Roma" },
  "current_stage": "vegetative",
  ...
}
```

### Error When No Primary Zone Configured

If `set_crop_data` arrives before any zone is configured as primary:

```json
{
  "error": "No primary crop zone configured for this site",
  "hint": "Configure via SenseHub admin UI: go to Zones and mark one zone as the primary crop zone, or use configure_block_mapping to associate a block_id with a zone."
}
```

HTTP 422. Logged clearly on our side. A64Core should surface this to the operator.

---

## Contract Changes

### Removed from A64Core-facing tools:
- `zone_id` parameter — removed from `set_crop_data`, `update_growth_stage`, `complete_crop`, `get_crop_data` MCP tool schemas. All tools are `block_id`-only.

### Kept but demoted to internal/admin use:
- `configure_block_mapping` ��� still available via MCP for multi-zone sites or manual override. A64Core does not need to call it. Description updated to reflect this.
- `list_zone_mappings` — still available, now also returns `primary_crop_zone_id` and `is_crop_zone` per zone. Useful for A64Core's reconciliation loop if you want to verify the binding, but not required.

### New internal endpoint:
- `POST /api/crops/set-primary-zone` — sets which zone receives crop data by default. Called from SenseHub admin UI, not from A64Core.

---

## Answers to Your Questions

### 1. Feasibility
Done. `zone_id` is now fully optional/ignored in all A64Core-facing tools. Internally we still store `zone_id` on the crop record (resolved from `block_id`), but A64Core never sees or sends it.

### 2. Preferred option
Implemented Option 1 (configured primary crop zone) as you recommended. Auto-bind on first contact is also built in as a convenience — when the primary crop zone receives its first `block_id`, the mapping is persisted automatically.

### 3. Migration
The existing test crops from our earlier `configure_block_mapping` calls are **auto-migrated**. The explicit `block_id → zone` mapping on zone 1 ("Green House 1") is still there and takes priority. Setting the primary crop zone was additive, not destructive. No re-push needed.

New `block_id` values that arrive without a prior mapping will auto-bind to the primary crop zone. Existing mappings are preserved.

---

## Verified Behavior

```
# A64Core pushes crop data (block_id only)
set_crop_data({ block_id: "new-uuid", crop: { name: "Cucumber" } })
→ { ok: true, sensehub_crop_id: "4" }

# Crop auto-routed to primary crop zone (Green House 1)
get_crop_data({ block_id: "new-uuid" })
→ { zone_id: 1, zone_name: "Green House 1", crop: { name: "Cucumber" }, ... }

# Zone mapping auto-created for future lookups
list_zone_mappings()
→ { primary_crop_zone_id: 1, mappings: [{ zone_id: 1, block_id: "new-uuid", is_crop_zone: true }] }
```

---

## Summary

- `zone_id` is gone from the external contract. Push with `block_id` only.
- Primary crop zone is configured once per site on our admin UI.
- Auto-binding on first `set_crop_data` means zero ceremony for fresh deployments.
- `configure_block_mapping` and `list_zone_mappings` remain available for multi-zone or diagnostic use but are not required by A64Core.

Ready for your sync service to connect. No further schema coordination needed on this topic.
