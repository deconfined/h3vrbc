"""Numeric prefab configuration, Unity transform geometry and verified shot rules."""
import math

from UnityPy.classes import PPtr
from dncil.cil.body import CilMethodBody
from dncil.cil.body.reader import CilMethodBodyReaderBytes

OPTIC_MOUNT_NAMES = {"Picatinny", "Russian", "RMR", "M16HandleMount", "MAS4956Scope",
                     "SVTScope", "M1GarandScope", "M1CarbineScope", "MP5RailMount", "PythonScopeMount"}


def ancestry(pe):
    types = {str(item.TypeName): item for item in pe.net.mdtables.TypeDef if str(item.TypeNamespace) == "FistVR"}
    result = {}
    for name, item in types.items():
        chain = []
        while item is not None and str(getattr(item, "TypeNamespace", "")) == "FistVR":
            chain.append(str(item.TypeName))
            item = item.Extends.row if item.Extends is not None else None
        result[name] = chain
    return types, result


# PIPScopeController.ZeroScaling selects the unit of the per-tick adjustment, from
# the scale factors UpdateScopeParams applies before storing the result in
# scopeAdjustmentDegrees. ZeroScaling 0 applies no factor, so the authored value is
# already in degrees. Mode 2 has no documented unit and is left unlabelled rather
# than guessed.
_ZERO_SCALING_UNITS = {0: "deg", 1: "MOA", 2: None, 3: "mrad"}
# Degrees per authored unit, from the same method.
_ZERO_SCALING_DEGREES = {0: 1.0, 1: 0.01666666753590107, 2: 0.05624999850988388,
                         3: 0.0572957806289196}


