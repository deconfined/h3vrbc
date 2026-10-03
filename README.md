# H3VR Ballistic Calculator

A local web calculator for **Hot Dogs, Horseshoes & Hand Grenades (H3VR)**. It uses parameters extracted from your game installation and a JavaScript port of the verified 120p3 projectile model to calculate elevation, windage, flight time, launch speed, trajectories, and range cards.

The app is unofficial and is not affiliated with RUST LTD. It is for H3VR, not real firearms.

## Requirements

- Node.js **22 or newer** and npm.
- **uv** and Python **3.11 or newer** for data extraction and Python tests.
- A local copy of the supported **H3VR 120p3** game data.
- A modern browser with JavaScript enabled.

The extractor checks `Managed/Assembly-CSharp.dll` against the verified SHA-256:

```text
033e275871f798eeab5d6cdf0c7ace348cdff2acf9588b1a6c1a46805f20a76b
```

An unverified assembly is rejected. Supporting another version requires inspecting its projectile behavior and updating the model and extractor.

## Quick start

Run these commands from the project directory. First install the development dependencies:

```sh
npm ci
```

Copy your game's `h3vr_Data` directory into `game_data/`, keeping its contents intact:

```text
game_data/
└── h3vr_Data/
    ├── Managed/
    ├── StreamingAssets/
    ├── globalgamemanagers
    ├── resources.assets
    └── level…
```

Then extract the local dataset and start the server:

```sh
npm run extract
npm run dev
```

Open **http://127.0.0.1:5173**. Extraction creates `public/data/h3vr.json`; the browser needs this file to load the calculator. Re-extract after changing supported game data. There is no frontend build step.

The server listens on all network interfaces and prints LAN URLs for use from another device. Anyone who can reach its port can read the app and generated numeric dataset. It serves only `public/`, so the raw files in `game_data/` are not served.

To use a different port in a POSIX shell:

```sh
PORT=5180 npm run dev
```

## GitHub Pages

The included `.github/workflows/pages.yml` deploys `public/` on pushes to `main` or when run manually from the Actions tab. No Node.js server or frontend build is needed.

1. Generate the dataset locally with `npm run extract`.
2. Include the generated numeric dataset in your deployment commit. It is ignored by default, so explicitly stage it:

   ```sh
   git add -f public/data/h3vr.json
   ```

3. In the repository's **Settings → Pages**, set **Source** to **GitHub Actions**.
4. Commit and push the workflow and dataset to `main`.

The deployed dataset will be publicly downloadable. Do not commit raw files from `game_data/`; the workflow uploads only `public/`. Deployment fails if the generated dataset is missing. Regenerate and commit the dataset when updating supported game data.

## Extracting from another location

To use an existing installation without copying it, invoke the extractor directly with either the installation root or its `h3vr_Data` directory:

```sh
uv run \
  --with UnityPy==1.25.3 \
  --with TypeTreeGeneratorAPI==0.0.10 \
  --with dnfile==0.18.0 \
  --with dncil==1.0.2 \
  tools/extract.py "/path/to/H3VR"
```

The default output remains `public/data/h3vr.json`. The extractor also accepts `--output PATH`, but the web app loads the default location.

Extraction records numeric parameters, identifiers, curves, and source provenance. It does not copy textures, meshes, or game code into the website. Both `game_data/` and `public/data/` are ignored by Git.

## Using the calculator

The left menu has independently expandable sections:

1. **Simulation:** choose a scene, projectile limit, and gravity mode. Timing and world-height inputs are available under the advanced controls.
2. **Weapon & ammunition:** search for a weapon and supported round. Select a chamber/barrel for multi-chamber weapons and set charge for supported sticky shots. Weapon presets fill verified geometry and firing multipliers.
3. **Muzzle devices:** search suppressors, brakes, extenders, and other devices, then add them to the loadout. Match the game's registration order using Earlier/Later controls. Stock geometry treats this as an inner-to-outer mount chain.
4. **Sight & range:** choose an optic preset and a matching direct weapon mount to fill sight geometry and the authored default zero setting, or enter values manually. Sliding rails default to an **assumed midpoint (50%)**, adjustable from rear (0%) to front (100%). Sight height and setback describe the **bare weapon muzzle**; device geometry supplies the effective adjustment. Set firing angle, weapon cant mode, target range with its measurement unit, and range-card interval.
5. **Manual overrides:** supply missing values or adjust geometry and velocity multipliers for your setup.

