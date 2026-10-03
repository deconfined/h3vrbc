# Launch dispersion and the projectile spawn offset

Two launch-frame details that the ballistics depend on, traced from the verified
120p3 assembly. This is the source evidence behind `dispersion()` and
`SPAWN_RECESS_METRES` in `public/physics.js`.

## Dispersion

`FistVR.FVRFireArm::Fire`, RVA **428892** (`0x68b5c`). Inside the per-projectile
loop, IL offsets 387-415 build one scalar in degrees:

```
round.ProjectileSpread
  + this.m_internalMechanicalMOA
  + this.GetCombinedMuzzleDeviceAccuracy()
```

and IL offsets 494-536 turn it into a launch offset:

```
Vector2 spread = (Random.insideUnitCircle() + Random.insideUnitCircle()
                  + Random.insideUnitCircle()) * 0.33333334f * moa;
transform.Rotate(new Vector3(
    spread.x + GetCombinedFixedDrop(AccuracyClass)   / 60,   // IL 538-561
    spread.y + GetCombinedFixedDrift(AccuracyClass).x / 60,   // IL 562-576
    0f));
```

So dispersion enters through the **same** `Transform.Rotate` as the fixed drop and
drift bias already modelled in `muzzleEffects`, and nothing else. There is no
separate dispersion force, no velocity perturbation, and no range-dependent
term: it is purely an angular offset applied at launch.

### The two mechanical components are random, and drawn once

| Component | Source | Range |
| --- | --- | --- |
| `m_internalMechanicalMOA` | `FVRFireArm.Awake`, RVA 422720 | — |
| `m_mechanicalAccuracy` | `MuzzleDevice.Awake`, RVA 2418581 | — |

Both call `FistVR.AM::GetFireArmMechanicalSpread`, RVA **888235** (`0xd8cab`):

```
return Random.Range(dic[me].MinDegrees, dic[me].MaxDegrees) * 0.5f;
```

Two consequences that decide how the calculator may present this:

1. **It is a per-object draw, not a per-shot one.** `FVRFireArm.Awake` and
   `MuzzleDevice.Awake` each sample once when the object is spawned. Every shot
   from that weapon in that session prints the same group.
2. **It is therefore not reproducible from game data.** The same weapon in
   another session draws a different value from the same min/max range. No
   tool can predict the group a session will produce.

`GetCombinedMuzzleDeviceAccuracy`, RVA 424608, sums `GetMechanicalAccuracy()`
over **all** registered devices — unlike `GetCombinedFixedDrift`, which reads
only the last one and returns zero with no devices fitted. The firearm's own
mechanical component is set unconditionally in `Awake`, so unlike fixed drift it
contributes even with nothing mounted.

### What the calculator reports

`dispersion()` returns the authored bounds of that draw and never a predicted
group:

```
minDegrees = round.spreadDegrees + firearm.MinDegrees/2 + Σ device.MinDegrees/2
maxDegrees = round.spreadDegrees + firearm.MaxDegrees/2 + Σ device.MaxDegrees/2
```

`Random.insideUnitCircle` is uniform on the unit disc, so one sample has
`E|v|² = 1/2` and the mean of the three `Fire` draws has `E|v|² = 1/6`. The
full-disc figure is therefore the hard bound on the game's own three-sample
mean, and its expected radius is that bound times `1/√6 ≈ 0.408`. Both are
reported; neither is called a group.

Linear in range, because the offset is a launch rotation:

```
radius(r) = r · tan(maxDegrees)
```

### Not certified

The one extracted weapon without an accuracy class is `M320GrenadeLauncher`.
Rather than treat its mechanical term as zero, `dispersion()` excludes it, sets
`incomplete`, names the omission in `missing`, and the UI and CSV prefix the
figure with `≥`. The same applies to a round with no extracted `spreadDegrees`.

## Dial granularity

Not dispersion, but the other bounded source of impact error, and it composes
with the cone rather than replacing it.

One turn of the optic's tuning component moves exactly one authored tick. The tick
size is a **per-optic serialized property**, not a global constant.

`FistVR.PIPScopeController.UpdateScopeParams`, RVA **509936** (`0x7c7f0`),
IL 564-779:

