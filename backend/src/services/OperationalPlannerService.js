/**
 * OperationalPlannerService — generates a proposed operational plan
 * (a set of automation specs) for the next calendar day.
 *
 * Currently operates in PREVIEW-ONLY mode: the planner produces structured JSON
 * matching the live `automations` table shape (trigger_config + conditions +
 * actions), persists it as a plan row, but does NOT create real automations.
 * The frontend renders the plan as cards. Once we've validated quality, we can
 * flip a flag to actually instantiate the proposed automations.
 *
 * Schedule: fires daily at the configured local time (default 18:00) and
 * generates the plan for TOMORROW (covering 00:00-23:59 next day).
 *
 * Context fed to the planner each evening:
 *   - Today's snapshot (delegated to AgronomistService.aggregateDailyData)
 *   - Today's agronomist report (if any) — opinion + recommendations
 *   - Current automations (the operational baseline)
 *   - Equipment inventory + relay channel config (real channel labels/mixtures/flow rates)
 *   - Zones + crop assignments
 *
 * Output schema constrains the planner to only emit automation specs with
 * trigger types it can describe deterministically (schedule, threshold) so the
 * eventual "create real" path is straightforward.
 */

const AnthropicModule = require('@anthropic-ai/sdk');
const Anthropic = AnthropicModule.default || AnthropicModule.Anthropic || AnthropicModule;
const { db } = require('../utils/database');
const { agronomistService } = require('./AgronomistService');
const { instantiateTemplate } = require('../utils/templateSubstitution');

const DEFAULT_MODEL = 'claude-sonnet-4-6';
const CONFIG_KEY = 'operational_planner_config';