Click **Calculate solution** after changing the firing setup. Changes invalidate the previous solution and CSV export. Browsing weapon or device candidates and opening or closing sections preserve the current calculation.

The **isometric 2.5D chart** shows the projectile flight **after applying the solved elevation and windage aim corrections** for the selected range. It is separately simulated with the corrected launch angles, bringing impact onto aim within numerical tolerance. The chart's zero-offset axis is **corrected aim**. The straight dashed **uncorrected POA** ray is the original optic ray with no additional dial adjustments, rotated with the weapon into that corrected sight frame. Its direction uses the full base-to-corrected pitch/yaw rotation, not the corrected aim axis or a line drawn through corrected impact. Its **base-zero** reference rotates with it and can extend beyond a shorter selected shot range; only the reference extends, not the computed projectile flight. The ray is clipped to the projectile height range, and the zero marker is shown only when its actual height fits that range, never moved onto its boundary. The marker labels the entered zero setting, while its position is projected into the corrected sight frame.

The projectile endpoint marks the selected distance, not a target object. The game's nominal base zero does not guarantee a crossing for the uncorrected flight; **Calculated zero** does. Neither requires the corrected flight to cross at the base-zero distance when solving for a different range. Height and lateral scales are independently exaggerated and automatically scaled, not a to-scale scene. The height ceiling is the **highest plotted projectile sample**, including cant probes when enabled; the uncorrected POA cannot stretch it upward. Flat flight keeps a finite height span below the zero-height sight plane. The grid represents that **corrected sight plane**, not terrain; the blue dashed plane projection shows the corrected flight's lateral displacement. Range/lateral bounds still account for the rotated optic reference. On narrow screens, scroll the chart horizontally.

When the uncorrected ray intersects the displayed back wall at the selected range, a separate POA marker and L-shaped height/lateral guides show its separation from corrected impact. Both legs remain on that plane. A readout **beside** the wall shows **RISE** when corrected impact is above or level with uncorrected POA, or **DROP** when below, alongside **DRIFT**, **ERROR** and **CONE**, color-coded to their measurement lines. Height/lateral values are geometric distance magnitudes in centimetres, not elevation/windage dial settings; tooltips give signed changes toward corrected POI. ERROR gives sampled lateral cant uncertainty in cm: **± is per side**, while asymmetric left/right bounds are listed separately. Its purple width ruler sits below the impact region on the wall to avoid masking the lateral guide. Off-wall intersections get no marker or offset guides, but their actual plane distances remain in the side readout. Missing finite forward intersections show **—**. Disabled uncertainty also shows **—**, and incomplete uncertainty shows **UNBOUNDED**, never a misleading zero width. CONE always keeps its figure; it is drawn on the wall only when it fits, so a long-range cone never rescales the flight it annotates.

The calculator simulates **two distinct shots**, and labels which is which on every
number it shows. The **base shot** is what the projectile does at the optic's own
setting, with no correction applied; that is the whole range card and the
**Export CSV** body. The **corrected shot** is a separate re-integration at the
solved aim angles for the selected range; that is what the isometric chart
plots, and the **CORRECTED IMPACT** metric reports. The flight time in the table
is therefore not the flight time of the plotted curve. Their offsets, times and
speeds differ, and only the corrected flight is aimed at the target.

The top **ELEVATION ADJUSTMENT** and **WINDAGE ADJUSTMENT** callouts give the required scope/reticle setting changes from the base zero in mrad and MOA. Their signs are **the inverse of the solved aim corrections**, not instructions to raise/lower aim. With specific cant, they use the weapon's tilted elevation/windage axes.

