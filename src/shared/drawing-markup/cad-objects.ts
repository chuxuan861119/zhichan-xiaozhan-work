import { z } from "zod";

const Handles = z.array(z.string().regex(/^[\dA-F]+$/iu)).max(100_000);
export const CadAppearancePatchSchema = z
  .object({
    color: z
      .string()
      .regex(/^#[\da-f]{6}$/i)
      .optional(),
    lineweight: z.number().finite().min(0).max(2.11).optional(),
    linetype: z.string().min(1).max(255).optional(),
    lineWidthAtEdit: z.number().finite().nonnegative().optional(),
  })
  .strict();
export type CadAppearancePatch = z.infer<typeof CadAppearancePatchSchema>;
export const CadPatentObjectSchema = z
  .object({
    id: z.string().min(1).max(100),
    kind: z.enum(["label", "detail"]),
    label: Handles.optional(),
    body: Handles.optional(),
    frame: Handles.optional(),
    source: Handles.optional(),
    appearance: z
      .object({
        label: CadAppearancePatchSchema.optional(),
        frame: CadAppearancePatchSchema.optional(),
        source: CadAppearancePatchSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type CadPatentObject = z.infer<typeof CadPatentObjectSchema>;
export type CadObjectRole = "label" | "body" | "frame" | "source";
export type CadObjectOwner = { id: string; kind: "label" | "detail"; role: CadObjectRole };
export const cadObjectHandles = (object: CadPatentObject) =>
  [object.label, object.body, object.frame, object.source].flatMap((handles) => handles ?? []);
export function cadObjectGroup(owner: CadObjectOwner) {
  let key = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(owner.id))
    key = BigInt.asUintN(64, (key ^ BigInt(byte)) * 0x100000001b3n);
  const token = key.toString(16).padStart(16, "0");
  return owner.kind === "label"
    ? `PW_LABEL_${token}`
    : `PW_DETAIL_${token}_${owner.role.toUpperCase()}`;
}
export function patentObjectAtHandle(objects: CadPatentObject[], handle: string) {
  for (const object of objects) {
    for (const role of ["label", "body", "frame", "source"] as const)
      if (object[role]?.includes(handle)) return { object, role };
  }
  return null;
}
/** Derived text/leader handles change after a save; object identity does not. */
export function remapPatentHandles(
  before: CadPatentObject[],
  after: CadPatentObject[],
  handles: string[],
  present: Set<string>,
) {
  return [
    ...new Set(
      handles.flatMap((handle) => {
        const owner = patentObjectAtHandle(before, handle);
        if (!owner) return present.has(handle) ? [handle] : [];
        const replacement = after.find(
          (o) => o.id === owner.object.id && o.kind === owner.object.kind,
        );
        if (!replacement) return [];
        if (owner.role === "body" && present.has(handle)) return [handle];
        return (replacement[owner.role] ?? []).filter((h) => present.has(h));
      }),
    ),
  ];
}