class Prefabs:
    def __init__(self, assets, pe, types, families, shot_cache):
        self.assets, self.pe, self.types, self.families = assets, pe, types, families
        self.shot_cache = shot_cache
        self.matrices = {}
        fire = next(entry.row for entry in types["FVRFireArm"].MethodList if str(entry.row.Name) == "Fire")
        self.fire_token = next(0x06000000 | i for i, method in enumerate(pe.net.mdtables.MethodDef, 1) if method is fire)

    def resolve(self, obj, pointer):
        if not pointer or not pointer["m_PathID"]:
            return None
        return PPtr(m_FileID=pointer["m_FileID"], m_PathID=pointer["m_PathID"], assetsfile=obj.assets_file).deref()

    def components(self, obj):
        for entry in obj.read_typetree()["m_Component"]:
            pointer = entry["component"] if isinstance(entry, dict) else entry[1]
            component = self.resolve(obj, pointer)
            if component is not None:
                yield component

    def transform(self, obj):
        if obj.type.name == "Transform":
            return obj
        if obj.type.name != "GameObject":
            obj = self.resolve(obj, self.assets.full(obj)["m_GameObject"])
        return next(item for item in self.components(obj) if item.type.name == "Transform")

    def matrix(self, transform):
        key = (transform.assets_file.name, transform.path_id)
        if key in self.matrices:
            return self.matrices[key]
        data = transform.read_typetree()
        q, p, s = data["m_LocalRotation"], data["m_LocalPosition"], data["m_LocalScale"]
        x, y, z, w = (q[key] for key in ("x", "y", "z", "w"))
        rotation = [[1 - 2*(y*y + z*z), 2*(x*y - z*w), 2*(x*z + y*w)],
                    [2*(x*y + z*w), 1 - 2*(x*x + z*z), 2*(y*z - x*w)],
                    [2*(x*z - y*w), 2*(y*z + x*w), 1 - 2*(x*x + y*y)]]
        axes = ("x", "y", "z")
        local = [[rotation[i][j]*s[axes[j]] for j in range(3)] + [p[axes[i]]] for i in range(3)] + [[0, 0, 0, 1]]
        parent = self.resolve(transform, data["m_Father"])
        if parent is not None:
            above = self.matrix(parent)
            local = [[sum(above[i][k]*local[k][j] for k in range(4)) for j in range(4)] for i in range(4)]
        self.matrices[key] = local
        return local

    def pose(self, obj):
        matrix = self.matrix(self.transform(obj))
        scale = [math.sqrt(sum(matrix[i][j]**2 for i in range(3))) for j in range(3)]
        if min(scale) <= 0:
            raise ValueError("Zero-scale prefab transform cannot provide geometry")
        return {"position": [matrix[i][3] for i in range(3)], "scale": scale,
                "forward": [matrix[i][2]/scale[2] for i in range(3)], "up": [matrix[i][1]/scale[1] for i in range(3)]}

    def game_name(self, obj):
        if obj.type.name != "GameObject":
            obj = self.resolve(obj, self.assets.full(obj)["m_GameObject"])
        return obj.read_typetree()["m_Name"]

    def source(self, obj):
        return {"file": obj.assets_file.name, "pathId": str(obj.path_id)}

    def identity(self, obj, data):
        wrapper = self.resolve(obj, data.get("ObjectWrapper"))
        return self.assets.full(wrapper)["ItemID"] if wrapper is not None else None

    def muzzle_mounts(self, obj, data):
        return self.attachment_mounts(obj, data, {2})

    def attachment_mounts(self, obj, data, allowed_types):
        result = []
        for pointer in data.get("AttachmentMounts", []):
            mount = self.resolve(obj, pointer)
            if mount is None:
                continue
            fields = self.assets.full(mount)
            if fields["Type"] not in allowed_types:
                continue
            front = self.resolve(mount, fields["Point_Front"])
            rear = self.resolve(mount, fields["Point_Rear"])
            parent = self.resolve(mount, fields["Parent"])
            result.append({"name": self.game_name(mount), "front": self.pose(front)["position"],
                            "rear": self.pose(rear)["position"], "pose": self.pose(mount),
                            "parentPose": self.pose(parent) if parent is not None else None, "parentToThis": bool(fields["ParentToThis"]),
                            "type": fields["Type"], "typeName": getattr(self, "mount_names", {}).get(fields["Type"]),
                            "scaleModifier": fields["ScaleModifier"], "source": self.source(mount)})
        return result

    def descendants(self, root):
        pending = [self.transform(root)]
        while pending:
            transform = pending.pop()
            fields = transform.read_typetree()
            yield from self.components(self.resolve(transform, fields["m_GameObject"]))
            pending.extend(self.resolve(transform, pointer) for pointer in fields["m_Children"])

    def relative_pose(self, root, pose):
        matrix = self.matrix(self.transform(root))
        root_pose = self.pose(root)
        axes = [[matrix[i][0]/root_pose["scale"][0] for i in range(3)], root_pose["up"], root_pose["forward"]]
        relative = [pose["position"][i] - root_pose["position"][i] for i in range(3)]
        return {"position": [sum(relative[i]*axis[i] for i in range(3))/root_pose["scale"][j] for j, axis in enumerate(axes)],
                "forward": [sum(pose["forward"][i]*axis[i] for i in range(3)) for axis in axes],
                "up": [sum(pose["up"][i]*axis[i] for i in range(3)) for axis in axes]}

    def optic(self, root, attachment, component, name):
        data = self.assets.full(component)
        result = {"componentClass": name, "kind": "scope" if name == "PIPScopeController" else "reflex",
                  "viewName": self.game_name(component), "rootPose": self.pose(root),
                  "mountType": attachment["Type"], "mountTypeName": self.mount_names[attachment["Type"]],
                  "canScaleToMount": bool(attachment["CanScaleToMount"]), "bidirectional": bool(attachment["IsBiDirectional"]),
                  "zeroDistances": data["ZeroDistanceValues"], "zeroDistanceIndex": data["ZeroDistanceIndex"],
                  "zeroModel": "game", "source": self.source(component)}
        values = data["ZeroDistanceValues"]
        index = data["ZeroDistanceIndex"]
        fallback = data["FixedBaseZero"] if name == "PIPScopeController" else 10.0  # Verified ReflexSightController ctor.
        default = values[index] if values and 0 <= index < len(values) else fallback if not values else None
        result["defaultZeroRange"] = default if default is not None and default > 0 else None
        # Player-facing tuning granularity. PIPScopeController.ZeroingMode
        # (ZeroScaling) selects the unit the magnitude is authored in: 1 is MOA,
        # 3 is mrad, and UpdateScopeParams converts with x1/60 or x(pi/180)
        # accordingly. The magnitude itself is an integer tick count, so one turn
        # of the adjustment component moves exactly AdjustmentPerTick of that
        # unit. Recorded per optic and in degrees, because the click size is a
        # property of the optic rather than a global constant.
        per_tick = {}
        if name == "PIPScopeController":
            # ZeroingMode 0 adjusts the scope, 1 the reticle; each has its own
            # per-tick size and they share ZeroScaling's unit.
            prefix = "Reticle" if data.get("ZeroingMode") == 1 else "Scope"
            scaling = data.get("ZeroScaling")
            degrees = _ZERO_SCALING_DEGREES.get(scaling)
            unit = _ZERO_SCALING_UNITS.get(scaling)
            for axis in ("elevation", "windage"):
                value = data.get(f"{prefix}{axis.capitalize()}AdjustmentPerTick")
                if isinstance(value, (int, float)) and value > 0:
                    per_tick[axis] = {"unit": unit, "perTick": value,
                                      "degrees": value * degrees if degrees else None}
        else:
            # ReflexSightController.Zero scales its reticle adjustment by 1/60.
            for axis, field in (("elevation", "ReticleElevationAdjustmentPerTick"),
                                ("windage", "ReticleWindageAdjustmentPerTick")):
                value = data.get(field)
                if isinstance(value, (int, float)) and value > 0:
                    per_tick[axis] = {"unit": "MOA", "perTick": value,
                                      "degrees": value * 0.01666666753590107}
        if per_tick:
            result["adjustmentTicks"] = per_tick
        if name == "PIPScopeController":
            result["fixedBaseZero"] = data["FixedBaseZero"]
            if data["FixedBaseZero"] <= 0:
                result["zeroModel"] = "unadjusted"
            scope = self.resolve(component, data["PScope"])
            fields = self.assets.full(scope)
            camera = self.resolve(scope, fields["scopeCamTransform"])
            pose = self.pose(camera)
            scope_pose = self.pose(scope)
            # ZeroToWorldPoint's forward-view origin is the camera intersection
            # plus the clamped rear-lens camera offset, not the renderer/lens.
            angle = math.degrees(math.acos(max(-1, min(1, sum(a*b for a, b in zip(pose["forward"], scope_pose["forward"]))))))
            if angle >= 1:
                result["geometryUnavailable"] = "Angled internal scope camera requires a separately verified optical origin."
            offset = max(0, min(fields["cameraOffsetRearLens"], fields["frontLensOffset"]))
            pose = {**pose, "position": [pose["position"][i] + pose["forward"][i]*offset for i in range(3)]}
            result["cameraOffsetRearLens"] = offset
            result["originRule"] = "PIP camera intersection + clamped rear-lens offset"
            magnifications = data["MagnificationValues"]
            mag_index = data["MagnificationIndex"]
            result["magnifications"] = magnifications
            result["defaultMagnification"] = (data["MagnificationOverride"] if data["MagnificationOverride"] > 0 else magnifications[mag_index]) if magnifications and 0 <= mag_index < len(magnifications) else fields["baseMagnification"]
            result["zeroingMode"] = data["ZeroingMode"]
        else:
            renderers = data["ReflexSightRenderers"]
            if not renderers:
                result["geometryUnavailable"] = "No serialized reflex renderer optical origin."
                return result
            pose = self.pose(self.resolve(component, renderers[0]))
            result["originRule"] = "First ReflexSightRenderer transform"
        result["opticalPose"] = self.relative_pose(root, pose)
        if any(data.get(key, {}).get("m_PathID") for key in ("OverrideMuzzle", "OverrideFireArm")):
            result["geometryUnavailable"] = "This sight uses a custom firearm/muzzle reference; direct-mount defaults are not verified."
        if any(data.get(key, 0) for key in ("ScopeElevationMagnitude", "ScopeWindageMagnitude", "ReticleElevationMagnitude", "ReticleWindageMagnitude", "Flipped")):
            result["geometryUnavailable"] = "Authored dial trim or folded state is outside the centered, zero-trim model."
        return result

    def optics(self, root):
        components = list(self.descendants(root))
        attachment = next((obj for obj in self.components(root) if "FVRFireArmAttachment" in self.families.get(self.assets.classname(obj), [])), None)
        if attachment is None:
            return []
        fields = self.assets.full(attachment)
        dynamic = any(self.assets.classname(obj) in {"Telescopescope", "Telescopescopev2"} for obj in components)
        result = []
        for component in components:
            name = self.assets.classname(component)
            if name not in {"PIPScopeController", "ReflexSightController"}:
                continue
            optic = self.optic(root, fields, component, name)
            if dynamic:
                optic["geometryUnavailable"] = "Extendable telescope geometry depends on its live extension."
            result.append(optic)
        return result

    def shot_rule(self, name, fields):
        for classname in self.families.get(name, []):
            if classname == "FVRFireArm":
                break
            if classname not in self.shot_cache:
                calls = []
                for entry in self.types[classname].MethodList:
                    method = entry.row
                    if not method.Rva:
                        continue
                    offset = self.pe.get_offset_from_rva(method.Rva)
                    instructions = CilMethodBody(CilMethodBodyReaderBytes(memoryview(self.pe.__data__)[offset:])).instructions
                    for i, ins in enumerate(instructions):
                        if ins.opcode.name not in ("call", "callvirt") or getattr(ins.operand, "value", None) != self.fire_token:
                            continue
                        literal = instructions[i-2].operand if i >= 2 and instructions[i-2].opcode.name == "ldc.r4" and instructions[i-1].opcode.name == "ldc.r4" else None
                        calls.append({"method": str(method.Name), "value": literal, "rva": method.Rva})
                self.shot_cache[classname] = calls
            calls = self.shot_cache[classname]
            if not calls:
                continue
            source = {"class": classname, "methods": sorted(set(call["method"] for call in calls))}
            values = {call["value"] for call in calls}
            if len(values) == 1 and None not in values:
                return {"kind": "constant", "value": values.pop(), "source": source}
            if classname == "ClosedBoltWeapon" and "UsesStickyDetonation" in fields:
                if not fields["UsesStickyDetonation"]:
                    return {"kind": "constant", "value": 1, "source": source}
                return {"kind": "sticky", "bonus": fields["StickyMaxMultBonus"], "source": source}
            return {"kind": "manual", "reason": "Caller uses dynamic or differing velMult arguments; inspect the active shot path.", "source": source}
        return {"kind": "manual", "reason": "No verified call to FVRFireArm.Fire in this component's inheritance chain."}

    def weapon(self, obj, data, name):
        sight_types = {key for key, value in getattr(self, "mount_names", {}).items() if value in OPTIC_MOUNT_NAMES or value.startswith("Scope_")}
        result = {"hashId": self.identity(obj, data), "accuracyClass": data["AccuracyClass"],
                  "componentClass": name, "shotRule": self.shot_rule(name, data), "chambers": [],
                  "sightMounts": self.attachment_mounts(obj, data, sight_types),
                  "muzzleMounts": self.muzzle_mounts(obj, data), "source": self.source(obj)}
        muzzle = self.resolve(obj, data["MuzzlePos"])
        result["muzzlePose"] = self.pose(muzzle) if muzzle is not None else None
        candidates = []
        if data.get("Chamber", {}).get("m_PathID"):
            candidates.append((data["Chamber"], muzzle))
        if data.get("UsesSecondChamber") and data.get("Chamber2", {}).get("m_PathID"):
            second_muzzle = self.resolve(obj, data.get("SecondMuzzle"))
            candidates.append((data["Chamber2"], second_muzzle))
        for barrel in data.get("Barrels", []):
            if barrel.get("Chamber", {}).get("m_PathID"):
                barrel_muzzle = self.resolve(obj, barrel.get("Muzzle", barrel.get("MuzzlePos"))) or muzzle
                candidates.append((barrel["Chamber"], barrel_muzzle))
        for pointer in data.get("Chambers", []):
            candidates.append((pointer, muzzle))
        cylinder = self.resolve(obj, data.get("Cylinder"))
        if cylinder is not None:
            for pointer in self.assets.full(cylinder).get("Chambers", []):
                chamber = self.resolve(cylinder, pointer)
                candidates.append((chamber, muzzle))
        if not candidates:
            root = self.resolve(obj, data["m_GameObject"])
            pending = [self.transform(root)]
            while pending:
                transform = pending.pop()
                fields = transform.read_typetree()
                go = self.resolve(transform, fields["m_GameObject"])
                for component in self.components(go):
                    if self.assets.classname(component) == "FVRFireArmChamber":
                        chamber_data = self.assets.full(component)
                        if chamber_data["RoundType"] == data["RoundType"]:
                            candidates.append((component, muzzle))
                pending.extend(self.resolve(transform, pointer) for pointer in fields["m_Children"])
        seen = set()
        for pointer, actual_muzzle in candidates:
            chamber = self.resolve(obj, pointer) if isinstance(pointer, dict) else pointer
            key = (chamber.assets_file.name, chamber.path_id)
            if key in seen:
                continue
            seen.add(key)
            fields = self.assets.full(chamber)
            position = self.pose(chamber)["position"]
            length = math.dist(position, self.pose(actual_muzzle)["position"]) if actual_muzzle is not None else None
            result["chambers"].append({"name": self.game_name(chamber), "multiplier": fields["ChamberVelocityMultiplier"],
                                       "caliberId": fields["RoundType"], "barrelLength": length, "position": position,
                                       "muzzlePose": self.pose(actual_muzzle) if actual_muzzle is not None else None,
                                       "source": self.source(chamber)})
        if not result["chambers"]:
            result["presetUnavailable"] = "No serialized chamber found; inspect the live firearm's chamber reference."
        return result

    def device(self, obj, data, name):
        muzzle = self.resolve(obj, data["Muzzle"])
        root_pose = self.pose(obj)
        muzzle_pose = self.pose(muzzle)
        root_matrix = self.matrix(self.transform(obj))
        relative = [muzzle_pose["position"][i] - root_pose["position"][i] for i in range(3)]
        # All certified automatic composition uses unit-scale orthogonal roots.
        root_right = [root_matrix[i][0]/root_pose["scale"][0] for i in range(3)]
        axes = [root_right, root_pose["up"], root_pose["forward"]]
        offset = [sum(relative[i]*axis[i] for i in range(3)) for axis in axes]
        interface = self.resolve(obj, data.get("AttachmentInterface"))
        interface_fields = self.assets.full(interface) if interface is not None else {}
        inherited_mounts = {pointer["m_PathID"] for pointer in interface_fields.get("SubMounts", [])}
        mounts = self.muzzle_mounts(obj, data)
        for mount in mounts:
            # OnAttach reparents these submounts to the root mount's Parent.
            mount["followsRootParent"] = int(mount["source"]["pathId"]) in inherited_mounts
        return {"hashId": self.identity(obj, data), "accuracyClass": data["MechanicalAccuracy"],
                "kind": "suppressor" if "Suppressor" in self.families[name] else "brake" if "MuzzleBrake" in self.families[name] else "device",
                "componentClass": name, "muzzleOffset": offset, "rootScale": root_pose["scale"], "rootPose": root_pose,
                "muzzleForward": [sum(muzzle_pose["forward"][i]*axis[i] for i in range(3)) for axis in axes],
                "muzzleUp": [sum(muzzle_pose["up"][i]*axis[i] for i in range(3)) for axis in axes],
                "canScaleToMount": bool(data["CanScaleToMount"]), "bidirectional": bool(data["IsBiDirectional"]),
                "interfaceClass": self.assets.classname(interface) if interface is not None else None,
                "muzzleMounts": mounts, "source": self.source(obj)}
