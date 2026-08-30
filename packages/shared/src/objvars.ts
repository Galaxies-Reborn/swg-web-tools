/**
 * Object variable (objvar) decoding.
 *
 * Objvars are the game's per-object key/value store and carry almost every
 * gameplay fact the fixed columns do not: vendor configuration, house names,
 * structure maintenance pools, harvester settings, quest state. The first 20
 * live inline on `objects` (objvar_N_name/type/value); the rest overflow into
 * `object_variables`.
 *
 * Packing is defined by DynamicVariable::pack in sharedFoundation. Scalars are
 * plain text; arrays are colon-terminated lists; string elements escape `:` and
 * `\`. Nothing is length-prefixed, so an empty array and an absent value look
 * identical — both decode to `[]`.
 */

/** Values mirror `DynamicVariable::DynamicVariableType`, declaration order. */
export enum ObjVarType {
  Int = 0,
  IntArray = 1,
  Real = 2,
  RealArray = 3,
  String = 4,
  StringArray = 5,
  NetworkId = 6,
  NetworkIdArray = 7,
  Location = 8,
  LocationArray = 9,
  List = 10,
  StringId = 11,
  StringIdArray = 12,
  Transform = 13,
  TransformArray = 14,
  Vector = 15,
  VectorArray = 16,
}

export interface ObjVarLocation {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly scene: string;
  /** Cell object id, or `0` when the location is outdoors. */
  readonly cell: string;
}

export type ObjVarValue =
  | number
  | string
  | readonly number[]
  | readonly string[]
  | ObjVarLocation
  | readonly ObjVarLocation[]
  | null;

export interface ObjVar {
  readonly name: string;
  readonly type: ObjVarType;
  readonly raw: string;
  readonly value: ObjVarValue;
}

/** Split a colon-terminated packed list, honouring `\:` and `\\` escapes. */
function splitPacked(raw: string): string[] {
  const out: string[] = [];
  let current = '';
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch === '\\' && i + 1 < raw.length) {
      current += raw[i + 1];
      i += 1;
    } else if (ch === ':') {
      out.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  // A trailing fragment means the writer omitted the final separator; keep it.
  if (current.length > 0) out.push(current);
  return out;
}

function parseLocation(raw: string): ObjVarLocation | null {
  // "%f %f %f %s %s" — x y z scene cell
  const parts = raw.trim().split(/\s+/);
  if (parts.length < 5) return null;
  const [x, y, z, scene, cell] = parts;
  return {
    x: Number.parseFloat(x as string),
    y: Number.parseFloat(y as string),
    z: Number.parseFloat(z as string),
    scene: scene as string,
    cell: cell as string,
  };
}

export function decodeObjVarValue(type: ObjVarType, raw: string): ObjVarValue {
  switch (type) {
    case ObjVarType.Int:
      return Number.parseInt(raw, 10);
    case ObjVarType.Real:
      return Number.parseFloat(raw);
    case ObjVarType.IntArray:
      return splitPacked(raw).map((v) => Number.parseInt(v, 10));
    case ObjVarType.RealArray:
      return splitPacked(raw).map((v) => Number.parseFloat(v));
    // NetworkIds are 64-bit; keeping them as strings avoids precision loss.
    case ObjVarType.String:
    case ObjVarType.NetworkId:
    case ObjVarType.StringId:
      return raw;
    case ObjVarType.StringArray:
    case ObjVarType.NetworkIdArray:
    case ObjVarType.StringIdArray:
      return splitPacked(raw);
    case ObjVarType.Location:
      return parseLocation(raw);
    case ObjVarType.LocationArray:
      return splitPacked(raw)
        .map(parseLocation)
        .filter((l): l is ObjVarLocation => l !== null);
    // A LIST objvar is a namespace marker — its children are separate rows
    // named `parent.child`, and it carries no value of its own.
    case ObjVarType.List:
      return null;
    default:
      // Transforms and vectors are rare on persisted objects and only ever
      // displayed verbatim, so they pass through unparsed.
      return raw;
  }
}

export function decodeObjVar(name: string, type: number, raw: string | null): ObjVar {
  const value = raw === null ? null : decodeObjVarValue(type as ObjVarType, raw);
  return { name, type: type as ObjVarType, raw: raw ?? '', value };
}

/**
 * Group flat objvars into the nested shape scripts see, splitting on `.`.
 * `vendor.setup.name` becomes `{ vendor: { setup: { name: … } } }`.
 */
export function nestObjVars(vars: readonly ObjVar[]): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  for (const v of vars) {
    if (v.type === ObjVarType.List) continue;
    const path = v.name.split('.');
    let cursor = root;
    for (let i = 0; i < path.length - 1; i += 1) {
      const key = path[i] as string;
      const existing = cursor[key];
      if (typeof existing !== 'object' || existing === null || Array.isArray(existing)) {
        cursor[key] = {};
      }
      cursor = cursor[key] as Record<string, unknown>;
    }
    cursor[path[path.length - 1] as string] = v.value;
  }
  return root;
}

export function findObjVar(vars: readonly ObjVar[], name: string): ObjVar | undefined {
  return vars.find((v) => v.name === name);
}

export function objVarNumber(vars: readonly ObjVar[], name: string): number | undefined {
  const v = findObjVar(vars, name)?.value;
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

export function objVarString(vars: readonly ObjVar[], name: string): string | undefined {
  const v = findObjVar(vars, name)?.value;
  return typeof v === 'string' ? v : undefined;
}
