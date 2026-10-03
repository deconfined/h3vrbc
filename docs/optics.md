# Optic defaults — H3VR 120p3

Source: local game assembly SHA-256 `033e275871f798eeab5d6cdf0c7ace348cdff2acf9588b1a6c1a46805f20a76b`. Only numeric parameters, identifiers and provenance are exported; no models, textures or game code are published.

## Inventory

All **378 catalogued attachment prefabs across eight bundles** were examined recursively for optical controllers. The inventory contains **81 attachments / 83 sight views**: **57 `PIPScopeController` views** and **26 `ReflexSightController` views**. No exported attachment in this inventory used legacy `HoloSight` or `RedDotSight` controllers. Integrated firearm sights are outside this attachment inventory.

`ScopeHAMComboScope4x24` and `ScopeG36Combo` each have two views. Views have separate IDs incorporating the attachment ID and controller path ID. Each retains its bundle, asset name, serialized file and path ID in `public/data/h3vr.json`.

The dataset records the mounting type, source root pose, root-relative optical pose, scaling/reversible-mount flags, authored zero distances and index, default zero rule/range, PIP magnification parameters and camera offset. Weapons provide **599 direct sight mounts**, with typed front/rear endpoints, mounting orientation/parent and scale modifier. Each chamber now records its corresponding bare muzzle pose.

## Why height/setback cannot be scope-only constants

The scope contributes an optical origin relative to its attachment root. The weapon contributes the mount position/orientation and bare muzzle. A rail contributes a choice of mounting position.

- Sliding mounts default to **50%**, the explicitly assumed midpoint of `Point_Rear` and `Point_Front`. Users can adjust from 0% rear to 100% front. This is an application default, not a serialized live attachment position.
- Point mounts use their fixed position.
- Multiple same-type direct mounts require an explicit selection; the app does not arbitrarily choose between top, bottom and side rails.
- Mount-type equality supplies candidates, not collision/occupancy or adapter compatibility.
- The default attachment orientation is **forward-facing**. Although 80 of the 83 views belong to reversible attachments, the actual orientation is not inferable from an unattached prefab.

At the chosen rail position, the attachment root is aligned with the mount and its optical origin is composed using the verified scale rule. From that position, the app computes:

```text
sight height = dot(optical origin − bare muzzle, muzzle up)
optic setback = −dot(optical origin − bare muzzle, muzzle forward)
```

Positive setback means behind the bare muzzle. The selected chamber's muzzle is used, including for multi-barrel weapons. Muzzle devices are applied afterward: their forward displacement adds to effective setback, and their upward displacement subtracts from effective sight height. The bare values are never destructively rewritten when changing muzzle devices.

## Verified optical origins and zero defaults

| Method | RVA | Behavior used |
| --- | ---: | --- |
| `FVRFireArmAttachment.AttachToMount` | 943764 | Aligns attachment root to the mounting frame; snaps its position onto the front/rear segment; allows reversed orientation. |
| `FVRFireArmAttachment.ScaleToMount` | 943072 | Sets uniform attachment-local scale from the root mount's `ScaleModifier`. |
| `PIPScopeController.UpdateScopeParams` | 509936 | Chooses the indexed zero distance, falling back to `FixedBaseZero` for an empty list; disables base adjustment when `FixedBaseZero ≤ 0`. |
| `PIPScope.ZeroToWorldPoint` | 492360 | Uses camera intersection plus clamped rear-lens camera offset as the forward-view zeroing origin. |
| `PIPScope.GetCameraIntersectionPoint` | 488032 | For camera/scope axes less than 1° apart, the forward-view intersection is the camera position. Angled internals are not auto-certified. |
| `PIPScope.GetCameraOffset` | 488348 | Forward-view offset is `max(0, min(cameraOffsetRearLens, frontLensOffset))`, applied along camera forward in world metres. |
| `ReflexSightController.Zero` | 524164 | Uses the first `ReflexSightRenderer` transform as the local origin. Empty zero lists use the verified constructor fallback of 10 m. |

The PIP camera offset is important: it is **not necessarily zero**, and its scalar world-metre displacement does **not** scale with the attachment. The camera's position relative to the attachment root does scale.