The range card and **Export CSV** retain the **uncorrected** offsets, time and speed at the base optic setting, alongside the original aim corrections: positive elevation means raise aim; positive windage means aim right. Positive lateral point of impact means the uncorrected projectile is right of the aim point in the unrolled sight frame. Metadata also records cant assumptions, selected-range uncertainty bounds, and every dispersion component with its interpretation.

For unverified mounting, choose measured muzzle geometry, enter the mounted distance and forward/up shifts, and confirm them before calculating. Selecting a device does not establish physical compatibility with the weapon.

### Group dispersion

The game perturbs each projectile's launch with an angular offset drawn once per
spawned weapon and device, not once per shot. The calculator cannot predict the
group a session will print, so it reports the **authored bounds** of that draw
instead of a simulated group.

The **GROUP CONE** metric, the chart's **CONE** readout, the range card's **Cone
Ø** column and the CSV all show the same figure: the full-disc bound of the
game's own three-sample dispersion mean at that range, in cm, computed from the
round's authored `spreadDegrees` plus the firearm's and every fitted device's
mechanical accuracy class. It grows linearly with range and is **not** folded
into the centreline — the chart and the range card describe the same
centerline shot either way. The accompanying detail line gives the angular bound
in MOA and the expected radius of the game's three-sample mean (about 0.41 of
the bound).

Three things it is not:

- **Not a predicted group.** The firearm and each device draw
  `Random.Range(class.MinDegrees, class.MaxDegrees) / 2` once in `Awake`, so the
  value is fixed for a session but differs in the next one. A mid-session
  weapon can print a different bound than the table does.
- **Not a confidence interval.** No group size, per-shot sample or probability
  distribution is claimed.
- **Not always complete.** If the selected weapon has no extracted accuracy
  class, or a round has no extracted spread, that term is excluded rather than
  treated as zero and the figure is prefixed **≥** and named in the detail line
  and CSV metadata.

The **MRAD** with no device fitted bounds at 0.3 MOA, roughly 10.5 cm across at
600 m; adding a suppressor on the 1.5 MOA `SuppressorOld` class raises that to
1.05 MOA, 36.7 cm at 600 m and 73.3 cm at 1200 m. On a long-range scene, this
is typically larger than the drop the chart spends its vertical scale on, which
is the point: report both rather than let the centerline imply precision the
game will not deliver. See [dispersion and spawn-offset notes](docs/dispersion.md).

### Range measurement

The solve always works in distance **along the sight line** from the optical
origin. **Measured as** converts the request:

- **Along the sight line** (default): what the model integrates. Every table row
  and the CSV use this convention.
- **Horizontal distance:** divided by the cosine of the firing angle, so entering
  the horizontal range of a target gives the same solution as entering its
  sight-line distance. At ±90° a horizontal range is undefined and the request is
  refused rather than silently reported as unreachable.

The chart and the range card remain in sight-line range; only the input and the
target label change.

### Weapon cant

Choose one mutually exclusive mode under **Sight & range**:

- **No cant** (default): a level weapon, with no cant uncertainty.
- **Specific cant:** enter a signed angle from −90° to +90°. Positive tilts weapon-up **right**, negative **left**, viewed through the optic. The solve compensates that fixed cant in both weapon-local dial axes; the corrected flight still reaches aim within solver tolerance. Game-authored base zero stays weapon-local; **Calculated zero** solves a crossing at the chosen cant.
- **Cant uncertainty:** enter a tolerance from 0° to 90°. Nominal cant is 0°. The calculator samples 21 evenly spaced angles across **± tolerance**, including zero and both endpoints, without re-solving the displayed nominal dials. A purple flight envelope and impact-width marker show the resulting corrected POI variation; the summary gives lateral bounds in **cm and mrad**, plus height bounds in cm. Zero tolerance uses just the nominal shot.

The envelope is a **sampled geometric approximation**, not a probability distribution, confidence interval, or guaranteed continuous worst-case bound. If any sampled tilt cannot reach the selected range, the nominal solution remains available with a warning, and no partial uncertainty band is displayed. Cant can cause error even at the base zero. These inputs assume weapon roll about the sight ray; they do not detect live VR cant. See [cant model notes](docs/weapon-cant.md).

