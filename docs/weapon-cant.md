# Weapon cant model

Cant is an assumed roll about the sight ray through the optical origin, not a live game measurement. Viewed through the optic, positive cant tilts weapon-up toward the shooter's right. Supported inputs are −90° to +90° for a known cant, or 0° to 90° for a symmetric tolerance about zero. The two modes cannot be combined.

## Pose and solve

The existing bore transform is `B = Ry(yaw) Rx(-pitch)`. In sight-relative coordinates `(right, up, along)`, cant adds:

```text
right' = right cos(cant) + up sin(cant)
up'    = up cos(cant) - right sin(cant)
along' = along
```

This rotates both the muzzle's spawn offset and its launch direction, including deterministic weapon/device bias. The firing-angle rotation then inclines the sight frame into the world; gravity remains world-down throughout integration. Height and lateral output stay in the **unrolled sight frame**, so a positive height/lateral value is not a canted elevation/windage dial setting.

For **specific cant**, the two-axis solver finds weapon-local pitch and yaw at that fixed roll. Its starting estimate is an uncanted solve transformed into canted local axes, avoiding singular pitch-only bracketing at a sideways weapon. Factory/game-authored zero geometry remains weapon-local; **Calculated zero** also includes the known roll. Aim corrections are solved pitch/yaw minus base pitch/yaw. The top scope-adjustment callouts negate those corrections in both mrad and MOA; range-card/CSV values retain the aim-correction convention. This changes the base range card and the required scope settings, while corrected flight still reaches the aim point within numerical tolerance.

The graph's uncorrected optic ray uses `C B(corrected) B(base)^-1 C^-1`, where `C` is the roll transform. Both poses share that roll. This is not the corrected aim axis or a line through corrected impact.

## Uncertainty without compensation

For **cant uncertainty**, nominal roll is zero. The calculator solves once per nominal range-card row as before; uncertainty probes reuse the selected target's solved pitch/yaw **without re-solving for each roll**. Re-solving would compensate the accidental cant and conceal the error.

For nonzero tolerance, probes use 21 evenly spaced angles from `−tolerance` through `+tolerance`, including zero and both endpoints. Zero tolerance reuses the nominal shot only. Full trajectories are simulated through the selected range; sampled height/lateral minima and maxima at that range determine the reported bounds. Angular lateral bounds are `atan2(lateral, range) × 1000` mrad relative to corrected aim, not suggested dial adjustments. The nominal range card and corrected centerline remain unchanged.

The SVG shades convex hulls of projected samples between adjacent range sections, and a hull of sampled impacts on the back wall. A separate purple lateral-width ruler marks the target's sampled lateral bounds, lowered below the impact region **on that wall** so it does not mask the lateral offset guide. Its height is a display choice, not an impact height. A color-coded side readout labels **RISE** for corrected impact above/level with uncorrected POA, or **DROP** for impact below, alongside **DRIFT** and **ERROR**. ERROR shows lateral error relative to nominal corrected impact, using ± for equal rounded left/right magnitudes or separate left/right values for asymmetric bounds. ± is per-side error; the full ruler spans twice that value. Disabled uncertainty shows a dash, and incomplete uncertainty shows UNBOUNDED. Display scales are independently exaggerated as in the rest of the chart. Convex shading is illustrative: it can include combinations that no single cant angle produces. Sampling can miss extrema between probe angles; these are **approximate sampled bounds**, not guaranteed continuous worst-case bounds or a statistical confidence interval.

Only projectile samples determine the height range: its ceiling is the highest plotted nominal/probe apex, or zero for flat flight. The original optic ray is clipped to that range, and an off-height zero marker is omitted rather than clamped or used to expand the ceiling. The side readout retains actual selected-range plane offsets for off-wall POA intersections; visible markers/guides still require an in-bounds intersection.

If any probe cannot reach the selected range because of flight/scene limits, no partial band or bounds are presented as complete. The nominal solution remains available, and the UI/CSV identify the failed probe angles. Optic zero does not eliminate cant error: rolling the bore/optic compensation does not roll gravity.

Cant mode and both raw input fields persist with the opted-in active interface, including inactive fields; only the active field enters calculation. Older snapshots default to no cant. Named weapon/optic favorites leave these shooting-condition inputs untouched. CSV records the mode, active angle/tolerance, probe count, completion state and selected-range bounds without adding range-card columns.
