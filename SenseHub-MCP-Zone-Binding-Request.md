# SenseHub MCP — Drop Zone Concept from A64Core-Facing Contract

**From:** A64Core Platform
**To:** SenseHub MCP Server team
**Status:** Design request — supersedes zone mapping from prior follow-up
**Date:** 2026-04-22
**Prior docs:**
- `SenseHub-MCP-Crop-Sync-Contract.md` (v1)
- `SenseHub-MCP-Crop-Sync-Reply.md`
- `SenseHub-MCP-Crop-Sync-Followup.md` (where we asked for `configure_block_mapping`)
- `SenseHub-MCP-Crop-Sync-Followup-Reply.md` (where you shipped it)

---

## TL;DR

We'd like to **remove the `zone_id` parameter from the A64Core-facing contract entirely**. A64Core does not model zones — in our domain a block is the atomic unit, and "zone" is a SenseHub implementation detail. Please handle the block-to-zone binding internally on your end so we can push crop data using `block_id` alone.

---

## Why

Our data model is Farm → Block. We do not subdivide blocks into zones in any user-facing or data-layer sense. Every A64Core block corresponds to **one SenseHub deployment** (via `block.iotController.address` + `mcpPort`). Inside that deployment you typically have one "crop zone" plus auxiliary zones (fertigation, drain, etc.) — but only one of them ever receives crop data from us.

Routing from our side is already unambiguous:
- Which SenseHub instance → determined by `block.iotController.address` (baked into the MCP client).
- Which crop lives on that instance → `block_id` (one block = one active crop).

There's no routing ambiguity that requires us to know about zones. Forcing `zone_id` into our calls means:
- A one-time onboarding step that adds a failure mode (wrong zone picked, unmapped zones stay broken silently).
- A field we have to carry on `block.iotController` just to echo it back to you.
- Ongoing coordination whenever zones are renamed, split, or rebuilt on your end.

If we drop it, all of those go away.

---

## What We're Asking For

Please handle zone selection internally. Two possible designs — pick whichever fits your architecture better:

### Option 1 — Configured primary crop zone (preferred)

Each SenseHub deployment has a **primary crop zone** flagged in your own configuration (e.g., `zones.is_crop_zone = true`, or a site-level `primary_crop_zone_id` setting). This is configured **once per site**, on your admin UI, during SenseHub installation.

When `set_crop_data({ block_id, ... })` arrives with no `zone_id`, you route it to the configured primary crop zone. Same for `update_growth_stage`, `complete_crop`, `get_crop_data`.

Benefits:
- Zero ceremony from A64Core.
- You own the authoritative mapping, editable via your admin UI.
- If a site has multiple crop zones in the future, you add your own selection UI without touching our contract.

### Option 2 — Auto-bind on first `set_crop_data`

First call to `set_crop_data` with a new `block_id` auto-creates or auto-selects a zone (e.g., the first zone with no active crop, or a zone matching some heuristic). The binding is persisted server-side. Subsequent calls for the same `block_id` reuse it.

Benefits:
- No manual config step even on your side.
- Self-healing for fresh deployments.

Drawback: if auto-selection picks wrong, an admin UI fix on your end is needed. Same as Option 1 in practice.

### Either option: contract changes

- `set_crop_data` — **remove `zone_id` entirely.** Request body unchanged otherwise. `block_id` alone identifies where the crop goes.
- `update_growth_stage` — same, `block_id` only.
- `complete_crop` — same.
- `get_crop_data` — same.
- `configure_block_mapping` — **no longer called from A64Core.** Feel free to keep it for your own admin UI or remove it; we don't care.
- `list_zone_mappings` — same.

---

## Edge Case: Site With No Crop Zone Configured

If Option 1 and a site's primary crop zone isn't configured yet, `set_crop_data` should return a clear error:

```json
{
  "error": "No primary crop zone configured for this site",
  "hint": "Configure via SenseHub admin UI before pushing crop data"
}
```

We'll log this clearly so the operator knows to fix it on your side. Not something we can resolve from A64Core.

---

## Our Side: What Changes

- `block.iotController` stays as-is. No `zoneId` field added.
- `SenseHubCropSync` service builds payloads with `block_id` only — no zone lookup.
- Reconciliation loop calls `get_crop_data({ block_id })` per connected block. No `list_zone_mappings` round-trip needed.
- Phase 2 of our sync integration collapses to essentially nothing; we go straight to Phase 3 (payload builder + trigger wiring).

---

## Questions For You

1. **Feasibility** — does your schema tolerate the `zone_id` parameter becoming optional / ignored? If removing it outright is a big change, we can send `zone_id: null` as a transitional step, but prefer clean removal once you're ready.
2. **Preferred option** — 1 (configured primary crop zone) or 2 (auto-bind on first contact)? We lean toward Option 1 because the failure mode is clearer (explicit error vs. silently-wrong binding), but will happily consume either.
3. **Migration** — any existing test crop in your system currently bound by our earlier `configure_block_mapping` calls: can it be auto-migrated to the new scheme, or do we need to re-push `set_crop_data` after you ship this change?

---

## Summary

Zones are a SenseHub concept. A64Core shouldn't need to know they exist. Please own the binding internally, drop `zone_id` from the external contract, and let us push crop data against `block_id` alone.

Thanks — this simplifies both sides and removes a failure mode we'd rather not wire.
