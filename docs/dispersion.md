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