const SYSTEM_PROMPT = `You are an expert operations planner for a controlled-environment farm in the United Arab Emirates. Each evening you produce a concrete operational plan for the FOLLOWING calendar day (00:00–23:59 local time).

Your job is NOT to write narrative — it is to produce a structured set of automation specifications. Other software will execute them.

# Templates-first composition (REQUIRED reading)

Your PRIMARY way to compose automations is to **instantiate templates**. The operator has authored a library of pre-validated, parameterised recipes that encode domain knowledge (e.g. "paired pump fertigation requires the irrigation pump and mixing pump to run the same duration"). Picking a template + supplying parameters is preferred over writing raw actions because:
- Templates encode constraints you might miss (paired-pump coupling, hysteresis rules, alert-not-control conventions).
- The operator review is faster.
- Raw automations are an escape hatch, NOT the default.

How to use them:
1. Read context.templates[] — each entry has {id, name, description, agent_usage_notes, parameters[], default_trigger_type, category}.
2. For each automation you want in tomorrow's plan, FIRST try to match it to a template. Read agent_usage_notes carefully — that's the operator telling you when to use it.
3. Set proposed_automations[].template_id to the chosen template's id, and proposed_automations[].template_parameters to a JSON OBJECT string mapping parameter names → values. Provide every required parameter. Leave actions[] as []. Example: template_parameters = "{\\"equipment_id\\":\\"3\\",\\"channel\\":\\"1\\",\\"duration_min\\":\\"8\\"}".
4. STILL provide trigger_config — the template doesn't decide WHEN to fire; you do, based on the plan.
5. If you genuinely cannot find a fitting template, raw fallback is allowed: set template_id=0, set template_parameters="{}", fill actions[] yourself, AND add an entry to top-level template_requests[] explaining what template should exist. Flag this as a partial gap — it's not the goal state.

Parameter encoding rules:
- template_parameters is a JSON STRING containing an object. Use double-quoted keys and string values. Example: "{\\"duration_min\\":\\"8\\",\\"channel\\":\\"3\\"}". The validator parses it and coerces values to each parameter's declared type.
- Don't invent parameter names; only emit names that exist in the template's parameters[] list.
- Don't put the JSON inside an array or wrap it weirdly — it's a single object string.

# Fertigation: tanks + dose programs (REQUIRED reading)

The farm has physical 1000-L stock tanks (see context.fertigation_tanks). Each is bound to a Waveshare injector valve on the fertigation venturi line. During a fertigation cycle the water pump and venturi mixing pump always run; the only knob is *what fraction of the cycle each tank's valve is open*. That fraction is called the **duty cycle**.

A reusable bundle of "{tank → duty%}" plus a target EC/pH and a window length is a **dose program** (see context.dose_programs). Every fertigation cycle MUST reference a dose program. There are two ways:

1. **Pick a published program** — set proposed_automations[].dose_program_id to the chosen program's id. The fertigation template needs this parameter. This is the preferred path.

2. **Request a new program** — if no published program fits the crop targets, add an entry to top-level dose_program_requests[] with the per-tank duty% you want and the rationale. Use the existing fertigation template (or fall back to raw) and reference the *desired* program by name in the rationale; the operator will create it from your request, publish it, and on the next planner run it will appear in context.dose_programs for you to pick by id.

Hard rules:
- Tanks with role="nutrient" deliver N/P/K/Ca/Mg/S/micros. Tanks with role="ph_down" / "ph_up" deliver acid/base — use them only for pH trim.
- If two nutrient tanks have ingredients in different compatibility_groups (e.g. one in "calcium", another in "sulfate" or "phosphate"), the dose program MUST use compatibility_strategy="time_slice" with compatibility_slot set per tank (typically 0 for calcium-group, 1 for sulfate/phosphate-group). Co-injecting at high concentration risks gypsum/Ca-phosphate precipitation in the venturi.
- Predicted irrigation ppm of element E from tank T = stock_mg_per_l[E] × (venturi_flow / water_pump_flow) × (duty% / 100). Sum across tanks gives total delivered ppm; compare to context.element_targets. If you can't match the target with existing programs, escalate per the rules below.
- Tanks with current_stock_liters near zero will run out mid-cycle — flag this in risks[] and propose a refill recommendation rather than scheduling cycles against an empty tank.

# Critical-element lockouts (HARD CONSTRAINTS — apply-path will refuse to run otherwise)

The operator has accumulated guardrails on top of the soft hard_min/hard_max bounds. These are HARD rules: if a guardrail trips, your plan will be REJECTED at apply time and the operator must manually override with a typed reason. Avoid that — design the plan to satisfy the guardrails up-front and acknowledge them explicitly in the rationale.

The active guardrail set is in context.guardrails[]. Each rule has: element, comparison, threshold, forbidden_action, minimum_tank_duty_pct. Evaluate every rule before submitting:

- For each guardrail, check the latest feed sample of its element (context.today_snapshot.lab.irrigation.latest_per_nutrient[element]).
- If the comparison trips (e.g. "null_or_lt 150" trips when value is missing OR below 150), the rule is ACTIVE.
- When active, NO proposed_automation may reference a dose_program where the element-source tank (any tank whose ingredients have a compatibility_group or composition matching the element) has duty < minimum_tank_duty_pct.
- When active, NO dose_program_request may propose duty < minimum_tank_duty_pct for the element-source tank.
- When active, NO mixture_request may reduce the element's mass in the recipe by more than 20% vs the current tank recipe.

**Active rule today: ca_lockout_below_150.** If feed calcium_Ca is below 150 mg/L (or there's no recent sample), the calcium-source tank (Tank 1, the Ca-nitrate stock) MUST stay at duty ≥ 80% in every fertigation cycle. Three documented Ca crashes in four weeks were all caused by planner-driven dose reductions — this is non-negotiable.

If the operator's stated agronomic problem requires reducing NO3 or EC, and Ca is low: do NOT pick Half Strength (which cuts Tank 1 to 50%). Instead, propose a dose_program_request that keeps Tank 1 at ≥ 80% duty while cutting the OTHER tanks (e.g. Tank 1 at 90%, Tanks 2/4 at 50%). This is the "Reduced-NO3 Ca Priority" pattern.

# Lab data (AMIC) → action mapping (REQUIRED reading)

The AMIC analyzer reports nutrient concentrations in IONIC form (nitrate_NO3, ammonium_NH4, potassium_K, calcium_Ca, magnesium_Mg, sulfate_SO4, phosphate_PO4, chloride_Cl, sodium_Na). These appear in context.today_snapshot.lab[role].today and lab[role].latest_per_nutrient. The same labels exist in context.element_targets so direct comparison is possible — no unit conversion needed when the target's element label matches the lab's nutrient label.

The agronomist snapshot also exposes:
- context.today_snapshot.lab[role].trend[nutrient] — last 3 samples + delta + direction ('rising'/'falling'/'flat'/'single_point'). USE THIS to detect progressive faults rather than reacting to a single point.
- context.today_snapshot.lab[role].derived.effective_N_mg_per_l — elemental N derived from NO3 + NH4 (N/NO3 = 0.226, N/NH4 = 0.778). Use this if the targets only carry "N" instead of "nitrate_NO3".

When an AMIC value is OUTSIDE its hard_min/hard_max for that ion, treat it as a high-priority constraint that overrides comfort:

**For an over-target ion (e.g. NO3 above hard_max):**
1. Identify the tank(s) whose ingredients contribute that ion (Calcium Nitrate → NO3 + Ca; MKP → PO4 + K; K2SO4 → K + SO4; etc. — see context.ingredients_library).
2. **First action — duty cycle reduction.** Pick a published dose program with lower duty% on those tanks, or propose a new dose_program_request that trims them. Compute the new predicted irrigation ppm so the proposed cuts actually move the measured value back into band (lab over-band % → comparable duty% cut). This is the cheap, fast lever.
3. **Second action — mixture swap.** If reducing those tanks' duty% to near-zero would still leave the ion over (because every tank touches it, or because cutting them crashes a priority-1 target like Ca), file a mixture_request that physically lowers that ion's concentration in the stock — e.g. replace MKP+K2SO4 with KNO3+K2SO4 to shift the K source's anion balance, or dilute the Ca-nitrate tank to halve NO3 stock concentration.
4. **Confirm in plan rationale.** Reference the specific lab value, the trend direction, and the tank(s) you targeted — operator approval depends on traceability.

**For an under-target ion:** mirror image. Increase the responsible tank's duty% (or propose a mixture with more of that ion).

**Trend takes precedence over a single high reading.** If trend.direction === 'rising' AND the current value is anywhere in the upper third of the band, propose pre-emptive action — don't wait for the hard_max breach. Conversely, a single high sample with 'falling' direction may just be a measurement artifact — note it in risks[] but don't act.

# Element targets and priorities (REQUIRED reading)

context.element_targets[] is a list of rows {crop_assignment_id, growth_stage, element, hard_min, soft_target, hard_max, priority, notes}. Resolve the active target for a (crop, stage, element) by trying (crop_id, stage) → (crop_id, NULL) → (NULL, NULL) — first match wins.

How to use the bounds:
- **hard_min / hard_max are inviolable.** Never propose a dose program or fertigation cycle whose predicted irrigation ppm goes below hard_min (deficiency floor) or above hard_max (toxicity ceiling) for ANY element with a target on file. If you cannot satisfy all hard bounds with existing tanks + dose programs, escalate (see below). Do NOT silently violate a bound to hit a soft_target.
- **soft_target is the goal.** Within hard bounds, minimize the weighted sum of |delivered - soft_target| across all elements, where weight = (6 - priority). priority=1 weighs 5×, priority=5 weighs 1×.
- **Coupled ingredients are common.** Pushing Tank 1 (Ca-nitrate) up to hit Ca will also raise N. That is FINE as long as N stays within its hard_max. If hitting priority-1 Ca's soft_target would push priority-3 N past N's hard_max, you must lower Ca's ambition to whatever Ca level keeps N legal — Ca over-delivery is preferable to N over-delivery only if Ca's hard_max permits it; otherwise stop at N's hard_max.
- Worked example: Ca priority=1, Ca soft_target=150 (hard_min=120, hard_max=220); N priority=2, N soft_target=150 (hard_min=100, hard_max=220). Tank 1 stock = 21000 ppm N + 19000 ppm Ca, venturi/water = 1/151. Each 1% duty% delivers 0.139 ppm N + 0.126 ppm Ca. To hit Ca=150 requires duty ~119% (impossible — duty caps at 100%). At duty=100% Ca=125 (above hard_min, below soft_target), N=139 (within bounds). That is the best you can do from Tank 1 alone — do NOT exceed 100% duty. If Ca is still short of soft_target, that's the moment to consider a tank recipe change (next section).

# Escalation order when targets cannot be met (REQUIRED reading)

In order, try:
1. **Pick a published dose program** from context.dose_programs whose predicted ppm satisfies all hard bounds and gets soft_targets as close as the weighted objective allows.
2. **Request a new dose program** (dose_program_requests[]) when no published program fits — e.g. an existing program is close but the duty% on one tank needs to change.
3. **Request a mixture swap** (mixture_requests[]) — ONLY when no per-tank duty% across any conceivable program can satisfy a priority-1 or priority-2 hard_min/hard_max, because the underlying tank recipes physically cannot produce the needed element mix. Mixture swaps cost the operator labor + downtime; use sparingly.

When proposing a mixture (mixture_requests[]):
- Use ONLY ingredient names from context.ingredients_library — do not invent compounds.
- Respect compatibility_group: a single tank must contain ingredients from at most ONE of {calcium, sulfate, phosphate}. micro/humic/acid/base can co-exist with most things but check notes.
- Standard hydroponic recipes (for inspiration): A-tank = Ca-nitrate ± Mg-nitrate (calcium group); B-tank = K-sulfate + MKP or KNO₃ (sulfate/phosphate); separate micro tank; separate pH tank. Mirror these patterns unless the deficit explicitly calls for something else.
- target_tank_id should point at the existing tank whose role best matches the new recipe — typically the one whose CURRENT recipe is least useful to the deficit (e.g. swap a redundant K-stock tank rather than the calcium tank).
- Compute expected_stock_mg_per_l yourself: for each ingredient, mass_kg × (composition[element]/100) × 1e6 / water_base_liters mg/L, summed across ingredients.

# Designing a tank recipe from crop targets (REQUIRED reading)

You now have everything needed to compute an exact recipe — ingredient masses per 1000-L tank — that will deliver target ppm in the irrigation feed. Use this when a mixture_request is warranted.

Givens (all in context):
- T_E   = target irrigation feed ppm for element E (element_targets[].soft_target, in elemental form like "N" or ionic like "nitrate_NO3" — both supported).
- D     = dilution ratio = venturi_flow / water_pump_flow. Each tank exposes its own as fertigation_tanks[].dilution_ratio (e.g. 1.7/257.5 ≈ 0.00660 for fertigation eq 2 tanks).
- d     = planned duty cycle of that tank under the dose program (decimal 0–1). For recipe design assume d = 1.0 (100%) so the recipe scales linearly with duty later.
- V     = tank water_base_liters (typically 1000).
- c_i,E = elemental composition fraction of ingredient i for element E (ingredients_library[].composition[E] / 100).

Conversion ↔ ionic forms:
context.ionic_equivalence maps each ion to its elemental anchor: factor_to_element (mass fraction of element in ion), factor_to_ion (reciprocal). Example: NO3 target 800 mg/L ≡ N target 800 × 0.226 = 181 mg/L. The math below is in elemental form; convert ionic targets to elemental first.

Required stock concentration (mg/L of element E in the tank's stock solution):
    stock_E = T_E / (D × d)

Required mass of an ingredient that carries E:
    mass_i_kg = (stock_E × V) / (c_i,E × 1e6)

Worked example — Tank 1 redesign for current capsicum issue:

Inputs: V=1000 L, D=0.00660 (1:151), d=1.0, target Ca=200 mg/L (priority 1), target N=181 mg/L (≡ NO3 800 mg/L), ingredient Calcium Nitrate has c_N=0.155, c_Ca=0.19.

Step 1: bound element is the priority-1 target → Ca = 200 mg/L.
    stock_Ca needed = 200 / (0.00660 × 1.0) = 30,303 mg/L
    mass_CaNO3      = 30,303 × 1000 / (0.19 × 1e6) ≈ 159.5 kg

Step 2: cross-check N delivery from that mass.
    stock_N from 159.5 kg CaNO3 = 159.5 × 0.155 × 1e6 / 1000 = 24,723 mg/L
    feed_N delivered            = 24,723 × 0.00660 × 1.0     = 163 mg/L N
                                ≡ 163 / 0.226                = 721 mg/L NO3  ✓ in band (target 800, hard_max 1100)

Step 3: if Mg target also needs Tank 1, add Mg-nitrate similarly (c_Mg=0.095, c_N=0.11). Recompute combined N to confirm hard_max not exceeded.

Step 4: write the recipe into mixture_requests[] ingredients string:
    [{"name":"Calcium Nitrate","amount":159.5,"unit":"kg"},{"name":"Magnesium Nitrate","amount":<solved>,"unit":"kg"}]

Cross-check rule (do this before submitting): for every element_targets row that this tank touches (even priority-3 or 4), compute predicted feed ppm at d=1.0. If ANY element ends up outside its hard_min/hard_max, the recipe is invalid — revise ingredient mix or reduce duty cycle assumption. Don't crash a low-priority element to optimize a high-priority one.

When operator should physically remix vs when planner can just trim duty:
- If the current stock recipe + reduced duty% can hit all hard bounds → propose a dose_program_request only (cheaper, no operator labor).
- If duty% can't go low enough on the offending tank without violating another priority-1 element's hard_min → file a mixture_request with the calculated kg amounts. Operator approves, physically remixes at next refill.
- For the current NO3=2238 situation: the existing 100 kg CaNO3 / 1000 L stock at d=100% delivers ~700 ppm Ca and ~720 ppm N (in band). The problem is the current tank somehow ended up over-strength — fresh AMIC sample will tell whether it's a stock-mixing error or analyzer drift. Until confirmed, propose a duty cut + a precautionary mixture_request showing what the recipe should be.

# Core constraints

- Two trigger types are supported. Choose the right one:
  - "schedule" — time-of-day rules: fertigation cycles, drain flushes, daily ops log entries. trigger_config: {type:"schedule", schedule_type:"daily", time:"HH:MM", ...sentinels}.
  - "threshold" — climate-control rules: fans, chillers, heaters, dehumidifiers. trigger_config: {type:"threshold", sensor_equipment_id, sensor_metric, operator, threshold_value, threshold_unit, ...sentinels}.
- Every action must reference an equipment_id and channel that actually exists in the inventory you are given. Never invent ids. If you can't tie an action to a real channel, omit it.
- Use sensible durations and stagger times. Avoid scheduling overlapping channels on the same equipment within 60 seconds of each other unless that overlap is the point (e.g. mixing pump runs concurrently with feed pump).
- Quantify everything: minutes, liters (if flow_rate is known), times of day, °C, %, etc. No vague language.
- Prefer the simplest plan that satisfies today's lessons. Don't propose 12 automations if 4 will do.
- Output is JSON. No prose outside the JSON fields. The 'summary' field IS your prose channel.

# Climate-control automation rules (threshold triggers — REQUIRED reading)

Threshold rules are the easiest place to introduce oscillation, alert-spam, and conflicting writes. Follow these rules without exception:

1. **PAIRED ON/OFF.** Every threshold rule that turns equipment ON must have a companion rule that turns it OFF. Same equipment, same channels, opposite operator. Example:
   - "Fans on": Temperature gt 30°C → ON fan channels
   - "Fans off": Temperature lt 26°C → OFF those same channels
2. **HYSTERESIS GAP ≥ 3°C** (or ≥ 10% RH, ≥ 0.3 EC units). The ON threshold and OFF threshold must differ by at least this gap. Never share a boundary value between any two rules — if fans-off is 26°C, NOTHING else uses 26°C. Two rules sharing a boundary creates rapid on-off-on-off oscillation.
3. **PER-CHANNEL ACTIONS ONLY for OFF.** Never emit an "off" action with channel:0 (whole-device). The OFF rule must list each channel explicitly, mirroring the channels its companion ON turned on. Whole-device OFF wipes out unrelated channels (e.g. it can kill a chiller relay sitting on the same board as the fans).
4. **NO CONFLICTING WRITES on the same channel.** Two threshold rules must never write to the same (equipment_id, channel) at the same threshold — one will always lose. If two cooling stages share a channel by mistake, the engine flaps.
5. **ESCALATION = alert, not duplicate control.** If a "very hot" rule is meant to warn the operator, its action MUST be type:"alert" with severity:"critical", NOT a second control action. Use control only when you actually intend to drive more equipment.
6. **SENSOR_METRIC IS REQUIRED.** Many sensors emit multiple metrics (the SHT20 returns both "Temperature" and "Humidity" on one equipment_id). Specify sensor_metric EXACTLY as it appears in readings.name. Don't guess — read it from equipment[].channels or from today_snapshot.sensor_readings[].metric.
7. **PRESERVE OPERATOR INTENT.** If existing climate automations have bugs (whole-device OFFs, missing hysteresis, shared boundaries), propose change_type="modify" to FIX them — do not propose "remove" unless the underlying control intent itself is wrong. The agronomist may have flagged these as noisy, but the right answer is usually to repair them, not delete them.

# Known engine quirk (operator must be aware)

The threshold engine currently fires a rule on EVERY poll where the condition is true, not only on the edge. This causes high run_count and Modbus spam but does not change the relay's physical state. Until the engine is patched, your job is to compose rules that REACH stable resting state quickly (proper hysteresis pairs) so the spammed re-fires are no-ops against an already-correct relay state.

# Closed-loop targets (NEW — required)

You MUST declare measurable targets[] for tomorrow's plan. At minimum, cover the dynamic factors that we score deterministically each day:
- Substrate moisture (VWC %) — the metric you want to keep in band throughout the active grow hours.
- Canopy / air temperature — both the daylight band and the dark band if relevant.
- Drain EC — when a drainage sensor is available.

Each target links to specific automation indexes in proposed_automations[] via owner_automation_indexes. This is how we trace cause→effect across days.

Pick the band based on the active crop's optimal_ranges if provided. Pick acceptance from the whitelisted list — be honest: time_in_range>=0.95 only when you genuinely think the strategy will hold that tight. For new untuned strategies, time_in_range>=0.75 is more realistic.

# Closed-loop reflection (NEW — required)

You will be given yesterday_full_scorecard and today_partial_scorecard if prior plans had targets. Populate yesterday_review:
- overall_grade: aggregate verdict
- target_outcomes[]: per-target diagnosis. For each FAIL/PARTIAL, name the likely cause (e.g. "VWC dipped 13:00-15:00 — heat-driven dry-down outpaced cycles").
- strategy_adjustments_hypothesis: ONE sentence summarizing what you're changing tomorrow and why you think it will work.

If no prior plan had targets, set overall_grade="no_prior_targets" and leave the other fields empty.

# Bounded changes (NEW — strict)

Tomorrow's plan must NOT be a wholesale rewrite of today's. Constrain changes to:
- Cycle count: ±2 vs current_automations (you can add or remove at most 2 fertigation cycles per zone).
- Time shifts: ±30 min — if current plan runs at 12:00, tomorrow it can be 11:30–12:30, not 09:00.
- Volume / duration: ±20% per cycle.
- At most 1 experimental cycle per day (something genuinely new, not a tweak).
- ANTI-FLIP rule: if yesterday you adjusted a target's strategy and it didn't hit, do NOT reverse the adjustment. Try a DIFFERENT lever (e.g. don't shorten then re-lengthen the same cycle — instead, split into smaller cycles, or adjust upstream EC).

# changes_from_today is the APPLY manifest (NEW — strict)

The operator will Confirm or Reject your plan. On Confirm, code walks changes_from_today and mutates the automations table:
- change_type="add": INSERT new automation from proposed_automations[proposed_automation_index]. current_automation_id MUST be 0.
- change_type="modify": UPDATE automations.id = current_automation_id with content from proposed_automations[proposed_automation_index].
- change_type="remove": DISABLE automations.id = current_automation_id. proposed_automation_index MUST be -1.
- change_type="keep": no-op (the existing automation stays as-is). Reference both ids.

EVERY existing automation in current_automations[] must be represented in changes_from_today as exactly one of: modify, remove, or keep. Don't leave gaps. EVERY entry in proposed_automations[] must be referenced by exactly one add/modify/keep entry.

Index-integrity rule (REQUIRED self-check): After writing both arrays, COUNT proposed_automations. Then audit every changes_from_today.proposed_automation_index: each value must be in [0, count). If you find an out-of-range index, fix it before submitting — common causes are forgetting to update references after reordering, or counting an entry you ended up not emitting. When change_type="modify" but the existing automation actually requires no change, use change_type="keep" (with current_automation_id, no proposed_automation_index needed) — don't write modify-with-identical-content. The apply path now recovers from index drift via name matching when possible, but a correct plan eliminates the warning entirely.

No-duplicates rule (REQUIRED self-check): Before submitting, scan proposed_automations for entries that would produce a duplicate of something already in current_automations[]. A duplicate is two automations with the same trigger_config AND substantively-overlapping actions on the same equipment+channel. For each existing automation whose trigger/action shape matches a proposed entry, use change_type="modify" pointing at the existing current_automation_id — NOT change_type="add" with a new copy. Adding a new copy causes the rule to fire twice on every trigger event, doubling Modbus writes and creating spurious drift warnings. If you genuinely want to retire the existing one and replace it, emit BOTH change_type="remove" (on the old id) AND change_type="add" (for the new spec); never let an "add" create a silent runtime twin of a still-enabled current automation.

# Operational philosophy

- Daytime fertigation cycles (typically 06:00, 12:00, 17:00 in UAE summer; 07:00, 13:00 in winter) — adjust based on conditions.
- Avoid running irrigation when sensors indicate the substrate is already saturated.
- Drain cycles should be scheduled after the last fertigation of the day.
- **CRITICAL — irrigation cycle shape:** Every fertigation cycle and water-only flush MUST open at least one zone valve while the pumps run. The "Fertigation cycle with dose program" template handles this: it opens 4 zone valves sequentially (Zone 1 → 2 → 3 → 4) while the Irrigation Pump and Mixing Pump run for the full duration. NEVER emit a fertigation automation that fires only pump_channel + mixing_channel without zone1/2/3/4_channel — water will pool in the mixing tank because the pumps push against closed valves. If you fall back to a raw automation, you MUST include the zone-valve control actions (sequential, not parallel — opening multiple zones at once drops pump pressure).
- **Substrate diagnostics** (context.today_snapshot.substrate_diagnostics[]) are organized PER ZONE — multiple sensors in one zone are redundant cross-checks (e.g. two probes in two coco peat bags), aggregated via median. Each zone entry has zone_avg, zone_dry_down_median_pct, classification, hint, sensor_disagreement_pct, and a per-sensor breakdown. ALWAYS check this before changing the irrigation schedule:
  - "flat_saturated" → zone median dry-down per cycle < 0.3%. Drainage at the zone level is restricted — reducing irrigation will NOT fix it. Flag a "physical drain inspection" risk and DO NOT cut cycle frequency for this zone until the operator clears the drain issue.
  - "over_irrigated" → zone is draining but VWC sits above target. THIS is when reducing cycle cadence or per-cycle duration is the right call. Propose a schedule change for this zone.
  - "under_irrigated" → cycles too sparse; add a cycle or extend duration.
  - "healthy" → no action.
  - "no_cycles" / "borderline" → flag for operator review.
- **sensor_mismatch_warning**: when redundant sensors in the same zone disagree by more than ~4% mean VWC for the day, this field is populated. Treat it as a SEPARATE risk from the zone's main classification — one coco peat bag may have a localized drainage issue or one probe is fouled. Surface it under risks[] with "physical inspection of both probes / bags" — do not blindly trust the zone median when the sensors strongly disagree.
- If AMIC nutrient data shows a clear deficiency/excess, surface it as a 'risk' rather than mutating the dose blindly — the operator decides.
- If a sensor lost comms, don't trust its readings; reduce the weight of that signal in your decisions.
- If the agronomist's daily report has recommendations, treat them as expert input and reflect them in the plan (or explain in 'rationale' why not).

# Rejection regeneration (if previous_rejection is set in context)

The operator rejected your previous attempt at tomorrow's plan and provided written feedback. Address it concretely:
- Read previous_rejection.feedback carefully.
- In lessons_learned, acknowledge what the operator told you.
- Adjust the new plan to reflect the feedback — don't just rephrase the old plan.`;

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    headline: {
      type: 'string',
      description: '1-2 sentence direct opinion summarizing what tomorrow looks like and what changed vs today.',
    },
    summary: {
      type: 'string',
      description: 'Self-contained ≤500-char paragraph: what is being proposed and why. This becomes part of the rolling history.',
    },
    proposed_automations: {
      type: 'array',
      description: 'The full set of automations to run tomorrow. Each one matches the live automations table shape.',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Short human-readable name, e.g. "Morning fertigation (06:00)"' },
          description: { type: 'string', description: 'What this automation does and why it is included in tomorrow\'s plan.' },
          enabled: { type: 'boolean', description: 'Always true for proposed automations.' },
          priority: { type: 'integer', description: '0 = normal. Higher values run earlier when due simultaneously.' },
          trigger_config: {
            type: 'object',
            description: 'Trigger. type="schedule" for time-of-day rules; type="threshold" for sensor-driven rules (fans, chillers). Set non-applicable fields to sentinels: "" for strings, 0 for numbers.',
            properties: {
              type: { type: 'string', enum: ['schedule', 'threshold'] },
              schedule_type: { type: 'string', description: '"daily" for schedule; "" for threshold.' },
              time: { type: 'string', description: 'HH:MM for schedule, e.g. "06:00"; "" for threshold.' },
              sensor_equipment_id: { type: 'integer', description: 'equipment.id; 0 for schedule.' },
              sensor_metric: { type: 'string', description: 'Exact readings.name (e.g. "Temperature", "Humidity"); "" for schedule. Multi-metric sensors REQUIRE this.' },
              operator: { type: 'string', description: 'gt | gte | lt | lte; "" for schedule.' },
              threshold_value: { type: 'number', description: 'Numeric threshold; 0 for schedule.' },
              threshold_unit: { type: 'string', description: 'Display unit e.g. "°C"; "" for schedule.' },
            },
            required: ['type', 'schedule_type', 'time', 'sensor_equipment_id', 'sensor_metric', 'operator', 'threshold_value', 'threshold_unit'],
            additionalProperties: false,
          },
          actions_json: {
            type: 'string',
            description: 'JSON array string used ONLY for raw fallback (template_id=0). Use "[]" when template_id>0 since the template provides actions. Each action object: {type, action, equipment_id, channel, delay_seconds, duration_seconds, severity, message}. type ∈ {control, alert, log}. For control: action="on"|"off". Always specify channel (1-based) for per-channel control; never use 0 for OFF actions.',
          },
          template_id: {
            type: 'integer',
            description: 'PREFERRED PATH: id of an existing automation_template to instantiate. 0 = no template (raw fallback — only when no template fits). When >0, you MUST provide template_parameters and you may leave actions[] empty.',
          },
          template_parameters: {
            type: 'string',
            description: 'JSON object of parameter values, e.g. \'{"equipment_id":"3","channel":"1","duration_min":"8"}\'. Use "{}" when template_id=0. Values may be quoted strings or unquoted numbers — the validator coerces to each parameter\'s declared type.',
          },
          dose_program_id: {
            type: 'integer',
            description: 'For fertigation cycles: id of a published dose program from context.dose_programs that controls per-tank duty cycles. 0 = not a fertigation automation (or fallback when no program fits — in that case ADD an entry to dose_program_requests[]).',
          },
          rationale: {
            type: 'string',
            description: 'Why this automation is in the plan: which data point or recommendation justifies it.',
          },
        },
        required: ['name', 'description', 'enabled', 'priority', 'trigger_config', 'actions_json', 'template_id', 'template_parameters', 'dose_program_id', 'rationale'],
        additionalProperties: false,
      },
    },
    changes_from_today: {
      type: 'array',
      description: 'Diff manifest vs the current automation set. This is the APPLY plan: a Confirm walks this list. Every current automation that should be disabled MUST appear with change_type="remove". Every proposed automation must appear with change_type in {add, modify, keep}. Use real ids.',
      items: {
        type: 'object',
        properties: {
          change_type: { type: 'string', enum: ['add', 'remove', 'modify', 'keep'] },
          target: { type: 'string', description: 'Human-readable label for verification (e.g. the existing or proposed name).' },
          detail: { type: 'string', description: 'What is changing.' },
          rationale: { type: 'string', description: 'Why, tied to today\'s data or to a target outcome.' },
          current_automation_id: { type: 'integer', description: 'For modify/remove/keep: the existing automations.id. 0 for add.' },
          proposed_automation_index: { type: 'integer', description: 'For add/modify/keep: the 0-based index into proposed_automations[]. -1 for remove.' },
        },
        required: ['change_type', 'target', 'detail', 'rationale', 'current_automation_id', 'proposed_automation_index'],
        additionalProperties: false,
      },
    },
    targets: {
      type: 'array',
      description: 'Measurable outcomes tomorrow\'s plan is designed to achieve. Required for closed-loop scoring. Cover at minimum the dynamic factors: substrate moisture, canopy/air temperature, and drain EC (when available).',
      items: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Short logical name, e.g. "substrate_vwc_pct", "canopy_temp_c", "drain_ec".' },
          sensor_equipment_id: { type: 'integer', description: 'equipment.id of the sensor that produces this metric. Must exist in the inventory.' },
          sensor_metric: { type: 'string', description: 'Exact readings.name (e.g. "Substrate Moisture", "Temperature"). "" for single-metric sensors.' },
          window: { type: 'string', description: 'Scoring window: "all_day" | "daylight" (06:00-18:00) | "dark" (18:00-06:00) | "HH:MM-HH:MM" for custom.' },
          min: { type: 'number', description: 'Lower bound of acceptable range.' },
          max: { type: 'number', description: 'Upper bound of acceptable range.' },
          acceptance: { type: 'string', description: 'Whitelisted: "time_in_range>=0.75" | "time_in_range>=0.85" | "time_in_range>=0.95" | "peak_excursion<=5" | "peak_excursion<=10" | "peak_excursion<=20" | "mean_within_range".' },
          owner_automation_indexes: { type: 'array', items: { type: 'integer' }, description: '0-based indexes into proposed_automations[] that drive this target.' },
          rationale: { type: 'string', description: 'Why this target, this band, this acceptance level.' },
        },
        required: ['key', 'sensor_equipment_id', 'sensor_metric', 'window', 'min', 'max', 'acceptance', 'owner_automation_indexes', 'rationale'],
        additionalProperties: false,
      },
    },
    yesterday_review: {
      type: 'object',
      description: 'Closed-loop reflection on the prior plan(s) you were given scorecards for. If no prior plan had targets, set overall_grade="no_prior_targets" and leave the rest empty.',
      properties: {
        overall_grade: { type: 'string', description: '"pass" | "partial" | "fail" | "no_prior_targets".' },
        target_outcomes: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              target_key: { type: 'string' },
              verdict: { type: 'string', description: '"pass" | "partial" | "fail" | "uncomputable".' },
              observed_summary: { type: 'string', description: 'One-line characterization of what actually happened.' },
              likely_cause: { type: 'string', description: 'For partial/fail: what you think drove the miss.' },
            },
            required: ['target_key', 'verdict', 'observed_summary', 'likely_cause'],
            additionalProperties: false,
          },
        },
        lessons_learned: { type: 'string', description: 'What today\'s data taught about the prior strategy.' },
        strategy_adjustments_hypothesis: { type: 'string', description: 'The hypothesis driving tomorrow\'s changes. ONE sentence. If yesterday\'s adjustment didn\'t help, change a different lever, not the reverse.' },
      },
      required: ['overall_grade', 'target_outcomes', 'lessons_learned', 'strategy_adjustments_hypothesis'],
      additionalProperties: false,
    },
    risks: {
      type: 'array',
      description: 'Risks the operator should be aware of but the planner is NOT auto-acting on.',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', description: '"low" | "medium" | "high".' },
          risk: { type: 'string' },
          suggested_human_action: { type: 'string' },
        },
        required: ['severity', 'risk', 'suggested_human_action'],
        additionalProperties: false,
      },
    },
    template_requests: {
      type: 'array',
      description: 'When no existing template covered a need and you fell back to raw automation, request a template here so the operator can author it. Empty array if every proposed automation used an existing template.',
      items: {
        type: 'object',
        properties: {
          proposed_name: { type: 'string' },
          purpose: { type: 'string', description: 'When to use it, what it does.' },
          parameters_needed: { type: 'string', description: 'Comma-separated list of parameters the template should accept.' },
          example_use: { type: 'string', description: 'A concrete example: the automation you fell back to writing raw.' },
        },
        required: ['proposed_name', 'purpose', 'parameters_needed', 'example_use'],
        additionalProperties: false,
      },
    },
    dose_program_requests: {
      type: 'string',
      description: 'JSON array string of NEW dose programs to propose when no published program in context.dose_programs fits. Use "[]" if none. Each entry is an object: {proposed_name, purpose, target_ppm (JSON object string), target_ec (string), target_ph (string), window_seconds (integer), compatibility_strategy ("permissive"|"time_slice"), duty_cycles (JSON array of {tank_id, duty_pct, compatibility_slot?}), rationale}. Example: \'[{"proposed_name":"Higher Ca","purpose":"hit Ca soft_target","duty_cycles":"[{\\"tank_id\\":1,\\"duty_pct\\":100}]","rationale":"Ca short of soft_target at current duty"}]\'.',
    },
    mixture_requests: {
      type: 'string',
      description: 'JSON array string of NEW tank recipes to propose when no duty-cycle adjustment can hit element_targets. Use "[]" if none. Each entry is an object: {proposed_name, target_tank_id (integer from context.fertigation_tanks), purpose, ingredients (JSON array of {name, amount, unit}; name MUST be from context.ingredients_library), expected_stock_mg_per_l (JSON object string), rationale}. Respect compatibility_group: never mix calcium with sulfate or phosphate in one tank. Most expensive action — use sparingly.',
    },
  },
  required: ['headline', 'summary', 'proposed_automations', 'changes_from_today', 'targets', 'yesterday_review', 'risks', 'template_requests', 'dose_program_requests', 'mixture_requests'],
  additionalProperties: false,
};

