import { findCarryableEntry, findNpcCatalogEntry, npcSpriteCrop, type NpcSpriteCrop } from '@69-seconds/shared';

/**
 * One carryable's artwork, in a square box, wherever the DOM shows loot or a
 * person: the carry HUD and the final tally. Item art is drawn as-is; a person
 * is positioned from their catalog crop, because the source portraits are large
 * canvases with the figure somewhere inside a wide transparent margin.
 *
 * An unillustrated or unrecognized id falls back to a coloured `?` chip rather
 * than an empty box, so a mid-deploy catalog disagreement is visible and
 * harmless instead of blank.
 */
export function CarryableArt({ imageUrl, crop, color, label, className }: {
  imageUrl: string | null;
  crop: NpcSpriteCrop | null;
  color: string;
  label: string;
  className: string;
}) {
  if (!imageUrl) {
    return <b className={`${className} is-placeholder`} style={{ backgroundColor: color }} title={label}>?</b>;
  }
  if (!crop) return <img className={className} src={imageUrl} alt="" title={label} />;
  return <span className={`${className} is-portrait`} title={label}>
    <img
      src={imageUrl}
      alt=""
      style={{
        width: `${crop.widthPercent}%`,
        height: `${crop.heightPercent}%`,
        left: `${crop.leftPercent}%`,
        top: `${crop.topPercent}%`,
      }}
    />
  </span>;
}

/** The same art, resolved from a catalog id alone, for views that only carry ids. */
export function CarryableArtById({ catalogId, label, className }: {
  catalogId: string;
  label: string;
  className: string;
}) {
  const entry = findCarryableEntry(catalogId);
  const npc = entry?.isNpc ? findNpcCatalogEntry(catalogId) : undefined;
  return <CarryableArt
    imageUrl={entry?.imageUrl ?? null}
    crop={npc ? npcSpriteCrop(npc) : null}
    color={`#${(entry?.color ?? 0x7a8b99).toString(16).padStart(6, '0')}`}
    label={label}
    className={className}
  />;
}