### Optic defaults

The extractor includes **81 optical attachments / 83 sight views** (57 PIP scope views and 26 reflex views), plus direct weapon-mount geometry. Combo scopes expose their scope and reflex views separately. Regenerate older datasets with `npm run extract` to populate the selector.

Choose a weapon, optic and direct mount. A unique matching mount is selected automatically; multiple matching mounts require a choice. Rail position starts at 50%, explicitly assuming the midpoint rather than a measured in-game pose. Changing the weapon, chamber, optic, mount or rail position recalculates the default bare-muzzle height/setback. **Restore optic defaults** restores geometry and the authored zero rule/setting while keeping the chosen rail position. Geometry and zero inputs remain editable, and searching preserves the selected optic and current calculation.

PIP geometry uses the game's optical origin, including its clamped rear-lens camera offset, rather than guessing from the mesh or lens. Reflex geometry uses the first reticle renderer's transform. PIP optics with disabled base zero select **No base zero adjustment** without forcing the required range input to zero. Positive authored zero distances are suggested in the zero-setting input.

Defaults assume forward-facing, centered **direct** mounting with no optic cant relative to the weapon and no dial trim. Whole-weapon cant is a separate shooting-condition input. Unsupported/off-axis geometry, missing direct mounts, custom muzzle references and extendable telescope geometry leave height/setback blank with an explanation. Adapters, risers, magnifier/clip-on combinations, occupied mounts, physical collisions and live animation poses are not composed or verified. Manual geometry remains available where the centered model is appropriate.

For example, **M4 Carbine + Scope ACOG 4×32** at the top rail midpoint gives approximately **6.989 cm sight height** and **56.565 cm optic setback**, with a default **100 m** optic setting. These are source-derived defaults, not real-firearm measurements or a live-VR validation. See [optic extraction and geometry notes](docs/optics.md).

## Cookies, favorites, and refresh persistence

Storage is **off by default**. In **Saved setups & preferences**, explicitly enable **Allow cookies to remember my interface and favorite setups** to use browser persistence. The app uses no account or external API.

With storage enabled:

- **Named favorites** save the weapon, selected chamber, ordered muzzle devices, round, selected optic/view, direct optic mount and rail position, and zeroing rule/distance. Target range, cant mode/angles and manual geometry/multiplier overrides are outside the named favorite. You can save, load, rename an identical configuration by saving it again, or delete a favorite. Different optics or zero settings are separate saved configurations.
- **The active interface** is saved automatically, including calculation inputs, cant mode and both raw angle fields, optic/view and direct-mount selections, rail position, manual overrides and geometry confirmation, searches and filters, favorite controls, open sections, and page/sidebar/range-table scroll positions.
- **Refreshing** restores the interface. A current calculated solution is recomputed from its restored inputs; unfinished edits remain pending until you calculate.

Loading a named favorite reapplies its weapon/loadout configuration, derives supported optic geometry from the saved mount/rail position, restores the saved zero distance rather than the optic's factory default, and invalidates the current solution. Measured mounting geometry needs fresh verification when loading a favorite. Older favorites without optic/zero fields remain loadable and keep the current optic and zero setting. Refreshing the active interface restores its existing measurements and confirmation.

The cookies are `h3vrbc_favorites` and `h3vrbc_interface`, each with a lifetime of up to one year. They are specific to the browser and site hostname and do not synchronize across devices. Turning the opt-in off deletes both cookies and cancels pending saves, while keeping the currently displayed setup intact. Clearing the site's cookies also removes the saved data.

Cookie storage is limited. If the browser blocks a write or the saved data exceeds the limit, the app reports that it could not save; oversized writes retain the previous saved data. Saved setups referencing unavailable game data are not applied.

## Model scope

The model reproduces the inspected free-flight update, including gravity before drag, the game's Mach-dependent drag curve, single-precision state updates, caliber velocity curves, optic zeroing rules, and fixed muzzle-device launch bias. The projectile spawns 5 mm behind the muzzle transform, matching `Fire`'s own `transform.forward * 0.005f` offset, which puts the optical origin 5 mm ahead of the muzzle plane.