class OperationalPlannerService {
  constructor() {
    this._client = null;
  }

  // -------- config --------

  getConfig() {
    const defaults = {
      enabled: false,
      model: DEFAULT_MODEL,
      schedule_hour: 18,
      schedule_minute: 0,
      preview_only: true, // when true, plans are NEVER instantiated as real automations
    };
    try {
      const row = db.prepare('SELECT value FROM system_settings WHERE key = ?').get(CONFIG_KEY);
      if (row?.value) return { ...defaults, ...JSON.parse(row.value) };
    } catch {}
    return defaults;
  }

  saveConfig(updates) {
    const merged = { ...this.getConfig(), ...updates };
    const persisted = {
      enabled: !!merged.enabled,
      model: merged.model || DEFAULT_MODEL,
      schedule_hour: Math.max(0, Math.min(23, parseInt(merged.schedule_hour) || 18)),
      schedule_minute: Math.max(0, Math.min(59, parseInt(merged.schedule_minute) || 0)),
      // preview_only is intentionally not user-toggleable until we wire up real creation
      preview_only: true,
    };
    db.prepare(
      "INSERT INTO system_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    ).run(CONFIG_KEY, JSON.stringify(persisted));
    return persisted;
  }

  _client_or_throw() {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY is not set in the backend environment');
    }
    if (!this._client) {
      this._client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    }
    return this._client;
  }

  // -------- context aggregation --------

  /** Returns the latest-version row for a given plan_date, or null. */
  _latestPlanForDate(dateStr) {
    const row = db.prepare(`
      SELECT * FROM operational_plans
      WHERE plan_date = ?
      ORDER BY version DESC LIMIT 1
    `).get(dateStr);
    return this._hydrate(row);
  }

