import type { z } from "zod";
import { ChemicalStructureNodeSchema } from "../document/model.js";

export const ChemicalStructureSourceSchema = ChemicalStructureNodeSchema.pick({
  ketSource: true,
  editorMode: true,
});
export type ChemicalStructureSource = z.infer<typeof ChemicalStructureSourceSchema>;