Examples below show **attachment-root-relative** optical offsets, not bare-muzzle values. Forward offset is positive forward; these are rounded for readability.

| Attachment ID | Optical height above root, cm | Optical forward offset, cm | Default zero |
| --- | ---: | ---: | --- |
| `ScopeAcog4x32` | 3.899 | −8.750 | 100 m |
| `ScopeClassic3-12x42mm` | 2.696 | +6.050 | 100 m |
| `ScopeEVU110x28mm` | 3.910 | +3.735 | 50 m |
| `ReflexCom4` | 3.834 | +4.830 | 10 m |
| `ScopePVS14` | 4.350 | −12.075 | No base adjustment |
| `ScopePNV57E` | 4.340 | −1.748 | No base adjustment |
| `ScopePVS30` | 3.800 | −8.723 | No base adjustment |

For example, Classic 3–12×42 has a camera roughly 10.450 cm behind its root, but the 16.500 cm rear-lens offset puts the game's optical origin roughly **6.050 cm ahead** of that root. Using the camera transform alone would give the wrong setback.

The full numeric inventory is the dataset's `optics` array. Positive authored zero distances appear as input suggestions. A zero-disabled optic selects the unadjusted rule and retains the current positive range input rather than writing an invalid zero. Magnification is extracted as provenance, not an additional trajectory input.

## Example composed bare-muzzle defaults

| Weapon / optic | Mount assumption | Sight height, cm | Optic setback, cm | Default zero |
| --- | --- | ---: | ---: | ---: |
| M4 Carbine / ACOG 4×32 | Top rail midpoint | 6.989 | 56.565 | 100 m |
| M4 Carbine / Classic 3–12×42 | Top rail midpoint | 5.786 | 41.765 | 100 m |
| MRAD / VRZ 6–36×56 Black | Top rail midpoint | 7.493 | 65.900 | 100 m |
| M16A1 / ACOS TA31 HandleMount | Fixed carry-handle mount | 9.273 | 69.485 | 100 m |

## Explicit limitations

Automatic defaults require an orthogonal source frame, unit-scale source root/mounting parent, known scaling rules, centered optical origin and an uncanted/bore-aligned forward orientation. No lateral optical offset is silently discarded.

These mounting restrictions are relative to the weapon. Rolling the whole weapon/optic setup is a separate [weapon cant input](weapon-cant.md) and does not change its intrinsic mount geometry.

- The G36 combo's reflex view has a custom muzzle reference; its direct-mount geometry is not auto-certified. Its PIP scope view is separate.
- Extendable `Telescopescope` needs its live extension; the serialized collapsed pose is not an assumed operational default.
- Side-offset scopes, reversed/folded/canted mounting, below-bore optical origins, angled internal cameras and unknown/scaled parent geometry are not automatically applied.
- Adapters, risers and linked magnifier/clip-on optics are not composed. A single attachment's optical origin does not describe a linked optical chain.
- Weapon animation state, occupied mounts and mesh collisions are not evaluated. This remains source-derived stock geometry, not live-VR validation.

Unavailable geometry clears the height/setback inputs and shows a reason. Manual values are still possible where the centered calculator model is appropriate. Changing an optic's zero setting or geometry invalidates the calculation and CSV; browsing the inventory does not. Opt-in interface cookies remember the view, mount, rail position and manual overrides. Named favorites save the optic/view, mount, rail position and zero rule/distance alongside weapon/chamber, ammunition and ordered muzzle devices. Loading re-derives supported sight geometry and restores the saved zero rather than the prefab default; manual geometry overrides and target range remain outside named favorites. Older favorites without optical settings remain loadable without replacing the current optic or zero setting.

## Reproduction and checks

```sh
npm run extract
npm test
npm run test:extract
```

JavaScript tests cover default midpoint/endpoints, fixed and typed mounts, PIP scaling, selected-barrel coordinates, unsupported-geometry rejection, actual M4/ACOG defaults, UI overrides, search, CSV and refresh persistence. Python tests cover camera-offset clamping, root-relative transforms, zero defaults, renderer origins, typed mount extraction and the string-array type-tree correction needed to read optic-controller display-name lists.