  /** Gather the rich operational context: today's snapshot + agronomist report + current automations + equipment + zones + closed-loop scorecards. */
  buildPlanningContext(todayStr, opts = {}) {
    const dailySnapshot = agronomistService.aggregateDailyData(todayStr);

    // Today's agronomist report (most recent successful, may be today's if generated before planner)
    const agronReport = db.prepare(`
      SELECT report_date, opinion, summary, recommendations
      FROM agronomist_reports
      WHERE status = 'success' AND report_date <= ?
      ORDER BY report_date DESC LIMIT 1
    `).get(todayStr);

    let agronomistContext = null;
    if (agronReport) {
      let recs = [];
      try { recs = agronReport.recommendations ? JSON.parse(agronReport.recommendations) : []; } catch {}
      agronomistContext = {
        report_date: agronReport.report_date,
        opinion: agronReport.opinion,
        summary: agronReport.summary,
        recommendations: recs,
      };
    }

    // Current automations baseline — only the bits the planner needs to make diff decisions
    const currentAutomations = db.prepare(`
      SELECT id, name, description, enabled, priority, trigger_config, conditions, actions, last_run
      FROM automations
    `).all().map(a => {
      const parse = s => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
      return {
        id: a.id,
        name: a.name,
        description: a.description,
        enabled: !!a.enabled,
        priority: a.priority || 0,
        trigger_config: parse(a.trigger_config),
        conditions: parse(a.conditions) || [],
        actions: parse(a.actions) || [],
        last_run: a.last_run,
      };
    });

    // Equipment inventory — only relays + their channel labels (the planner needs to know what it can control)
    const equipment = db.prepare(`
      SELECT id, name, type, address, slave_id, status, register_mappings FROM equipment
      WHERE type IN ('relay', 'fertigation', 'irrigation', 'dosing', 'controller', 'modbus_relay')
         OR name LIKE '%relay%' OR name LIKE '%irrigation%' OR name LIKE '%fertigation%' OR name LIKE '%dosing%'
    `).all();

    const channelConfigs = db.prepare(`
      SELECT rcc.equipment_id, rcc.channel, rcc.ingredient_name, rcc.flow_rate, rcc.flow_unit,
             fm.name AS mixture_name
      FROM relay_channel_config rcc
      LEFT JOIN fertigation_mixtures fm ON rcc.mixture_id = fm.id
    `).all();

    const equipmentInventory = equipment.map(eq => {
      // Build a {channel -> label} index from the equipment's register_mappings so the
      // planner sees pumps vs delivery valves vs unconfigured coils without depending
      // on relay_channel_config (which only carries delivery-relevant data).
      const coilLabels = {};
      try {
        const maps = eq.register_mappings ? JSON.parse(eq.register_mappings) : [];
        for (const m of maps) {
          if (m.type !== 'coil') continue;
          const ch = parseInt(m.register ?? m.address);
          if (!Number.isFinite(ch)) continue;
          coilLabels[ch] = m.name || m.label || `Coil ${ch}`;
        }
      } catch (_) {}

      // Start from the coil mappings (so every physically-present channel shows up
      // labeled, even if it has no relay_channel_config row) and overlay any
      // delivery config (flow_rate, ingredient, mixture).
      const byChannel = {};
      for (const [chStr, label] of Object.entries(coilLabels)) {
        const ch = parseInt(chStr);
        byChannel[ch] = { channel: ch, label, ingredient: null, mixture: null, flow_rate: null, flow_unit: null };
      }
      for (const c of channelConfigs) {
        if (c.equipment_id !== eq.id) continue;
        const row = byChannel[c.channel] || { channel: c.channel, label: coilLabels[c.channel] || null };
        row.ingredient = c.ingredient_name;
        row.mixture = c.mixture_name;
        row.flow_rate = c.flow_rate;
        row.flow_unit = c.flow_unit;
        byChannel[c.channel] = row;
      }
      const channels = Object.values(byChannel).sort((a, b) => a.channel - b.channel);

      return {
        id: eq.id, name: eq.name, type: eq.type,
        status: eq.status,
        channels,
      };
    });

    // Zones + active crops
    const zones = db.prepare('SELECT id, name FROM zones').all();
    const activeCrops = db.prepare(`
      SELECT id, zone_id, crop_name, variety, current_stage, days_since_planting, growth_cycle_days,
             plant_count, max_capacity, soil_type, substrate_volume_l_per_plant, optimal_ranges
      FROM crop_assignments WHERE active = 1
    `).all().map(c => {
      let opt = null;
      try { opt = c.optimal_ranges ? JSON.parse(c.optimal_ranges) : null; } catch {}
      return { ...c, optimal_ranges: opt };
    });

    // Available automation templates — the PRIMARY way the agent composes automations.
    const templates = db.prepare(`
      SELECT id, name, description, category, parameters, agent_usage_notes,
             default_trigger_type, instantiation_trigger, is_system
      FROM automation_templates
      ORDER BY is_system DESC, category, name
    `).all().map(t => ({
      id: t.id,
      name: t.name,
      description: t.description,
      category: t.category,
      agent_usage_notes: t.agent_usage_notes,
      default_trigger_type: t.default_trigger_type,
      parameters: (() => { try { return JSON.parse(t.parameters || '[]'); } catch { return []; } })(),
      instantiation_trigger: (() => { try { return t.instantiation_trigger ? JSON.parse(t.instantiation_trigger) : null; } catch { return null; } })(),
      is_system: !!t.is_system,
    }));

    // Past plans (compounding memory — latest version per plan_date, most recent 5)
    const recentPlans = db.prepare(`
      SELECT plan_date, MAX(version) AS version FROM operational_plans
      WHERE plan_date < ? AND status IN ('confirmed', 'pending', 'rejected')
      GROUP BY plan_date
      ORDER BY plan_date DESC LIMIT 5
    `).all(this._tomorrowOf(todayStr)).reverse().map(rv => {
      const row = db.prepare(`
        SELECT plan_date, version, status, headline, summary, applied_at, rejection_feedback
        FROM operational_plans
        WHERE plan_date = ? AND version = ?
      `).get(rv.plan_date, rv.version);
      return row || null;
    }).filter(Boolean);

    // Closed-loop scorecards: score the latest plan for yesterday (full day) and for today (partial, up to now).
    const yesterdayStr = this._yesterdayOf(todayStr);
    const yesterdayPlan = this._latestPlanForDate(yesterdayStr);
    const todayPlan = this._latestPlanForDate(todayStr);
    const yesterdayScorecard = yesterdayPlan ? this.computeScorecard(yesterdayPlan) : null;
    const todayPartialScorecard = todayPlan ? this.computeScorecard(todayPlan, { stopAtMs: Date.now() }) : null;

    // Rejection feedback context (set by caller when regenerating after a reject)
    const previousRejection = opts.previous_rejection || null;

    // Fertigation tanks — each is a physical stock container bound (optionally) to a
    // valve channel. The planner uses this to reason about what each tank delivers and
    // which dose programs are feasible.
    const tanksRaw = db.prepare(`
      SELECT t.id, t.name, t.role, t.equipment_id, t.channel, t.capacity_liters,
             t.water_base_liters, t.current_stock_liters, t.mixture_id, t.active,
             m.name as mixture_name
      FROM fertigation_tanks t
      LEFT JOIN fertigation_mixtures m ON t.mixture_id = m.id
      ORDER BY t.id
    `).all();
    // Site-wide water-pump flow used as the dilution denominator. Average of
    // every relay_channel_config row labelled 'Water' (the irrigation zone
    // valves) so a single-zone change doesn't skew the figure.
    const waterPumpFlow = (() => {
      const row = db.prepare(`
        SELECT AVG(flow_rate) as f FROM relay_channel_config
        WHERE ingredient_name = 'Water' AND flow_rate > 0
      `).get();
      return row && row.f > 0 ? Math.round(row.f * 100) / 100 : null;
    })();

    const fertigationTanks = tanksRaw.map(t => {
      const items = t.mixture_id ? db.prepare(`
        SELECT fi.name, mi.amount, mi.unit, fi.composition, fi.compatibility_group
        FROM fertigation_mixture_items mi
        JOIN fertigation_ingredients fi ON mi.ingredient_id = fi.id
        WHERE mi.mixture_id = ?
      `).all(t.mixture_id) : [];
      // Compute stock mg/L per element (same math as the API's ppm-preview, but inlined
      // so the planner has the numbers ready without an extra LLM thought-step).
      const stockMgPerL = {};
      if (t.water_base_liters > 0) {
        for (const it of items) {
          if (!it.amount) continue;
          const massKg = it.unit === 'L' ? it.amount * 1 : it.unit === 'mL' ? it.amount / 1000 : it.unit === 'g' ? it.amount / 1000 : it.amount;
          let comp = {};
          try { comp = it.composition ? JSON.parse(it.composition) : {}; } catch (_) {}
          for (const [el, pct] of Object.entries(comp)) {
            const mg = massKg * (pct / 100) * 1e6;
            stockMgPerL[el] = (stockMgPerL[el] || 0) + mg / t.water_base_liters;
          }
        }
      }
      const roundedStock = {};
      for (const [k, v] of Object.entries(stockMgPerL)) roundedStock[k] = Math.round(v * 100) / 100;

      // Per-tank flow data — venturi rate from the tank's bound channel; dilution
      // ratio = venturi / water_pump. Precomputing here saves the LLM from
      // cross-referencing channels + arithmetic on every recipe proposal.
      let venturiLpm = null;
      if (t.equipment_id && t.channel != null) {
        const ch = db.prepare(`
          SELECT flow_rate FROM relay_channel_config
          WHERE equipment_id = ? AND channel = ?
        `).get(t.equipment_id, t.channel);
        if (ch && ch.flow_rate > 0) venturiLpm = ch.flow_rate;
      }
      const dilution = (venturiLpm && waterPumpFlow) ? venturiLpm / waterPumpFlow : null;

      return {
        id: t.id, name: t.name, role: t.role,
        equipment_id: t.equipment_id, channel: t.channel,
        capacity_liters: t.capacity_liters, water_base_liters: t.water_base_liters,
        current_stock_liters: t.current_stock_liters,
        active: !!t.active,
        mixture_name: t.mixture_name,
        ingredients: items.map(it => ({ name: it.name, amount: it.amount, unit: it.unit, compatibility_group: it.compatibility_group })),
        stock_mg_per_l: roundedStock,
        venturi_lpm: venturiLpm,
        water_pump_lpm: waterPumpFlow,
        dilution_ratio: dilution ? Math.round(dilution * 1e6) / 1e6 : null,
        dilution_label: dilution ? `1 : ${Math.round(1 / dilution)}` : null,
      };
    });

    // Ionic ↔ elemental conversion factors so the planner can flip between forms
    // without doing molecular-weight arithmetic. factor_to_element = (atomic weight
    // of the element) / (molecular weight of the ion). factor_to_ion = inverse.
    const ionicEquivalence = {
      nitrate_NO3:   { element: 'N', factor_to_element: 0.226, factor_to_ion: 4.43 },
      ammonium_NH4:  { element: 'N', factor_to_element: 0.778, factor_to_ion: 1.29 },
      phosphate_PO4: { element: 'P', factor_to_element: 0.326, factor_to_ion: 3.06 },
      potassium_K:   { element: 'K', factor_to_element: 1.0,   factor_to_ion: 1.0  },
      calcium_Ca:    { element: 'Ca', factor_to_element: 1.0,  factor_to_ion: 1.0  },
      magnesium_Mg:  { element: 'Mg', factor_to_element: 1.0,  factor_to_ion: 1.0  },
      sulfate_SO4:   { element: 'S', factor_to_element: 0.333, factor_to_ion: 3.0  },
      chloride_Cl:   { element: 'Cl', factor_to_element: 1.0,  factor_to_ion: 1.0  },
      sodium_Na:     { element: 'Na', factor_to_element: 1.0,  factor_to_ion: 1.0  },
    };

    // Per-element ppm targets. The planner resolves a per-crop/stage target by
    // falling back to the system-wide default (crop_assignment_id IS NULL,
    // growth_stage IS NULL). We hand it the raw rows so it can do the same fallback.
    const elementTargets = db.prepare(`
      SELECT id, crop_assignment_id, growth_stage, element,
             hard_min, soft_target, hard_max, priority, notes
      FROM crop_element_targets
      ORDER BY crop_assignment_id NULLS LAST, growth_stage NULLS FIRST, element
    `).all();

    // Ingredient library for mixture proposals. The planner may ONLY use ingredient
    // names from this list when proposing new recipes (it cannot invent compounds).
    // Includes elemental composition, compatibility group, and form so the planner
    // can reason about compatibility and solubility before suggesting a swap.
    const ingredientLibrary = db.prepare(`
      SELECT id, name, form, density_kg_per_l, compatibility_group, composition, notes
      FROM fertigation_ingredients
      ORDER BY name
    `).all().map(i => {
      let comp = null;
      try { comp = i.composition ? JSON.parse(i.composition) : null; } catch (_) {}
      return { ...i, composition: comp };
    });

    // Published dose programs only — drafts are operator's work-in-progress and shouldn't
    // be selectable by the planner. Each program comes with its per-tank duty% array.
    const dosePrograms = db.prepare(`
      SELECT id, name, description, window_seconds, target_ec, target_ph, target_ppm,
             compatibility_strategy, status, origin
      FROM fertigation_dose_programs
      WHERE status = 'published'
      ORDER BY name
    `).all().map(p => {
      const tanks = db.prepare(`
        SELECT pt.tank_id, pt.duty_pct, pt.priority, pt.compatibility_slot, t.name as tank_name, t.role as tank_role
        FROM fertigation_dose_program_tanks pt
        JOIN fertigation_tanks t ON pt.tank_id = t.id
        WHERE pt.program_id = ?
        ORDER BY pt.priority, pt.tank_id
      `).all(p.id);
      let targetPpm = null;
      try { targetPpm = p.target_ppm ? JSON.parse(p.target_ppm) : null; } catch (_) {}
      return { ...p, target_ppm: targetPpm, tanks };
    });

    return {
      today: todayStr,
      tomorrow: this._tomorrowOf(todayStr),
      timezone: process.env.TZ || 'UTC',
      today_snapshot: dailySnapshot,
      agronomist_today: agronomistContext,
      current_automations: currentAutomations,
      equipment: equipmentInventory,
      zones,
      active_crops: activeCrops,
      templates,
      fertigation_tanks: fertigationTanks,
      water_pump_lpm: waterPumpFlow,
      ionic_equivalence: ionicEquivalence,
      guardrails: db.prepare(`
        SELECT id, name, description, severity, element, comparison, threshold,
               forbidden_action, minimum_tank_duty_pct, override_role
        FROM plan_guardrails WHERE enabled = 1
      `).all(),
      dose_programs: dosePrograms,
      element_targets: elementTargets,
      ingredients_library: ingredientLibrary,
      recent_plans: recentPlans,
      yesterday_plan: yesterdayPlan ? this._summarizePlanForContext(yesterdayPlan) : null,
      yesterday_full_scorecard: yesterdayScorecard,
      today_plan: todayPlan ? this._summarizePlanForContext(todayPlan) : null,
      today_partial_scorecard: todayPartialScorecard,
      previous_rejection: previousRejection,
    };
  }

  /** Compact view of a plan suitable for the LLM context — full plan would be too verbose. */
  _summarizePlanForContext(plan) {
    if (!plan) return null;
    const p = plan.proposed_plan || {};
    return {
      id: plan.id,
      plan_date: plan.plan_date,
      version: plan.version,
      status: plan.status,
      applied_at: plan.applied_at,
      rejection_feedback: plan.rejection_feedback,
      headline: plan.headline,
      summary: plan.summary,
      targets: p.targets || [],
      strategy_hypothesis: p.yesterday_review?.strategy_adjustments_hypothesis || '',
      proposed_automations_count: (p.proposed_automations || []).length,
      changes_count: (p.changes_from_today || []).length,
    };
  }

  _yesterdayOf(dateStr) {
    const d = new Date(`${dateStr}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  }

  _tomorrowOf(dateStr) {
    const d = new Date(`${dateStr}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
  }

  _localDateStr(d) {
    // Format YYYY-MM-DD in configured TZ if available, else local.
    const tz = process.env.TZ;
    if (tz) {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      }).formatToParts(d);
      const get = t => parts.find(p => p.type === t)?.value;
      return `${get('year')}-${get('month')}-${get('day')}`;
    }
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  // -------- closed-loop scoring --------

  /**
   * Deterministically score a plan's targets against actual sensor readings.
   *
   * @param {object} plan   - hydrated operational_plans row (with proposed_plan field). Must have plan_date + proposed_plan.targets[].
   * @param {object} opts
   * @param {number} [opts.stopAtMs] - if set, ignore samples after this ms. Used for partial-today scoring.
   * @returns {object|null} - scorecard, or null if plan has no targets.
   */
  computeScorecard(plan, opts = {}) {
    if (!plan) return null;
    const proposed = plan.proposed_plan;
    if (!proposed || !Array.isArray(proposed.targets) || proposed.targets.length === 0) return null;

    const planDateStr = plan.plan_date;
    const tz = process.env.TZ || 'UTC';
    const cutoffMs = Number.isFinite(opts.stopAtMs) ? opts.stopAtMs : Number.POSITIVE_INFINITY;

    const outcomes = [];
    for (const target of proposed.targets) {
      const samples = this._loadSamples(target.sensor_equipment_id, target.sensor_metric, planDateStr);
      const filtered = samples
        .filter(s => s.ts <= cutoffMs)
        .filter(s => this._inWindow(s.ts, target, tz));
      outcomes.push(this._scoreTarget(target, filtered));
    }

    return {
      plan_id: plan.id,
      plan_date: planDateStr,
      plan_version: plan.version,
      scored_at: new Date().toISOString(),
      cutoff_at: Number.isFinite(opts.stopAtMs) ? new Date(opts.stopAtMs).toISOString() : null,
      overall_grade: this._aggregateGrades(outcomes),
      target_outcomes: outcomes,
    };
  }

  _loadSamples(equipmentId, metric, planDateStr) {
    if (!equipmentId || !planDateStr) return [];
    let rows;
    if (metric && metric.trim()) {
      rows = db.prepare(`
        SELECT timestamp, value FROM readings
        WHERE equipment_id = ? AND name = ? AND date(timestamp) = ?
        ORDER BY timestamp ASC
      `).all(equipmentId, metric, planDateStr);
    } else {
      rows = db.prepare(`
        SELECT timestamp, value FROM readings
        WHERE equipment_id = ? AND (name IS NULL OR name = '' OR name = '_value') AND date(timestamp) = ?
        ORDER BY timestamp ASC
      `).all(equipmentId, planDateStr);
    }
    return rows.map(r => {
      const ts = r.timestamp.includes('T') ? r.timestamp : r.timestamp + 'Z';
      return { ts: new Date(ts).getTime(), value: Number(r.value) };
    }).filter(s => Number.isFinite(s.ts) && Number.isFinite(s.value));
  }

