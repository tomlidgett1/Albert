import type { CubeCatalogueView } from "@/packages/albert-v3/src/cube/types";

/** Every visible field of the governed view, shared by every element type. */
export function dashboardElementFields(view: CubeCatalogueView) {
  return view.members
    .filter(member => !member.aiHidden && (member.kind === "measure" || member.kind === "dimension"))
    .map(member => ({
      name: member.name,
      kind: member.kind,
      title: member.title,
      shortTitle: member.shortTitle,
      ...(member.type ? { type: member.type } : {}),
      ...(member.folder ? { folder: member.folder } : {}),
      ...(member.description ? { description: member.description } : {}),
    }));
}