```
local = ScopeElevationMagnitude * ScopeElevationAdjustmentPerTick
ZeroScaling == 1 -> local *= 0.01666666753590107
ZeroScaling == 2 -> local *= 0.05624999850988388
ZeroScaling == 3 -> local *= 0.0572957806289196
ZeroScaling == 0 -> no factor
scopeAdjustmentDegrees = (base + windageLocal, local)
```

`ScopeElevationMagnitude` is an integer tick count and the destination field is
named `scopeAdjustmentDegrees`, so the scaling factors convert the authored unit
into degrees: mode 1 is **MOA**, mode 3 is **mrad**, mode 0 is already degrees.
Mode 2 has no documented unit and is left unlabelled. `ZeroingMode` selects
scope versus reticle adjustment, each with its own per-tick value.

Resolved across the shipped optics, the click size spans **66x**:

| Authored | mrad per click | Optics |
| --- | --- | --- |
| 0.25 MOA | 0.0727 | 8 |
| 0.1 mrad | 0.1000 | 15 |
| 0.5 MOA | 0.1454 | 78 |
| 0.2 mrad | 0.2000 | 4 |
| 0.25 (mode 2) | 0.2454 | 4 |
| 0.25 mrad | 0.2500 | 2 |
| 1.0 MOA | 0.2909 | 40 |
| 0.5 mrad | 0.5000 | 2 |
| 1.0 mrad | 1.0000 | 4 |
| 0.2765 degrees | 4.8258 | 2 |

The common click is 0.5 MOA = 0.145 mrad, and most scopes are coarser than a
0.1 mrad click. Three optics serialize no tick at all and are given no band
rather than a plausible default.

Only **two** clicks bracket a solved adjustment, so this is a choice, not a
tolerance: the two residuals are `d` and `d - one click`, which means the two
reachable impacts always land on opposite sides of the aim point unless the
solved value coincides with a click.

## A separate, coarser interface

`FistVR.Amplifier` (the scope-tuning menu) has its own grid:
`Amplifier.Zero`, RVA **429036**, rotates by
`Quaternion.AngleAxis(0.004166674800217152f * Step, axis)` with
`ElevationStep`/`WindageStep` incremented per click by `SetCurSettingUp`
(RVA 2186960). That is a fixed 0.0041666748 degrees, i.e. 0.2500005 MOA. It is a
**different interface** from the adjustment components the player turns on the
optic, and it is not what the reticle does. Do not use it as the click size.

## Missing windage

`FistVR.OpticOptionType` gates the tuning menu:

| Ordinal | Member |
| --- | --- |
| 1 | `Zero` |
| 2 | `Magnification` |
| 3 | `ReticleLum` |
| 4 | `ReticleType` |
| 5 | `FlipState` |
| 6 | `ElevationTweak` |
| 7 | `WindageTweak` |

`SetCurSettingUp` switches on `OptionTypes[CurSelectedOptionIndex]` and does
nothing for ordinals 2-5; cases 6 and 7 bump `ElevationStep` and `WindageStep`.
An optic whose option list has no `WindageTweak` offers no lateral adjustment at
all, which is a different failure from a click-sized residual: the whole lateral
correction is undialled.

`OptionTypes` is a serialized field on `FistVR.Amplifier`, the per-weapon
scope-tuning gizmo spawned from `Prefab_OpticUI` in `Amplifier.Awake` (RVA
2449520). No `Amplifier` component exists in `resources.assets`, any
`StreamingAssets` bundle, or levels 0-2, so this capability is **not extractable**
with the current tooling and is surfaced as a stated setting instead.

## Projectile spawn recess

`Fire`, IL offsets 439-476:

```
Vector3 forward = transform.forward * 0.004999999888241291f;   // ldc.r4 at 445
... Instantiate(round.BallisticProjectilePrefab,
                transform.position - forward, ...)
```

The projectile is spawned **5 mm behind** the muzzle transform, along its own
forward axis. `Fire` then rotates that transform by the drop/drift/dispersion
bias before the spawn, so the recess is applied to the already-biased pose.

Since range in this calculator is measured from the optical origin, and
`sightSetback` is how far that origin sits behind the muzzle, the effective
spawn offset along the sight line is `sightSetback − 0.005`. This is the
verified meaning of what was previously a bare literal: the optical origin sits
5 mm ahead of the muzzle plane.

The value is the float32 image of `0.005`, matching the `ldc.r4` in the source.