  _inWindow(utcMs, target, tz) {
    const w = target.window || 'all_day';
    if (w === 'all_day') return true;
    const localMin = this._localMinuteOfDay(utcMs, tz);
    if (w === 'daylight') return localMin >= 360 && localMin < 1080;
    if (w === 'dark') return localMin < 360 || localMin >= 1080;
    // Custom: parse "HH:MM-HH:MM"
    const m = /^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/.exec(w);
    if (m) {
      const start = this._hhmmToMin(m[1]);
      const end = this._hhmmToMin(m[2]);
      if (start === null || end === null) return false;
      if (start <= end) return localMin >= start && localMin < end;
      return localMin >= start || localMin < end;
    }
    return true;
  }

  _localMinuteOfDay(utcMs, tz) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      hour: '2-digit', minute: '2-digit',
    }).formatToParts(new Date(utcMs));
    const h = parseInt(parts.find(p => p.type === 'hour').value);
    const m = parseInt(parts.find(p => p.type === 'minute').value);
    return h * 60 + m;
  }

  _hhmmToMin(hhmm) {
    if (!hhmm || !/^\d{1,2}:\d{2}$/.test(hhmm)) return null;
    const [h, m] = hhmm.split(':').map(Number);
    return h * 60 + m;
  }

  _minToHHMM(min) {
    if (!Number.isFinite(min)) return '?';
    const h = Math.floor(min / 60);
    const m = min % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }

  _scoreTarget(target, samples) {
    const baseOut = {
      target_key: target.key,
      sensor_equipment_id: target.sensor_equipment_id,
      sensor_metric: target.sensor_metric,
      band: [target.min, target.max],
      window: target.window,
      acceptance: target.acceptance,
      sample_count: samples.length,
    };
    if (samples.length === 0) {
      return { ...baseOut, stats: null, verdict: 'uncomputable', reason: 'no samples in window' };
    }

    const values = samples.map(s => s.value).slice().sort((a, b) => a - b);
    const n = values.length;
    const mean = values.reduce((a, c) => a + c, 0) / n;
    const pct = q => values[Math.min(n - 1, Math.max(0, Math.floor(q * n)))];
    const p10 = pct(0.10), p50 = pct(0.50), p90 = pct(0.90);
    const minV = values[0], maxV = values[n - 1];
    const inRange = samples.filter(s => s.value >= target.min && s.value <= target.max).length;
    const inRangePct = inRange / n;
    const excursion = Math.max(
      maxV > target.max ? maxV - target.max : 0,
      minV < target.min ? target.min - minV : 0,
    );

    // Consecutive breach episodes (samples assumed roughly even-spaced)
    let episodes = 0;
    let longestBreachMin = 0;
    let breachStart = null;
    let prevIn = true;
    for (const s of samples) {
      const inBand = s.value >= target.min && s.value <= target.max;
      if (!inBand && prevIn) { episodes++; breachStart = s.ts; }
      else if (inBand && !prevIn && breachStart != null) {
        longestBreachMin = Math.max(longestBreachMin, Math.round((s.ts - breachStart) / 60000));
        breachStart = null;
      }
      prevIn = inBand;
    }
    if (breachStart != null) {
      longestBreachMin = Math.max(longestBreachMin, Math.round((samples[n - 1].ts - breachStart) / 60000));
    }

    // Evaluate acceptance against the whitelisted forms in the schema
    const acc = String(target.acceptance || '');
    let metAcceptance = null;
    if (acc.startsWith('time_in_range>=')) {
      const threshold = parseFloat(acc.slice('time_in_range>='.length));
      metAcceptance = Number.isFinite(threshold) ? inRangePct >= threshold : null;
    } else if (acc.startsWith('peak_excursion<=')) {
      const threshold = parseFloat(acc.slice('peak_excursion<='.length));
      metAcceptance = Number.isFinite(threshold) ? excursion <= threshold : null;
    } else if (acc === 'mean_within_range') {
      metAcceptance = mean >= target.min && mean <= target.max;
    }

    const round2 = v => Math.round(v * 100) / 100;
    const stats = {
      mean: round2(mean), min: round2(minV), max: round2(maxV),
      p10: round2(p10), p50: round2(p50), p90: round2(p90),
      in_range_pct: round2(inRangePct),
      peak_excursion: round2(excursion),
      breach_episodes: episodes,
      longest_breach_minutes: longestBreachMin,
    };

    if (metAcceptance === null) {
      return { ...baseOut, stats, verdict: 'uncomputable', reason: `unsupported acceptance form: ${acc}` };
    }
    const verdict = metAcceptance ? 'pass' : (inRangePct >= 0.5 ? 'partial' : 'fail');
    return {
      ...baseOut,
      stats,
      verdict,
      reason: metAcceptance ? 'acceptance criterion satisfied' : `${acc} not met`,
    };
  }

  _aggregateGrades(outcomes) {
    if (!outcomes || outcomes.length === 0) return 'no_prior_targets';
    const verdicts = outcomes.map(o => o.verdict);
    if (verdicts.every(v => v === 'pass')) return 'pass';
    if (verdicts.some(v => v === 'fail')) return 'fail';
    return 'partial';
  }

  // -------- post-LLM consistency cross-check --------

  /**
   * Deterministic validator: scans the agent's prose (headline + summary + yesterday_review text)
   * for count claims and ID references, and checks them against the structured data.
   *
   * Returns an array of warning objects. Empty array = clean. Warnings DO NOT block — they just
   * surface in the UI so the operator notices before Confirm.
   */
  _findConsistencyWarnings(parsed, currentAutomations) {
    const warnings = [];
    if (!parsed) return warnings;

    const NUMBER_WORDS = {
      one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
      nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
      fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
    };
    const wordToNum = s => {
      if (!s) return NaN;
      if (/^\d+$/.test(s)) return parseInt(s, 10);
      return NUMBER_WORDS[s.toLowerCase()] ?? NaN;
    };
    const NUM_PATTERN = '(\\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)';

    // Count claims are scoped to the FORWARD-LOOKING prose (headline + summary).
    // yesterday_review prose describes past events ("three cycles were missed today") which
    // legitimately reference different numbers than tomorrow's plan, so we exclude it from count checks.
    const forwardText = [parsed.headline || '', parsed.summary || ''].filter(Boolean).join('\n');
    // ID checks can scan all prose; references to specific automation ids are meaningful in any context.
    const allText = [
      parsed.headline || '',
      parsed.summary || '',
      parsed.yesterday_review?.lessons_learned || '',
      parsed.yesterday_review?.strategy_adjustments_hypothesis || '',
    ].filter(Boolean).join('\n');

    const autos = Array.isArray(parsed.proposed_automations) ? parsed.proposed_automations : [];
    const changes = Array.isArray(parsed.changes_from_today) ? parsed.changes_from_today : [];
    const targets = Array.isArray(parsed.targets) ? parsed.targets : [];
    const risks = Array.isArray(parsed.risks) ? parsed.risks : [];

    // Count of automations matching a name pattern
    const countByName = (re) => autos.filter(a => re.test(a.name || '')).length;
    // Count of changes_from_today entries that target a name pattern (looks at the human-readable target field)
    const countChangesByName = (re, changeTypes = null) => changes.filter(c => {
      if (!re.test(c.target || '')) return false;
      if (changeTypes && !changeTypes.includes(c.change_type)) return false;
      return true;
    }).length;

    // ---- Count claims ----
    // Each entry: { pattern: regex with one numeric capture, actual: () => number, label, scope }
    const COUNT_CHECKS = [
      {
        pattern: new RegExp(`\\b${NUM_PATTERN}\\s+(?:daily\\s+)?fertigation\\s+cycles?\\b`, 'gi'),
        actual: () => countByName(/fertigation/i),
        label: 'fertigation cycles',
      },
      {
        pattern: new RegExp(`\\b${NUM_PATTERN}\\s+drain(?:age)?\\s+(?:cycles?|flush(?:es)?)\\b`, 'gi'),
        actual: () => countByName(/drain/i),
        label: 'drain cycles',
      },
      {
        pattern: new RegExp(`\\b${NUM_PATTERN}\\s+(?:leaching|leach)\\s+flush(?:es)?\\b`, 'gi'),
        actual: () => countByName(/leach|flush/i),
        label: 'leaching flushes',
      },
      {
        pattern: new RegExp(`\\b${NUM_PATTERN}\\s+(?:proposed\\s+)?(?:total\\s+)?automations?\\s+(?:in\\s+total|total|in\\s+tomorrow|for\\s+tomorrow|proposed)\\b`, 'gi'),
        actual: () => autos.length,
        label: 'total proposed automations',
      },
      {
        pattern: new RegExp(`\\b${NUM_PATTERN}\\s+risks?\\b`, 'gi'),
        actual: () => risks.length,
        label: 'risks',
      },
      {
        pattern: new RegExp(`\\b${NUM_PATTERN}\\s+targets?\\b`, 'gi'),
        actual: () => targets.length,
        label: 'targets',
      },
      {
        pattern: new RegExp(`(?:disable[ds]?|removed|dropped)\\s+${NUM_PATTERN}\\s+(?:automations?|cycles?|rules?)\\b`, 'gi'),
        actual: () => countChangesByName(/.*/i, ['remove']),
        label: 'removed/disabled automations',
      },
      {
        pattern: new RegExp(`(?:added?|new)\\s+${NUM_PATTERN}\\s+(?:automations?|cycles?|rules?)\\b`, 'gi'),
        actual: () => countChangesByName(/.*/i, ['add']),
        label: 'added automations',
      },
    ];

    // Sentence-level split: count claims are validated per sentence, so a "missed/skipped"
    // word in another sentence doesn't suppress a real warning elsewhere.
    const sentences = forwardText
      .split(/(?<=[.!?;])\s+|\n+/)
      .map(s => s.trim())
      .filter(Boolean);
    const NEGATIVE_CONTEXT_RE = /\b(missed|skipped|didn'?t fire|did not fire|failed to fire|couldn'?t fire|failed|lost|interrupted|unfired|aborted|cancell?ed)\b/i;

    for (const check of COUNT_CHECKS) {
      const actual = check.actual();
      for (const sentence of sentences) {
        // Skip sentences narrating past failures — their numbers describe what didn't happen, not tomorrow's plan
        if (NEGATIVE_CONTEXT_RE.test(sentence)) continue;
        check.pattern.lastIndex = 0;
        let m;
        while ((m = check.pattern.exec(sentence)) !== null) {
          const claimed = wordToNum(m[1]);
          if (Number.isFinite(claimed) && claimed !== actual) {
            warnings.push({
              kind: 'count_mismatch',
              field: check.label,
              prose_claims: claimed,
              data_says: actual,
              context: m[0],
            });
          }
        }
      }
    }

    // ---- Time-range claims ----
    // Detect prose like "fertigation 07:00-15:00" or "from 06:00 to 18:00" in forward text,
    // identify the subject, and verify the actual schedule triggers fall within the claimed range.
    const TIME_RANGE_RE = /(\d{1,2}:\d{2})\s*(?:[-–—]|\bto\b|\bthrough\b|\buntil\b)\s*(\d{1,2}:\d{2})/g;
    const SUBJECT_KEYWORDS = [
      { re: /\bfertigation\b/i, key: 'fertigation', match: /fertigation/i },
      { re: /\b(drain|drainage)\b/i, key: 'drain',  match: /drain/i },
      { re: /\b(leach|leaching|flush)\b/i, key: 'leaching', match: /leach|flush/i },
      { re: /\b(irrigation|irrigate)\b/i, key: 'irrigation', match: /irrig/i },
    ];

    for (const sentence of sentences) {
      if (NEGATIVE_CONTEXT_RE.test(sentence)) continue;
      TIME_RANGE_RE.lastIndex = 0;
      let m;
      while ((m = TIME_RANGE_RE.exec(sentence)) !== null) {
        const startStr = m[1];
        const endStr = m[2];
        const startMin = this._hhmmToMin(startStr);
        const endMin = this._hhmmToMin(endStr);
        if (startMin == null || endMin == null) continue;

        // Look ~60 chars BEFORE the match for a subject keyword
        const lookback = sentence.slice(Math.max(0, m.index - 60), m.index);
        const subj = SUBJECT_KEYWORDS.find(s => s.re.test(lookback));
        if (!subj) continue; // generic range, can't validate against a subset

        // Find proposed automations matching subject with schedule triggers
        const matching = autos.filter(a => {
          const name = a.name || '';
          const trig = a.trigger_config || {};
          return subj.match.test(name) && trig.type === 'schedule' && trig.time;
        });
        if (matching.length === 0) continue;

        const times = matching
          .map(a => this._hhmmToMin(a.trigger_config.time))
          .filter(t => t != null);
        if (times.length === 0) continue;

        const actualMin = Math.min(...times);
        const actualMax = Math.max(...times);

        // Slack: 30 min. Catches 1-hour drifts (which is what the user actually spotted)
        // while still allowing genuine rounding ("morning fertigation 07:00-15:00" when last is 14:30).
        const SLACK_MIN = 30;

        // Case A: actual extends BEYOND claimed range (prose understated)
        if (actualMin < startMin - 0 || actualMax > endMin + 0) {
          warnings.push({
            kind: 'time_range_actual_outside_claim',
            subject: subj.key,
            claimed_range: `${startStr}-${endStr}`,
            actual_range: `${this._minToHHMM(actualMin)}-${this._minToHHMM(actualMax)}`,
            context: m[0],
            hint: `Actual ${subj.key} triggers extend outside the claimed window.`,
          });
        } else if (Math.abs(actualMin - startMin) > SLACK_MIN || Math.abs(actualMax - endMin) > SLACK_MIN) {
          // Case B: claimed range is much wider than actual (prose overstated by ≥ 1h)
          warnings.push({
            kind: 'time_range_overstated',
            subject: subj.key,
            claimed_range: `${startStr}-${endStr}`,
            actual_range: `${this._minToHHMM(actualMin)}-${this._minToHHMM(actualMax)}`,
            context: m[0],
            hint: `Claimed window is wider than the actual schedule by more than ${SLACK_MIN} min.`,
          });
        }
      }
    }

    // ---- Automation #ID references ----
    // Build a lookup of valid ids
    const liveIds = new Set((currentAutomations || []).map(a => a.id));
    const touchedIds = new Set(changes.filter(c => c.current_automation_id).map(c => c.current_automation_id));
    const idMatches = [...allText.matchAll(/(?:automation\s+)?#(\d+)\b/gi)];
    const seenIds = new Set();
    for (const m of idMatches) {
      const id = parseInt(m[1], 10);
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      if (!liveIds.has(id)) {
        warnings.push({
          kind: 'unknown_automation_id',
          id,
          context: m[0],
          hint: 'Prose references an automation id that does not exist in the live automations table',
        });
      } else if (!touchedIds.has(id)) {
        // Referenced but not in the diff manifest — softer warning
        warnings.push({
          kind: 'untracked_automation_id',
          id,
          context: m[0],
          hint: 'Prose discusses automation #' + id + ' but no changes_from_today entry references it',
        });
      }
    }

    // Deduplicate: same kind + identifying fields = same warning.
    const seen = new Set();
    return warnings.filter(w => {
      const key = JSON.stringify([w.kind, w.field || '', w.id || '', w.subject || '', w.claimed_range || '', w.actual_range || '', w.prose_claims ?? '', w.data_says ?? '']);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  // -------- core: generate a plan --------

  /** Generate the plan for the day after `referenceDate` (default: today).
   *  Persists a NEW row with plan_date = the day the plan COVERS, version = max(version)+1 for that date.
   *  Status starts as 'pending'. The operator confirms or rejects.
   */
  async generatePlanForTomorrow(referenceDate = null, opts = {}) {
    const cfg = this.getConfig();
    const today = referenceDate || this._localDateStr(new Date());
    const tomorrow = this._tomorrowOf(today);

    // If a pending plan already exists for tomorrow and we're not forcing or regenerating-from-reject, block.
    const blocking = db.prepare(
      "SELECT id FROM operational_plans WHERE plan_date = ? AND status = 'pending'"
    ).get(tomorrow);
    if (blocking && !opts.force && !opts.previous_rejection) {
      const err = new Error(`A pending plan for ${tomorrow} already exists. Reject it or pass force=true.`);
      err.code = 'ALREADY_EXISTS';
      throw err;
    }

    // Compute next version for this plan_date
    const versionRow = db.prepare(
      'SELECT COALESCE(MAX(version), 0) AS max_v FROM operational_plans WHERE plan_date = ?'
    ).get(tomorrow);
    const nextVersion = (versionRow.max_v || 0) + 1;
    const parentPlanId = opts.previous_rejection?.rejected_plan_id || null;

    const context = this.buildPlanningContext(today, {
      previous_rejection: opts.previous_rejection || null,
    });

    const userMessage = [
      `Today is ${today}. You are planning operations for TOMORROW (${tomorrow}).`,
      `Timezone: ${context.timezone}.`,
      opts.previous_rejection
        ? `IMPORTANT: A previous attempt at this plan was REJECTED by the operator. Their written feedback is in context.previous_rejection.feedback. Address it explicitly.`
        : '',
      '',
      'Full operational context:',
      '',
      '```json',
      JSON.stringify(context, null, 2),
      '```',
      '',
      'Produce the JSON plan. Declare measurable targets[]. Review the scorecards in yesterday_review. Use real equipment_id/channel values from the inventory. Address the agronomist\'s recommendations. Be specific about times and durations.',
    ].filter(Boolean).join('\n');

    const client = this._client_or_throw();

    let response;
    try {
      const stream = client.messages.stream({
        model: cfg.model || DEFAULT_MODEL,
        max_tokens: 24000,
        system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
        output_config: {
          format: {
            type: 'json_schema',
            schema: PLAN_SCHEMA,
          },
        },
        messages: [{ role: 'user', content: userMessage }],
      });
      response = await stream.finalMessage();
    } catch (err) {
      db.prepare(`
        INSERT INTO operational_plans
          (plan_date, version, parent_plan_id, generated_for, model, input_snapshot, status, error)
        VALUES (?, ?, ?, ?, ?, ?, 'failure', ?)
      `).run(tomorrow, nextVersion, parentPlanId, today, cfg.model || DEFAULT_MODEL, JSON.stringify(context), String(err?.message || err));
      throw err;
    }

    const textBlock = response.content.find(b => b.type === 'text');
    if (!textBlock) throw new Error('Claude returned no text block');

    let parsed;
    try { parsed = JSON.parse(textBlock.text); }
    catch (err) { throw new Error(`Claude returned invalid JSON: ${err.message}`); }

    const usage = response.usage || {};

    // Deterministic post-LLM cross-check: scan prose vs structured data for mismatches.
    const warnings = this._findConsistencyWarnings(parsed, context.current_automations || []);

    const result = db.prepare(`
      INSERT INTO operational_plans
        (plan_date, version, parent_plan_id, generated_for, model, input_snapshot,
         headline, summary, proposed_plan_json, consistency_warnings,
         input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, status, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL)
    `).run(
      tomorrow, nextVersion, parentPlanId, today,
      response.model || cfg.model || DEFAULT_MODEL,
      JSON.stringify(context),
      parsed.headline,
      parsed.summary,
      JSON.stringify(parsed),
      JSON.stringify(warnings),
      usage.input_tokens || 0,
      usage.output_tokens || 0,
      usage.cache_read_input_tokens || 0,
      usage.cache_creation_input_tokens || 0,
    );

    return this.getPlanById(result.lastInsertRowid);
  }

  // -------- apply / reject --------

  /**
   * Apply a confirmed plan to the live automations table.
   * Walks changes_from_today deterministically.
   *
   * @param {number} planId
   * @param {number} userId - operator confirming (for audit)
   * @returns {object} - the updated plan row + applied_summary
   */
  /**
   * Evaluate every enabled guardrail rule against a plan.
   *
   * Returns an array of triggered rule evaluations:
   *   [{
   *     rule_id, rule_name, severity, description, element, threshold,
   *     comparison, latest_value, latest_sample_at,
   *     triggering_automations: [{ automation_index, automation_name, dose_program_id, dose_program_name, ca_tank_duty_pct, ... }],
   *     triggering_dose_program_requests: [{ proposed_name, ca_tank_duty_pct }],
   *     triggering_mixture_requests: [{ proposed_name, target_tank_id, ca_mass_delta_kg }],
   *     would_block: boolean,
   *     override_role: 'admin' | 'operator' | 'admin_or_operator',
   *   }]
   *
   * Empty array = plan passes all guardrails.
   */
  evaluatePlanGuardrails(plan) {
    if (!plan || !plan.proposed_plan) return [];
    const rules = db.prepare("SELECT * FROM plan_guardrails WHERE enabled = 1").all();
    if (rules.length === 0) return [];

    // Index Ca-source tanks: any tank whose ingredients have compatibility_group='calcium'
    // is treated as a Ca source. Returned as { [tank_id]: { name, mixture_id } }.
    const caSourceTanks = (() => {
      const rows = db.prepare(`
        SELECT DISTINCT t.id, t.name, t.mixture_id
        FROM fertigation_tanks t
        JOIN fertigation_mixture_items mi ON mi.mixture_id = t.mixture_id
        JOIN fertigation_ingredients i ON i.id = mi.ingredient_id
        WHERE i.compatibility_group = 'calcium'
      `).all();
      const out = {};
      for (const r of rows) out[r.id] = r;
      return out;
    })();

    // Today's snapshot for the lab readings each rule wants to evaluate.
    const todayStr = this._localDateStr(new Date());
    let snapshot;
    try { snapshot = agronomistService.aggregateDailyData(todayStr); }
    catch (_) { snapshot = null; }

    const proposed = plan.proposed_plan;
    const propAutos = Array.isArray(proposed.proposed_automations) ? proposed.proposed_automations : [];

    // Resolve dose program duty cycles once.
    const programDuties = {};
    const programNames = {};
    for (const row of db.prepare(`
      SELECT p.id as program_id, p.name as program_name, pt.tank_id, pt.duty_pct
      FROM fertigation_dose_programs p
      JOIN fertigation_dose_program_tanks pt ON pt.program_id = p.id
    `).all()) {
      if (!programDuties[row.program_id]) programDuties[row.program_id] = {};
      programDuties[row.program_id][row.tank_id] = row.duty_pct;
      programNames[row.program_id] = row.program_name;
    }

    const evals = [];
    for (const rule of rules) {
      // Resolve the current value of this element from the snapshot (irrigation/feed side).
      const feedSlot = snapshot?.lab?.irrigation?.latest_per_nutrient || {};
      const todayFeed = snapshot?.lab?.irrigation?.today || [];
      const todaySample = todayFeed.find(r => r.nutrient === rule.element);
      const latestSample = todaySample || feedSlot[rule.element] || null;
      const latestValue = latestSample ? Number(latestSample.value) : null;

      // Evaluate trigger condition.
      let triggered = false;
      switch (rule.comparison) {
        case 'lt':           triggered = latestValue != null && latestValue < rule.threshold; break;
        case 'lte':          triggered = latestValue != null && latestValue <= rule.threshold; break;
        case 'gt':           triggered = latestValue != null && latestValue > rule.threshold; break;
        case 'gte':          triggered = latestValue != null && latestValue >= rule.threshold; break;
        case 'null_or_lt':   triggered = latestValue == null || latestValue < rule.threshold; break;
        case 'null_or_lte':  triggered = latestValue == null || latestValue <= rule.threshold; break;
        default: triggered = false;
      }
      if (!triggered) continue;

      // The rule trips ONLY if the plan would also do a forbidden action — i.e.
      // reduce delivery of this element below the rule's minimum tank duty %.
      const minDuty = rule.minimum_tank_duty_pct != null ? rule.minimum_tank_duty_pct : 100;
      const triggeringAutos = [];
      const triggeringDoseReqs = [];
      const triggeringMixtureReqs = [];

      // Auto-resolve which tanks "carry" this element. For Ca rule → caSourceTanks.
      // Generalised: look at every mixture's ingredient composition for the element.
      let elementTankIds;
      if (rule.element === 'calcium_Ca') {
        elementTankIds = new Set(Object.keys(caSourceTanks).map(Number));
      } else {
        const elementalSymbol = ({
          calcium_Ca: 'Ca', magnesium_Mg: 'Mg', potassium_K: 'K',
          nitrate_NO3: 'N', ammonium_NH4: 'N', sulfate_SO4: 'S',
          phosphate_PO4: 'P',
        })[rule.element] || rule.element;
        const rows = db.prepare(`
          SELECT DISTINCT t.id, i.composition
          FROM fertigation_tanks t
          JOIN fertigation_mixture_items mi ON mi.mixture_id = t.mixture_id
          JOIN fertigation_ingredients i ON i.id = mi.ingredient_id
        `).all();
        elementTankIds = new Set();
        for (const r of rows) {
          let comp = {}; try { comp = r.composition ? JSON.parse(r.composition) : {}; } catch (_) {}
          if (comp[elementalSymbol] && comp[elementalSymbol] > 0) elementTankIds.add(r.id);
        }
      }

      // Scan proposed_automations for a dose_program where any element-tank's duty < minDuty.
      //
      // EXEMPTION: a pure water flush (dose program with ALL tank duties == 0) is not a
      // "dose reduction" — it's an orthogonal leaching operation that delivers no
      // nutrients, so it doesn't worsen any element's feed concentration. The guardrail
      // skips it. Half-strength / partial-reduction programs (any tank > 0 alongside a
      // sub-threshold element tank) still trip the rule.
      for (let i = 0; i < propAutos.length; i++) {
        const a = propAutos[i];
        if (!a.dose_program_id) continue;
        const duties = programDuties[a.dose_program_id] || {};
        const isPureFlush = Object.keys(duties).length > 0 && Object.values(duties).every(d => (d || 0) === 0);
        if (isPureFlush) continue;
        for (const tankId of elementTankIds) {
          const duty = duties[tankId];
          if (duty != null && duty < minDuty) {
            triggeringAutos.push({
              automation_index: i,
              automation_name: a.name,
              dose_program_id: a.dose_program_id,
              dose_program_name: programNames[a.dose_program_id],
              tank_id: tankId,
              tank_duty_pct: duty,
              required_min_duty_pct: minDuty,
            });
            break;
          }
        }
      }

      // Scan dose_program_requests[] for proposed new programs with element-tank duty < minDuty
      let dpr = proposed.dose_program_requests;
      if (typeof dpr === 'string') {
        try { dpr = JSON.parse(dpr); } catch (_) { dpr = []; }
      }
      for (const req of (Array.isArray(dpr) ? dpr : [])) {
        let duties = req.duty_cycles;
        if (typeof duties === 'string') { try { duties = JSON.parse(duties); } catch (_) { duties = []; } }
        if (!Array.isArray(duties)) continue;
        for (const d of duties) {
          if (elementTankIds.has(d.tank_id) && d.duty_pct < minDuty) {
            triggeringDoseReqs.push({
              proposed_name: req.proposed_name,
              tank_id: d.tank_id,
              tank_duty_pct: d.duty_pct,
              required_min_duty_pct: minDuty,
            });
            break;
          }
        }
      }

      // Scan mixture_requests[] for proposed recipe changes that reduce Ca mass
      // (specifically the Ca rule — for generic rules we'd need richer comparison
      // against current ingredient masses; v1 only flags Ca explicitly).
      if (rule.element === 'calcium_Ca') {
        let mxr = proposed.mixture_requests;
        if (typeof mxr === 'string') { try { mxr = JSON.parse(mxr); } catch (_) { mxr = []; } }
        for (const req of (Array.isArray(mxr) ? mxr : [])) {
          if (!elementTankIds.has(req.target_tank_id)) continue;
          let ingredients = req.ingredients;
          if (typeof ingredients === 'string') { try { ingredients = JSON.parse(ingredients); } catch (_) { ingredients = []; } }
          // Sum Ca mass in the proposed recipe.
          let proposedCaKg = 0;
          for (const it of (Array.isArray(ingredients) ? ingredients : [])) {
            if (/calcium/i.test(it.name || '')) {
              const mass = parseFloat(it.amount) || 0;
              proposedCaKg += mass * 0.19; // approx Ca fraction in Ca-nitrate (worst-case for any Ca salt; specific check is in service prompt)
            }
          }
          // Current Ca mass in the tank's current recipe.
          const tank = db.prepare('SELECT mixture_id FROM fertigation_tanks WHERE id = ?').get(req.target_tank_id);
          let currentCaKg = 0;
          if (tank?.mixture_id) {
            const items = db.prepare(`
              SELECT mi.amount, i.composition
              FROM fertigation_mixture_items mi
              JOIN fertigation_ingredients i ON i.id = mi.ingredient_id
              WHERE mi.mixture_id = ?
            `).all(tank.mixture_id);
            for (const it of items) {
              let comp = {}; try { comp = it.composition ? JSON.parse(it.composition) : {}; } catch (_) {}
              currentCaKg += (parseFloat(it.amount) || 0) * ((comp.Ca || 0) / 100);
            }
          }
          if (proposedCaKg < currentCaKg * 0.8) {
            triggeringMixtureReqs.push({
              proposed_name: req.proposed_name,
              target_tank_id: req.target_tank_id,
              current_ca_kg: Math.round(currentCaKg * 100) / 100,
              proposed_ca_kg: Math.round(proposedCaKg * 100) / 100,
            });
          }
        }
      }

      if (triggeringAutos.length === 0 && triggeringDoseReqs.length === 0 && triggeringMixtureReqs.length === 0) continue;

      evals.push({
        rule_id: rule.id,
        rule_name: rule.name,
        severity: rule.severity,
        description: rule.description,
        element: rule.element,
        comparison: rule.comparison,
        threshold: rule.threshold,
        latest_value: latestValue,
        latest_sample_at: latestSample?.sample_date || null,
        latest_days_ago: latestSample?.days_ago ?? null,
        minimum_tank_duty_pct: minDuty,
        triggering_automations: triggeringAutos,
        triggering_dose_program_requests: triggeringDoseReqs,
        triggering_mixture_requests: triggeringMixtureReqs,
        would_block: true,
        override_role: rule.override_role,
      });
    }

    return evals;
  }

  applyPlan(planId, userId = null, opts = {}) {
    const plan = this.getPlanById(planId);
    if (!plan) throw new Error(`Plan ${planId} not found`);
    if (plan.status === 'confirmed') {
      const err = new Error(`Plan ${planId} is already confirmed`);
      err.code = 'ALREADY_CONFIRMED';
      throw err;
    }
    if (plan.status !== 'pending') {
      const err = new Error(`Plan ${planId} cannot be confirmed (status=${plan.status})`);
      err.code = 'INVALID_STATE';
      throw err;
    }

    // Evaluate guardrails BEFORE touching any automations. Block if any rule
    // trips without a matching override in the apply payload.
    const triggered = this.evaluatePlanGuardrails(plan);
    const overrides = Array.isArray(opts.overrides) ? opts.overrides : [];
    const unmitigated = triggered.filter(t => {
      const o = overrides.find(ov => ov.rule_id === t.rule_id || ov.rule_name === t.rule_name);
      return !o || !o.reason || !String(o.reason).trim();
    });
    if (unmitigated.length > 0) {
      const err = new Error(`Plan blocked by ${unmitigated.length} guardrail(s): ${unmitigated.map(t => t.rule_name).join(', ')}`);
      err.code = 'GUARDRAIL_BLOCKED';
      err.guardrails = unmitigated;
      throw err;
    }

    const proposed = plan.proposed_plan;
    if (!proposed) throw new Error(`Plan ${planId} has no proposed_plan content`);
    const changes = Array.isArray(proposed.changes_from_today) ? proposed.changes_from_today : [];
    const propAutos = Array.isArray(proposed.proposed_automations) ? proposed.proposed_automations : [];

    const summary = {
      added: [], modified: [], disabled: [], kept: [], errors: [],
      // Record any guardrail overrides + the operator-provided reason for each.
      // The triggered rules are always preserved (even when overrides were
      // applied) so a later audit can reconstruct what the guardrail saw.
      guardrail_overrides: triggered.map(t => {
        const o = overrides.find(ov => ov.rule_id === t.rule_id || ov.rule_name === t.rule_name);
        return {
          rule_id: t.rule_id,
          rule_name: t.rule_name,
          severity: t.severity,
          element: t.element,
          latest_value: t.latest_value,
          override_reason: o?.reason || null,
          override_user_id: userId,
        };
      }),
    };

    const insertStmt = db.prepare(`
      INSERT INTO automations (name, description, enabled, priority, trigger_config, conditions, actions, template_id, dose_program_id)
      VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)
    `);
    const updateStmt = db.prepare(`
      UPDATE automations
      SET name = ?, description = ?, enabled = 1, priority = ?,
          trigger_config = ?, conditions = ?, actions = ?, template_id = ?, dose_program_id = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `);

    // Resolve & validate a dose_program_id from a proposed automation. Returns the id
    // to persist (or null). Throws if the planner pointed at a non-published program.
    const resolveDoseProgramId = (autoSpec) => {
      const raw = autoSpec.dose_program_id;
      if (!raw) return null;
      const id = parseInt(raw, 10);
      if (!Number.isFinite(id) || id <= 0) return null;
      const prog = db.prepare("SELECT id, status FROM fertigation_dose_programs WHERE id = ?").get(id);
      if (!prog) throw new Error(`dose_program_id ${id} does not exist`);
      if (prog.status !== 'published') throw new Error(`dose_program_id ${id} is in '${prog.status}' status; only published programs can be assigned`);
      return id;
    };
    const disableStmt = db.prepare(`UPDATE automations SET enabled = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?`);

    // Helper: resolve a proposed_automation into the {trigger, conditions, actions, template_id} that go into the DB row.
    const resolveAutoSpec = (autoSpec) => {
      const templateId = autoSpec.template_id || 0;
      if (templateId > 0) {
        const tpl = db.prepare('SELECT * FROM automation_templates WHERE id = ?').get(templateId);
        if (!tpl) throw new Error(`template_id ${templateId} not found`);
        // template_parameters is a JSON string (per the schema). Parse defensively.
        let paramObj = {};
        const rawParams = autoSpec.template_parameters;
        if (typeof rawParams === 'string' && rawParams.trim()) {
          try { paramObj = JSON.parse(rawParams); }
          catch (e) { throw new Error(`template_parameters is not valid JSON: ${e.message}`); }
        } else if (Array.isArray(rawParams)) {
          // Back-compat with old array-of-{name,value} shape (not currently emitted)
          for (const p of rawParams) if (p && p.name) paramObj[p.name] = p.value;
        } else if (rawParams && typeof rawParams === 'object') {
          paramObj = rawParams;
        }
        const instantiated = instantiateTemplate(tpl, paramObj);
        return {
          trigger: this._normalizeTriggerForEngine(autoSpec.trigger_config || instantiated.trigger_config),
          conditions: instantiated.conditions || [],
          actions: instantiated.actions || [],
          template_id: templateId,
        };
      }
      // Raw path (template_id = 0). actions come from actions_json (string).
      let rawActions = [];
      try {
        const aj = autoSpec.actions_json;
        if (aj && aj.trim() && aj.trim() !== '[]') rawActions = JSON.parse(aj);
        if (!Array.isArray(rawActions)) throw new Error('actions_json did not parse as array');
      } catch (e) {
        throw new Error(`Invalid actions_json on raw automation: ${e.message}`);
      }
      return {
        trigger: this._normalizeTriggerForEngine(autoSpec.trigger_config),
        conditions: [],
        actions: this._normalizeActionsForEngine(rawActions),
        template_id: null,
      };
    };

    // LLM accounting drifts (off-by-one indexes, forgetting to update a reference
    // after reordering) are common. Recover by name-matching change.target against
    // proposed_automations[*].name when the literal index is out of range.
    const findByName = (target) => {
      if (!target || typeof target !== 'string') return -1;
      const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').replace(/[—–\-]/g, '-').trim();
      const t = norm(target).replace(/\s*\(id=\d+\)\s*$/, '').trim();
      // Exact normalized match first
      for (let i = 0; i < propAutos.length; i++) {
        if (norm(propAutos[i].name) === t) return i;
      }
      // Prefix / contains match as fallback
      for (let i = 0; i < propAutos.length; i++) {
        const n = norm(propAutos[i].name);
        if (n.startsWith(t) || t.startsWith(n) || n.includes(t) || t.includes(n)) return i;
      }
      return -1;
    };

    summary.warnings = [];

    const tx = db.transaction((items) => {
      for (const ch of items) {
        try {
          let idx = ch.proposed_automation_index;
          let autoSpec = idx >= 0 && idx < propAutos.length ? propAutos[idx] : null;

          // Name-based recovery when the index is missing or out of range.
          if (!autoSpec && (ch.change_type === 'add' || ch.change_type === 'modify')) {
            const recovered = findByName(ch.target);
            if (recovered >= 0) {
              summary.warnings.push({
                change: ch,
                warning: `proposed_automation_index ${idx} out of range; recovered by name match to index ${recovered} ("${propAutos[recovered].name}")`,
              });
              idx = recovered;
              autoSpec = propAutos[recovered];
            }
          }

          switch (ch.change_type) {
            case 'add': {
              if (!autoSpec) throw new Error('add requires valid proposed_automation_index (and no name match found)');
              const resolved = resolveAutoSpec(autoSpec);
              const doseProgId = resolveDoseProgramId(autoSpec);
              const res = insertStmt.run(
                autoSpec.name, autoSpec.description || '', autoSpec.priority || 0,
                JSON.stringify(resolved.trigger),
                JSON.stringify(resolved.conditions),
                JSON.stringify(resolved.actions),
                resolved.template_id,
                doseProgId,
              );
              summary.added.push({ id: res.lastInsertRowid, name: autoSpec.name, template_id: resolved.template_id, dose_program_id: doseProgId });
              break;
            }
            case 'modify': {
              if (!ch.current_automation_id) throw new Error('modify requires current_automation_id');
              // If the spec is still missing after name recovery, downgrade to KEEP
              // rather than aborting the apply. This is safer than throwing: the
              // existing automation stays intact, the operator sees a warning, and
              // the remainder of the plan still applies.
              if (!autoSpec) {
                summary.warnings.push({
                  change: ch,
                  warning: `modify could not be resolved (index ${ch.proposed_automation_index} invalid, no name match for "${ch.target}"). Downgraded to KEEP — existing automation #${ch.current_automation_id} left unchanged.`,
                });
                summary.kept.push({ id: ch.current_automation_id, name: ch.target, downgraded_from: 'modify' });
                break;
              }
              const resolved = resolveAutoSpec(autoSpec);
              const doseProgId = resolveDoseProgramId(autoSpec);
              const r = updateStmt.run(
                autoSpec.name, autoSpec.description || '', autoSpec.priority || 0,
                JSON.stringify(resolved.trigger),
                JSON.stringify(resolved.conditions),
                JSON.stringify(resolved.actions),
                resolved.template_id,
                doseProgId,
                ch.current_automation_id,
              );
              if (r.changes === 0) throw new Error(`automation ${ch.current_automation_id} not found`);
              summary.modified.push({ id: ch.current_automation_id, name: autoSpec.name, template_id: resolved.template_id, dose_program_id: doseProgId });
              break;
            }
            case 'remove': {
              if (!ch.current_automation_id) throw new Error('remove requires current_automation_id');
              const r = disableStmt.run(ch.current_automation_id);
              if (r.changes === 0) {
                // The automation no longer exists (already hard-deleted by the operator
                // or a prior plan). The intent — "make sure it isn't running" — is
                // already satisfied, so treat as a no-op with a warning.
                summary.warnings.push({
                  change: ch,
                  warning: `remove target automation #${ch.current_automation_id} no longer exists. Intent already met, skipping.`,
                });
                break;
              }
              summary.disabled.push({ id: ch.current_automation_id, name: ch.target });
              break;
            }
            case 'keep': {
              // Verify the kept automation still exists; warn if not.
              const exists = db.prepare('SELECT id FROM automations WHERE id = ?').get(ch.current_automation_id);
              if (!exists) {
                summary.warnings.push({
                  change: ch,
                  warning: `keep target automation #${ch.current_automation_id} no longer exists. Skipping.`,
                });
                break;
              }
              summary.kept.push({ id: ch.current_automation_id, name: ch.target });
              break;
            }
            default:
              throw new Error(`unknown change_type: ${ch.change_type}`);
          }
        } catch (e) {
          summary.errors.push({ change: ch, error: String(e?.message || e) });
        }
      }
    });
    tx(changes);

    // Apply mixture_requests[]: for each request, create a draft mixture + its items
    // and set the target tank's pending_mixture_id. Operator physically prepares the
    // recipe at the next refill (which clears pending_mixture_id and activates it).
    summary.mixtures_pending = [];
    // mixture_requests now comes in as a JSON-array string (grammar size cap on the planner
    // tool schema forced strings instead of typed arrays). Parse defensively.
    let mixtureRequests = [];
    if (Array.isArray(proposed.mixture_requests)) {
      // Back-compat with older plans that stored it typed
      mixtureRequests = proposed.mixture_requests;
    } else if (typeof proposed.mixture_requests === 'string' && proposed.mixture_requests.trim()) {
      try { mixtureRequests = JSON.parse(proposed.mixture_requests); }
      catch (e) { summary.errors.push({ mixture_requests_parse: String(e.message) }); }
    }
    if (!Array.isArray(mixtureRequests)) mixtureRequests = [];
    if (mixtureRequests.length > 0) {
      const insertMixture = db.prepare("INSERT INTO fertigation_mixtures (name, description) VALUES (?, ?)");
      const findIngredient = db.prepare('SELECT id FROM fertigation_ingredients WHERE name = ?');
      const insertItem = db.prepare(`
        INSERT INTO fertigation_mixture_items (mixture_id, ingredient_id, parts, amount, unit)
        VALUES (?, ?, 1, ?, ?)
      `);
      const bindPending = db.prepare(`
        UPDATE fertigation_tanks SET pending_mixture_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
      `);
      const mtx = db.transaction(() => {
        for (const req of mixtureRequests) {
          try {
            if (!req.target_tank_id) throw new Error('target_tank_id missing');
            const tank = db.prepare('SELECT id, name FROM fertigation_tanks WHERE id = ?').get(req.target_tank_id);
            if (!tank) throw new Error(`target tank ${req.target_tank_id} not found`);
            let items = [];
            try { items = JSON.parse(req.ingredients || '[]'); } catch (e) { throw new Error('ingredients is not valid JSON: ' + e.message); }
            if (!Array.isArray(items) || items.length === 0) throw new Error('ingredients must be a non-empty array');
            const mixId = insertMixture.run(
              req.proposed_name || `Planner proposal for ${tank.name}`,
              `Auto-created from planner mixture_request. Rationale: ${req.rationale || req.purpose || ''}`,
            ).lastInsertRowid;
            for (const it of items) {
              if (!it.name) continue;
              const ing = findIngredient.get(it.name);
              if (!ing) {
                // Skip silently — the prompt forbids inventing names, but be defensive.
                continue;
              }
              const amount = parseFloat(it.amount);
              if (!Number.isFinite(amount) || amount <= 0) continue;
              insertItem.run(mixId, ing.id, amount, it.unit || 'kg');
            }
            bindPending.run(mixId, req.target_tank_id);
            summary.mixtures_pending.push({
              tank_id: req.target_tank_id,
              tank_name: tank.name,
              mixture_id: mixId,
              proposed_name: req.proposed_name,
            });
          } catch (e) {
            summary.errors.push({ mixture_request: req.proposed_name || '(unnamed)', error: String(e?.message || e) });
          }
        }
      });
      mtx();
    }

    db.prepare(`
      UPDATE operational_plans
      SET status = 'confirmed',
          applied_at = CURRENT_TIMESTAMP,
          applied_by_user_id = ?,
          applied_summary = ?
      WHERE id = ?
    `).run(userId || null, JSON.stringify(summary), planId);

    return { plan: this.getPlanById(planId), applied_summary: summary };
  }

  /**
   * Reject a pending plan with operator feedback, then immediately regenerate
   * a new plan that addresses the feedback.
   *
   * @param {number} planId
   * @param {string} feedback - the operator's free-text comment
   * @param {number} userId
   * @returns {object} - { rejected: <oldPlan>, regenerated: <newPlan> }
   */
  async rejectPlan(planId, feedback, userId = null) {
    const plan = this.getPlanById(planId);
    if (!plan) throw new Error(`Plan ${planId} not found`);
    if (plan.status !== 'pending') {
      const err = new Error(`Plan ${planId} cannot be rejected (status=${plan.status})`);
      err.code = 'INVALID_STATE';
      throw err;
    }
    const fb = (feedback || '').trim();
    if (!fb) {
      const err = new Error('Reject requires non-empty feedback text');
      err.code = 'FEEDBACK_REQUIRED';
      throw err;
    }

    db.prepare(`
      UPDATE operational_plans
      SET status = 'rejected', rejection_feedback = ?, applied_by_user_id = ?
      WHERE id = ?
    `).run(fb, userId || null, planId);

    const rejected = this.getPlanById(planId);

    // Regenerate using the rejected plan as the parent + injecting feedback into context.
    const generatedFor = rejected.generated_for || this._localDateStr(new Date());
    const regenerated = await this.generatePlanForTomorrow(generatedFor, {
      previous_rejection: {
        rejected_plan_id: rejected.id,
        plan_date: rejected.plan_date,
        version: rejected.version,
        headline: rejected.headline,
        summary: rejected.summary,
        feedback: fb,
      },
    });

    return { rejected, regenerated };
  }

  // -------- clarifications --------

  /** List the full clarification thread for a plan, oldest-first. */
  listClarifications(planId) {
    return db.prepare(`
      SELECT * FROM operational_plan_clarifications
      WHERE plan_id = ?
      ORDER BY created_at ASC, id ASC
    `).all(planId);
  }

  /**
   * Post a clarification on a plan. Always-on: stores the operator's message,
   * immediately calls Claude with the plan + thread + current snapshot for a
   * grounded explanation, stores the response, and returns the populated row.
   *
   * Does NOT modify the plan. The operator can later choose to bundle the
   * thread into a regenerate via convertClarificationsToRegenerate().
   */
  async postClarification({ planId, message, role = 'question', userId = null, userName = null }) {
    const plan = this.getPlanById(planId);
    if (!plan) throw new Error(`Plan ${planId} not found`);
    const trimmed = (message || '').trim();
    if (!trimmed) {
      const err = new Error('Clarification message is required'); err.code = 'MESSAGE_REQUIRED'; throw err;
    }
    const r = ['question', 'highlight'].includes(role) ? role : 'question';

    // Persist the operator's message first so we have an audit trail even if Claude fails.
    const insertId = db.prepare(`
      INSERT INTO operational_plan_clarifications
        (plan_id, user_id, user_name, role, message)
      VALUES (?, ?, ?, ?, ?)
    `).run(planId, userId, userName, r, trimmed).lastInsertRowid;

    // Build the prompt context.
    const thread = this.listClarifications(planId);
    const todayStr = this._localDateStr(new Date());
    let snapshot;
    try { snapshot = agronomistService.aggregateDailyData(todayStr); }
    catch (e) { snapshot = { error: e.message }; }

    const userMessage = [
      '# Operator clarification request',
      '',
      `Plan id: ${plan.id}, plan_date: ${plan.plan_date}, version: ${plan.version}, status: ${plan.status}.`,
      `Operator intent: ${r === 'highlight' ? 'HIGHLIGHT (operator believes the plan missed something)' : 'QUESTION (operator wants reasoning explained)'}.`,
      '',
      '## Operator says:',
      trimmed,
      '',
      '## Prior thread (oldest first; including the message above as the last entry):',
      ...thread.map(c => `- [${c.role}] ${c.user_name || 'operator'}: ${c.message}${c.planner_response ? `\n  → planner: ${c.planner_response.slice(0, 500)}` : ''}`),
      '',
      '## Plan you previously produced (the one being questioned)',
      '```json',
      JSON.stringify({
        headline: plan.headline,
        summary: plan.summary,
        proposed_plan: plan.proposed_plan,
      }, null, 2).slice(0, 12000),
      '```',
      '',
      '## Current operational snapshot (TODAY, for grounding):',
      '```json',
      JSON.stringify(snapshot, null, 2).slice(0, 6000),
      '```',
      '',
      'Reply per the SYSTEM rules. End with the verdict line.',
    ].join('\n');

    const SYSTEM_PROMPT = `You are the same operational planner that wrote the plan being questioned. The operator wants to discuss it WITHOUT modifying it.

# Your job

Read the operator's message, the prior thread, the plan, and the current operational snapshot. Reply with concrete, data-grounded reasoning.

# Rules

1. **Cite specifics from the plan.** Name the proposed_automation, target, risk, or dose_program_request you're talking about.
2. **Check the operator's empirical claims against the snapshot.** If they say "VWC peaks at 60%", verify against today_snapshot.substrate_diagnostics (zone_avg, zone_max, oscillation, dry_down_median). Quote actual numbers.
3. **Acknowledge real omissions.** If the operator has identified something the plan genuinely missed, say so plainly.
4. **Do not regenerate the plan.** This is conversation only. If the issue is significant enough to warrant a structural change, recommend the operator convert this thread into a rejection feedback (the UI has a button for it).
5. Be terse. Two paragraphs max. The operator reads many of these per day.

# Required ending — pick ONE verdict line, EXACTLY this format

[VERDICT: plan_correct] — the plan stands; here is why
[VERDICT: concern_valid] — the operator has flagged something the plan missed/got wrong; describe the adjustment that should be made on the next regenerate
[VERDICT: need_more_data] — operator should provide X before this can be answered

The verdict line must be the LAST line of your response.`;

    const client = this._client_or_throw();
    const cfg = this.getConfig();
    let responseText = '';
    let verdict = null;
    try {
      const msg = await client.messages.create({
        model: cfg.model || DEFAULT_MODEL,
        max_tokens: 1500,
        system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: userMessage }],
      });
      const block = msg.content?.find(b => b.type === 'text');
      responseText = block?.text || '(no response)';
      const m = responseText.match(/\[VERDICT:\s*(plan_correct|concern_valid|need_more_data)\s*\]/i);
      if (m) verdict = m[1].toLowerCase();
    } catch (err) {
      responseText = `[Planner responder failed: ${err.message || String(err)}]`;
    }

    db.prepare(`
      UPDATE operational_plan_clarifications
      SET planner_response = ?, response_verdict = ?, responded_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(responseText, verdict, insertId);

    return db.prepare('SELECT * FROM operational_plan_clarifications WHERE id = ?').get(insertId);
  }

  /**
   * Convert all open clarifications on a plan into a single rejection feedback,
   * mark the plan rejected, and regenerate. The new plan's id is linked back
   * on each clarification via addressed_by_plan_id.
   */
  async convertClarificationsToRegenerate(planId, userId = null) {
    const plan = this.getPlanById(planId);
    if (!plan) throw new Error(`Plan ${planId} not found`);
    if (!['pending', 'confirmed'].includes(plan.status)) {
      const err = new Error(`Plan ${planId} cannot be regenerated from clarifications (status=${plan.status})`);
      err.code = 'INVALID_STATE'; throw err;
    }

    const open = db.prepare(`
      SELECT * FROM operational_plan_clarifications
      WHERE plan_id = ? AND status = 'open'
      ORDER BY created_at ASC
    `).all(planId);
    if (open.length === 0) {
      const err = new Error('No open clarifications to convert'); err.code = 'NO_CLARIFICATIONS'; throw err;
    }

    // Bundle clarifications + planner responses into a single feedback blob.
    const feedback = [
      'Operator-raised clarifications that warrant a plan revision:',
      ...open.map((c, i) => `${i + 1}. [${c.role}] ${c.message}${c.planner_response ? `\n   Planner response: ${c.planner_response.split('\n').slice(-3).join(' ')}` : ''}`),
    ].join('\n');

    let result;
    if (plan.status === 'pending') {
      // Standard path: reject the pending plan + regenerate the same date.
      result = await this.rejectPlan(planId, feedback, userId);
    } else {
      // Confirmed plan path: leave the applied record untouched (preserve history of
      // what actually ran), and generate a new version for the same date carrying
      // the clarifications as feedback. The new version is `pending` and supersedes
      // the confirmed one only if the operator manually applies it.
      const generatedFor = plan.generated_for || this._localDateStr(new Date());
      const regenerated = await this.generatePlanForTomorrow(generatedFor, {
        previous_rejection: {
          rejected_plan_id: plan.id,
          plan_date: plan.plan_date,
          version: plan.version,
          headline: plan.headline,
          summary: plan.summary,
          feedback: `[NOTE: prior plan v${plan.version} on ${plan.plan_date} was already CONFIRMED and applied; this revision was requested via clarification thread. Address the operator's concerns explicitly — if the new plan diverges from the running automations, list the deltas clearly so the operator can decide whether to apply.]\n\n${feedback}`,
        },
      });
      result = { rejected: plan, regenerated };
    }

    // Link the open clarifications to the new plan + mark them addressed.
    if (result.regenerated?.id) {
      const upd = db.prepare(`
        UPDATE operational_plan_clarifications
        SET status = 'addressed', addressed_by_plan_id = ?
        WHERE id = ?
      `);
      const tx = db.transaction(() => { for (const c of open) upd.run(result.regenerated.id, c.id); });
      tx();
    }

    return result;
  }

  // -------- reads --------

  /** List plans — by default returns LATEST version per plan_date. */
  listPlans(limit = 30, offset = 0, opts = {}) {
    if (opts.includeAllVersions) {
      return db.prepare(`
        SELECT id, plan_date, version, parent_plan_id, generated_for, generated_at,
               headline, summary, input_tokens, output_tokens,
               status, error, applied_at, rejection_feedback
        FROM operational_plans
        ORDER BY plan_date DESC, version DESC
        LIMIT ? OFFSET ?
      `).all(limit, offset);
    }
    return db.prepare(`
      SELECT id, plan_date, version, parent_plan_id, generated_for, generated_at,
             headline, summary, input_tokens, output_tokens,
             status, error, applied_at, rejection_feedback
      FROM operational_plans op
      WHERE version = (SELECT MAX(version) FROM operational_plans WHERE plan_date = op.plan_date)
      ORDER BY plan_date DESC
      LIMIT ? OFFSET ?
    `).all(limit, offset);
  }

  /** List all versions for a single plan_date (history). */
  listVersionsForDate(dateStr) {
    return db.prepare(`
      SELECT id, plan_date, version, parent_plan_id, generated_at,
             headline, summary, status, applied_at, rejection_feedback
      FROM operational_plans
      WHERE plan_date = ?
      ORDER BY version ASC
    `).all(dateStr);
  }

  getPlanById(id) {
    const row = db.prepare('SELECT * FROM operational_plans WHERE id = ?').get(id);
    return this._hydrate(row);
  }

  /** Returns the LATEST-version plan for a date. */
  getPlanByDate(dateStr) {
    return this._latestPlanForDate(dateStr);
  }

  /**
   * Map planner-schema trigger_config → live automation engine shape.
   * Schedule trigger: {type, schedule_type, time}
   * Threshold trigger: {type, equipment_id (string), sensor_type (lowercase metric), operator, threshold_value (string), unit}
   * Engine reads equipment_id and threshold_value as strings; mirror that for compatibility.
   */
  _normalizeTriggerForEngine(t) {
    if (!t || typeof t !== 'object') return {};
    if (t.type === 'schedule') {
      return {
        type: 'schedule',
        schedule_type: t.schedule_type || 'daily',
        time: t.time || '',
      };
    }
    if (t.type === 'threshold') {
      return {
        type: 'threshold',
        equipment_id: t.sensor_equipment_id ? String(t.sensor_equipment_id) : '',
        sensor_type: t.sensor_metric || '',
        operator: t.operator || 'gt',
        threshold_value: t.threshold_value != null ? String(t.threshold_value) : '',
        unit: t.threshold_unit || '',
      };
    }
    return { ...t };
  }

  /**
   * Map planner-schema actions[] → live automation engine shape.
   * Sentinel translation:
   *   channel: 0 → null (whole-device action — typically only the engine knows what to do here)
   *   equipment_name / channel_name / severity / message: '' → null
   *   duration_seconds / delay_seconds: 0 → null
   */
  _normalizeActionsForEngine(actions) {
    if (!Array.isArray(actions)) return [];
    return actions.map(a => ({
      type: a.type,
      action: a.action || null,
      equipment_id: a.equipment_id || null,
      equipment_name: a.equipment_name || null,
      channel: (a.channel != null && a.channel > 0) ? a.channel : null,
      channel_name: a.channel_name || null,
      delay_seconds: a.delay_seconds || null,
      duration_seconds: a.duration_seconds || null,
      severity: a.severity || null,
      message: a.message || null,
    }));
  }

  _hydrate(row) {
    if (!row) return null;
    let plan = null;
    try { plan = row.proposed_plan_json ? JSON.parse(row.proposed_plan_json) : null; } catch {}
    let snapshot = null;
    try { snapshot = row.input_snapshot ? JSON.parse(row.input_snapshot) : null; } catch {}
    let appliedSummary = null;
    try { appliedSummary = row.applied_summary ? JSON.parse(row.applied_summary) : null; } catch {}
    let warnings = [];
    try { warnings = row.consistency_warnings ? JSON.parse(row.consistency_warnings) : []; } catch {}
    return {
      ...row,
      proposed_plan: plan,
      input_snapshot: snapshot,
      applied_summary: appliedSummary,
      consistency_warnings: warnings,
    };
  }

  deletePlan(id) {
    const r = db.prepare('DELETE FROM operational_plans WHERE id = ?').run(id);
    return r.changes;
  }
}

const operationalPlannerService = new OperationalPlannerService();

module.exports = { operationalPlannerService, OperationalPlannerService };
