# SenseHub MCP — A64Core Integration Ready

**From:** A64Core Platform
**To:** SenseHub MCP Server team
**Status:** Implementation complete on A64Core side — ready to coordinate first real-site test
**Date:** 2026-04-23
**Prior docs:**
- `SenseHub-MCP-Crop-Sync-Contract.md`
- `SenseHub-MCP-Crop-Sync-Reply.md`
- `SenseHub-MCP-Crop-Sync-Followup.md`
- `SenseHub-MCP-Crop-Sync-Followup-Reply.md`
- `SenseHub-MCP-Zone-Binding-Request.md`
- `SenseHub-MCP-Zone-Binding-Reply.md`

---

## TL;DR

A64Core's integration layer is shipped (v1.13.3, 81 tests green). All 6 MCP tools you exposed are wired — crop push, stage updates, completion, and reconciliation. No new contract asks. We'd like to coordinate a first real-site test against one of our blocks to verify a live round-trip.

One observation about your current dashboard state at the end — flagging two test records that we think may be leftover fixtures. Please advise.

---

## What We Built

- **`SenseHubCropSync` service** — wraps your MCP client with the 4 crop tools. Payload built from `plant_data_enhanced` (our authoritative plant data store) → flat `optimal_ranges` per contract.
- **Trigger points** — three service-layer hooks fire MCP calls as detached `asyncio.create_task()`:
  - Planting (`mark_as_planted`) → `set_crop_data`
  - Block state crosses a stage boundary → `update_growth_stage`
  - Block transitions HARVESTING → CLEANING → `complete_crop`
- **Reconciliation** — runs every 3h in our existing SenseHub background sync; calls `get_crop_data(block_id)` per connected block and resolves 5 drift cases (missing, stale planting_id, stage-drift, orphan-active, primary-zone-not-configured).
- **Fire-and-log everywhere** — MCP failures never block the primary A64Core operation. They log at ERROR with block_id + MCP address + first 500 chars of the exception.

## Operational Behavior You Should Know

- **Concurrency cap:** we cap at **5 in-flight MCP sessions per site** via global semaphore (matching your guidance in the followup reply 2d). No 429 handling — you said you don't rate-limit; we trust that.
- **Partial `optimal_ranges` is real.** Not all our plants have EC, humidity, water, or light data populated. We omit missing keys rather than sending nulls. Unit-tested. A plant with no optimal data at all produces `"optimal_ranges": {}` — still a valid `set_crop_data` call per contract.
- **Correlation key is `a64core_planting_id`** — we persist it and treat `sensehub_crop_id` as opaque (per your 2a clarification).
- **Backfill uses `update_growth_stage` with a past `transitioned_at`** — we don't re-push `set_crop_data` for stage corrections (per your 2b clarification).
- **HTTP 422 "No primary crop zone configured"** → we log as an operator alert (distinct marker in logs) and do **not** auto-retry. If one of your sites returns this, your admin UI is the only place to fix it.
- **UTC `Z` suffix** on all ISO timestamps we send.

## First Real-Site Test — What We Need From You

Pick one site (ideally the one with an existing test setup) and confirm:

1. **Site identifier** — MCP address + port for the block we should target
2. **Primary crop zone status** — confirmed configured? Which zone_id?
3. **Observation window** — a 30-minute window where someone on your side can watch `[MCP]` logs during our first push

On our side we'll:
1. Point one block's `iotController` at the MCP address you give us (we have `100.124.168.35:3001` on file from earlier — confirm if that's still valid)
2. Plant a real crop on that block via the UI → `set_crop_data` fires
3. Transition to HARVESTING → `update_growth_stage` fires (stage `ripening`)
4. Record a harvest + transition to CLEANING → `complete_crop` fires
5. Wait for the next reconciliation cycle and confirm no drift

Total session: ~15 minutes of activity spread over a day, depending on how fast we can walk through state transitions in dev.

## Observations About Current SenseHub State

On the block currently linked to your MCP (A64Core's `F010-002` → your `100.124.168.35:3001`), our side shows **no active crop** (block state is EMPTY). But when we query `get_crop_data`, your side appears to show **two crops associated with "Green House 1"**: Tomato (Cherry Roma) and Cucumber.

Both names match test crops you referenced in your earlier replies (Tomato from `configure_block_mapping` testing, Cucumber from auto-bind example). We believe these are leftover fixtures from your development.

**Questions:**

1. **Why two crops simultaneously on one zone?** Per contract, `set_crop_data` is an atomic replace — one active crop per `block_id`. If your dashboard shows two, is it showing archived + active, or are they bound to different internal `block_id`s that both land on "Green House 1"?
2. **Can you clean up the fixtures?** We'd like to start from a clean slate when we do the first real push. If there's a way to wipe active crop records on your side — or a `deactivate_block_id` admin action — please do that on any zone we'll be testing against.

This isn't blocking; we can push into the existing state and trust atomic replace to clear it. Just wanted to flag the observation.

## Nothing Else From Us

No new schema asks, no contract changes, no new tools needed. When we do the future additions you offered (`ec_drain`, `irrigation`), we'll send a short note — no more full-size specs.

## Proposed Next Step

A 30-min live test window this week. Pick a slot and point us at the MCP address + port; we'll plant → cycle → verify the full round-trip. After that we call the integration done.

Thanks for the clean implementation and responsive iteration over the last few rounds. Easy to build against.
