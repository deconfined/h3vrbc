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
4. **Sight & range:** choose an optic preset and a matching direct weapon mount to fill sight geometry and the authored default zero setting, or enter values manually. Sliding rails default to an **assumed midpoint (50%)**, adjustable from rear (0%) to front (100%). Sight height and setback describe the **bare weapon muzzle**; device geometry supplies the effective adjustment. Set firing angle, target range, and range-card interval.
5. **Manual overrides:** supply missing values or adjust geometry and velocity multipliers for your setup.

Click **Calculate solution** after changing the firing setup. Changes invalidate the previous solution and CSV export. Browsing weapon or device candidates and opening or closing sections preserve the current calculation.

The chart shows vertical trajectory. The target summary, range card, and **Export CSV** include lateral point of impact and windage. Positive elevation means raise aim; positive windage means aim right. Positive lateral point of impact means the projectile is right of the aim point.

For unverified mounting, choose measured muzzle geometry, enter the mounted distance and forward/up shifts, and confirm them before calculating. Selecting a device does not establish physical compatibility with the weapon.

### Optic defaults

The extractor includes **81 optical attachments / 83 sight views** (57 PIP scope views and 26 reflex views), plus direct weapon-mount geometry. Combo scopes expose their scope and reflex views separately. Regenerate older datasets with `npm run extract` to populate the selector.

Choose a weapon, optic and direct mount. A unique matching mount is selected automatically; multiple matching mounts require a choice. Rail position starts at 50%, explicitly assuming the midpoint rather than a measured in-game pose. Changing the weapon, chamber, optic, mount or rail position recalculates the default bare-muzzle height/setback. **Restore optic defaults** restores geometry and the authored zero rule/setting while keeping the chosen rail position. Geometry and zero inputs remain editable, and searching preserves the selected optic and current calculation.

PIP geometry uses the game's optical origin, including its clamped rear-lens camera offset, rather than guessing from the mesh or lens. Reflex geometry uses the first reticle renderer's transform. PIP optics with disabled base zero select **No base zero adjustment** without forcing the required range input to zero. Positive authored zero distances are suggested in the zero-setting input.

Defaults assume forward-facing, uncanted, centered **direct** mounting with no dial trim. Unsupported/off-axis geometry, missing direct mounts, custom muzzle references and extendable telescope geometry leave height/setback blank with an explanation. Adapters, risers, magnifier/clip-on combinations, occupied mounts, physical collisions and live animation poses are not composed or verified. Manual geometry remains available where the centered model is appropriate.

For example, **M4 Carbine + Scope ACOG 4×32** at the top rail midpoint gives approximately **6.989 cm sight height** and **56.565 cm optic setback**, with a default **100 m** optic setting. These are source-derived defaults, not real-firearm measurements or a live-VR validation. See [optic extraction and geometry notes](docs/optics.md).

## Cookies, favorites, and refresh persistence

Storage is **off by default**. In **Saved setups & preferences**, explicitly enable **Allow cookies to remember my interface and favorite setups** to use browser persistence. The app uses no account or external API.

With storage enabled:

- **Named favorites** save the weapon, selected chamber, ordered muzzle devices, and round. Sight, range, and manual overrides are outside the named favorite. You can save, load, rename an identical combination by saving it again, or delete a favorite.
- **The active interface** is saved automatically, including calculation inputs, optic/view and direct-mount selections, rail position, manual overrides and geometry confirmation, searches and filters, favorite controls, open sections, and page/sidebar/range-table scroll positions.
- **Refreshing** restores the interface. A current calculated solution is recomputed from its restored inputs; unfinished edits remain pending until you calculate.

Loading a named favorite reapplies its weapon/loadout configuration and invalidates the current solution. Measured mounting geometry needs fresh verification when loading a favorite. Refreshing the active interface restores its existing measurements and confirmation.

The cookies are `h3vrbc_favorites` and `h3vrbc_interface`, each with a lifetime of up to one year. They are specific to the browser and site hostname and do not synchronize across devices. Turning the opt-in off deletes both cookies and cancels pending saves, while keeping the currently displayed setup intact. Clearing the site's cookies also removes the saved data.

Cookie storage is limited. If the browser blocks a write or the saved data exceeds the limit, the app reports that it could not save; oversized writes retain the previous saved data. Saved setups referencing unavailable game data are not applied.

## Model scope

The model reproduces the inspected free-flight update, including gravity before drag, the game's Mach-dependent drag curve, single-precision state updates, caliber velocity curves, optic zeroing rules, and fixed muzzle-device launch bias.

Modern PIP scope/reflex zeroing uses the caliber's authored drop curve. The nominal optic distance does not force the selected projectile through the sight line at that range. **Calculated zero** separately solves a crossing for the chosen projectile and setup.

Results assume a centered, uncanted optic with no dial trim. The model does not simulate impacts, penetration, ricochets, random spread, wind, Coriolis, spin drift, guided projectiles, or modded behavior. Multi-projectile rounds show one centerline projectile; submunition paths are excluded. Unsupported projectile integrators appear in the unavailable-projectile list.

Stock geometry reflects authored prefab poses, rather than live animations. The model is source-derived and has not yet been validated against live VR shots; timing, scene settings, and mounting geometry can affect agreement.

## Development and tests

```sh
npm test
npm run test:extract
```

The JavaScript suite covers physics, weapon/device behavior, UI validation, favorites, and interface persistence. Fixture tests run without a game installation; integration checks using the generated dataset are skipped when it is absent. Python tests cover prefab transforms and extraction rules; assembly-backed checks require `game_data/h3vr_Data/Managed/Assembly-CSharp.dll` and otherwise skip.

| Location | Purpose |
| --- | --- |
| `public/index.html`, `public/style.css`, `public/app.js` | Browser interface and interactions |
| `public/physics.js` | Projectile model, solutions, and CSV generation |
| `public/weapons.js`, `public/muzzle-devices.js` | Weapon presets, device search, and mounting geometry |
| `public/optics.js` | Optic search, direct mount matching, and bare-muzzle sight defaults |
| `public/favorites.js`, `public/interface-state.js` | Cookie validation and persistence |
| `tools/extract.py`, `tools/prefabs.py` | Local Unity data extraction and prefab interpretation |
| `server.mjs` | Static HTTP server |
| `test/` | JavaScript and Python tests |

Additional model notes:

- [Muzzle-device inventory and mounting rules](docs/muzzle-devices.md)
- [Horizontal-drift investigation](docs/horizontal-drift.md)
- [Optic defaults and optical-origin extraction](docs/optics.md)

## Troubleshooting

- **Local data unavailable:** check that `public/data/h3vr.json` exists, run `npm run extract`, and reload the page.
- **Unverified game assembly:** the installation does not match the supported assembly. Verify the model before adding support for that version.
- **Dataset/model mismatch:** regenerate the dataset with the current extractor.
- **Missing preset or mounting values:** use Manual overrides and, where applicable, measured muzzle geometry. Unknown values are left blank.
- **Settings disappear after refreshing:** confirm cookie storage is enabled for this browser/site and check for storage errors in Saved setups & preferences.