Modern PIP scope/reflex zeroing uses the caliber's authored drop curve. The nominal optic distance does not force the selected projectile through the sight line at that range. **Calculated zero** separately solves a crossing for the chosen projectile and setup.

The base setup assumes a centered optic with no initial dial trim. The weapon is level unless specific cant is selected; the corrected chart applies the solved target-range adjustments and optional fixed-dial cant uncertainty. The model does not simulate impacts, penetration, ricochets, wind, Coriolis, spin drift, guided projectiles, or modded behavior. Launch dispersion is reported as an authored bound rather than sampled or simulated. Multi-projectile rounds show one centerline projectile; submunition paths are excluded. Unsupported projectile integrators appear in the unavailable-projectile list.

Stock geometry reflects authored prefab poses, rather than live animations. The model is source-derived and has not yet been validated against live VR shots; timing, scene settings, and mounting geometry can affect agreement.

## Development and tests

```sh
npm test
npm run test:extract
```

The JavaScript suite covers physics, dispersion, weapon/device behavior, chart projection and rendering, UI validation, favorites, and interface persistence. Fixture tests run without a game installation; integration checks using the generated dataset are skipped when it is absent. Python tests cover prefab transforms and extraction rules; assembly-backed checks require `game_data/h3vr_Data/Managed/Assembly-CSharp.dll` and otherwise skip.

### Solve cost

The solve runs in a module Web Worker where the browser provides one, so a long calculation does not block the page; the elapsed time and which path ran are reported under the metrics. Without worker support it falls back to the same `solve()` entry point called inline, so results are identical either way.

Two things drive the cost, both under the user's control. Each range-card row is an independent aim solve, so a small table interval over a long range is the dominant term; consecutive rows are warm-started from the row below, which cuts a card from roughly 50 trajectory integrations per row to a couple. Separately, integration cost scales with `1/tick` while accuracy scales with `tick`, so the fixed-tick field has a real price. On this machine, a 1200 m shot with a 300-row card takes about 65 ms at the extracted 11.1 ms tick, 271 ms at 0.5 ms, and 1.3 s at 0.1 ms.

| Location | Purpose |
| --- | --- |
| `public/index.html`, `public/style.css`, `public/app.js` | Browser interface and interactions |
| `public/physics.js` | Projectile model, dispersion, solutions, and CSV generation |
| `public/solver-worker.js` | Off-main-thread solve host and its shared entry point |
| `public/trajectory-chart.js` | Sight-relative isometric SVG chart |
| `public/weapons.js`, `public/muzzle-devices.js` | Weapon presets, device search, and mounting geometry |
| `public/optics.js` | Optic search, direct mount matching, and bare-muzzle sight defaults |
| `public/favorites.js`, `public/interface-state.js` | Cookie validation and persistence |
| `tools/extract.py`, `tools/prefabs.py` | Local Unity data extraction and prefab interpretation |
| `server.mjs` | Static HTTP server |
| `test/` | JavaScript and Python tests |

Additional model notes:

- [Muzzle-device inventory and mounting rules](docs/muzzle-devices.md)
- [Horizontal-drift investigation](docs/horizontal-drift.md)
- [Launch dispersion and the projectile spawn offset](docs/dispersion.md)
- [Optic defaults and optical-origin extraction](docs/optics.md)
- [Weapon cant and fixed-dial uncertainty](docs/weapon-cant.md)

## Troubleshooting

- **Local data unavailable:** check that `public/data/h3vr.json` exists, run `npm run extract`, and reload the page.
- **Unverified game assembly:** the installation does not match the supported assembly. Verify the model before adding support for that version.
- **Dataset/model mismatch:** regenerate the dataset with the current extractor.
- **Missing preset or mounting values:** use Manual overrides and, where applicable, measured muzzle geometry. Unknown values are left blank.
- **Settings disappear after refreshing:** confirm cookie storage is enabled for this browser/site and check for storage errors in Saved setups & preferences.
