/**
 * Whether a Commons file is a photograph of the ground a trail crosses. Geosearch answers "what
 * carries coordinates near here", which is a different question — a knitted cowl photographed in a
 * house 400 m from a path is a valid geosearch hit and a nonsense trail photograph.
 */

/**
 * What Commons tells us about one file. `categories` is the load-bearing field: it is what Commons
 * files the image *as*, where the credit only says who took it.
 */
export interface PhotoSubject {
  /** The file page title, e.g. `File:Ruisseau du Castran @ Frangy.jpg`. */
  title: string;
  description?: string | null;
  attribution?: string | null;
  categories?: readonly string[];
}

/**
 * Imagery of the ground from above, and media that is not a photograph of a place.
 *
 * Category-driven rather than credit-driven, because the operator list is unbounded and the
 * category vocabulary is not: Commons files an astronaut frame under `ISS Expedition NN Crew Earth
 * Observations` and a satellite scene under `Satellite pictures of <place>` whoever owns the
 * spacecraft. A credit-only test kept Axelspace, Planet Labs, Maxar, Airbus and `European Space
 * Agency` spelled out.
 */
const FROM_ABOVE = new RegExp(
  [
    'satellite (?:picture|image|photo|view)',
    'crew earth observations',
    'viewed from space',
    'photos? from space',
    'astronaut photograph',
    'aerial (?:photograph|view|image)',
    'orthophoto',
    'elevation model',
    'topographic map',
    'maps? of',
    'diagram',
    'floor plan',
  ].join('|'),
  'i',
);

/** Operators whose own name in a credit settles it, as defence behind the category test. */
const ORBITAL_OPERATOR =
  /(?<![\p{L}\p{N}])(?:NASA|ESA|JAXA|MODIS|ISRO|Roscosmos|Axelspace|Planet Labs|Maxar|DigitalGlobe|Airbus Defence|European Space Agency|USGS EROS|Copernicus|Landsat|Sentinel-\d)(?![\p{L}\p{N}])/u;

/**
 * Landforms, water, vegetation and the outdoor settings a trail runs through.
 *
 * A whitelist rather than a blacklist, and that is the whole design. The things photographed near
 * a trail that are not the trail — knitwear, a prison, road signs, fireworks, a bell foundry, a
 * lipoma — are unbounded, so no reject-list finishes. Landforms are a closed vocabulary.
 *
 * `alp` is deliberately absent: it matches the French region `Auvergne-Rhône-Alpes`, which let
 * three photographs of a viper through. `chemin` and `path` are absent for the same reason —
 * they name streets far more often than footpaths.
 */
const OUTDOOR_TERMS = [
  'mountain',
  'mount',
  'mont',
  'monte',
  'peak',
  'summit',
  'pinnacle',
  'hill',
  'ridge',
  'crest',
  'cliff',
  'crag',
  'boulder',
  'col',
  'pass',
  'saddle',
  'plateau',
  'massif',
  'aiguille',
  'cime',
  'glacier',
  'snow',
  'lake',
  'lac',
  'lago',
  'loch',
  'tarn',
  'pond',
  'reservoir',
  'river',
  'rivière',
  'riviere',
  'stream',
  'creek',
  'brook',
  'torrent',
  'ruisseau',
  'waterfall',
  'cascade',
  'gorge',
  'canyon',
  'ravine',
  'valley',
  'vallée',
  'vallee',
  'valle',
  'glen',
  'combe',
  'forest',
  'forêt',
  'foret',
  'wood',
  'woodland',
  'tree',
  'meadow',
  'pasture',
  'alpine',
  'moor',
  'heath',
  'marsh',
  'wetland',
  'bog',
  'fen',
  'desert',
  'dune',
  'beach',
  'coast',
  'shore',
  'island',
  'bay',
  'fjord',
  'cape',
  'trail',
  'footpath',
  'sentier',
  'gué',
  'hiking',
  'trekking',
  'walking',
  'climbing',
  'mountaineering',
  'park',
  'reserve',
  'wilderness',
  'nature',
  'landscape',
  'panorama',
  'scenery',
  'viewpoint',
  'countryside',
  'plage',
  'sommet',
];
const OUTDOOR = new RegExp(`\\b(?:${OUTDOOR_TERMS.join('|')})(?:s|es)?\\b`, 'i');

/**
 * The shapes Commons gives a taxon category. `Genus species` is only one of them, and matching it
 * alone let a flowering tree filed under `Koelreuteria` / `Unidentified Sapindaceae` and a wallflower
 * under `Erysimum (flowers)` reach two trail galleries as their only photograph.
 *
 * The Latin suffixes are the reliable half: a family or order name ends in one of them and a place
 * name does not. A bare single-word genus — `Koelreuteria`, `Haliaeetus` — is *not* matched here,
 * because nothing in the string separates it from a commune like `Frangy`; those are caught by a
 * sibling category or not at all.
 */
const TAXON_SHAPES: readonly RegExp[] = [
  /^unidentified\b/i,
  /\b\w{4,}(?:aceae|idae|inae|ales|oideae)\b/i,
  /^[A-Z][a-z]+ (?:×\s*)?[a-z-]+(?: \(.+\))?$/,
  // The parenthetical must name a plant part, not a disambiguator: `Bonnevaux (Doubs)` and
  // `Missionpeak (cropped)` are a commune and a crop, and accepting any bracket dropped both.
  /^[A-Z][a-z]+ \((?:flowers?|plants?|fruits?|leaves|seeds?|insects?|birds?)\)$/i,
];

/**
 * The noun Commons leads a wildlife category with, for an animal whose species category is
 * qualified out of every shape above — a coyote filed under `Canis latrans in California`.
 */
const WILDLIFE =
  /^(?:animals|fauna|flora|birds|mammals|reptiles|amphibians|insects|arachnids|fungi|lichens|mosses)\b/i;

/** Commons files a portrait under the people in it. */
const PEOPLE =
  /^(?:husbands and wives|pioneers of|mountaineers from|portraits of|people of|men of|women of|children of|families)/i;

/**
 * Subjects a photograph is *of* rather than a place it was taken in, matched against the file name
 * only.
 *
 * The name is the uploader's own statement of subject, and it is the one field where these words
 * are decisive: `Fleur @ Mieussy` is a flower and `Toits et clocher de Sainte-Foy` is a bell tower,
 * whatever else their categories mention. Deliberately *not* matched against categories, where the
 * same words appear incidentally — `Blooming flowers with snowy mountains` is a mountain range.
 */
const CLOSE_UP_SUBJECT =
  /\b(?:fleur|flower|blossom|mushroom|champignon|fungus|insect|butterfly|papillon|beetle|spider|clocher|bell tower|church tower|statue|vierge|dortoir|panneau|road sign)\b/i;

/**
 * A field naming a species rather than a place. The outdoor test settles the collision: `Quarry
 * lakes` and `Marine layer` wear the same two-word shape as `Crotalus horridus`, and only the
 * first is describing ground.
 */
function namesATaxon(field: string): boolean {
  return TAXON_SHAPES.some((shape) => shape.test(field)) && !OUTDOOR.test(field);
}

/** The file name, which carries the subject when a file's categories are only a commune. */
function nameOf(photo: PhotoSubject): string {
  return photo.title.replace(/^File:/, '').replace(/\.[a-z0-9]+$/i, '');
}

/**
 * What a subject rule may read.
 *
 * **The invariant: this must be a superset of `qualifying`.** A term that can admit a photograph
 * has to be visible to the rules that reject one, or the filter fails open — while the file name
 * could qualify but not disqualify, a flowering tree qualified on the word "tree" in its own name
 * and no rule could see the `Unidentified Sapindaceae` beside it. Widen `qualifying` and this
 * widens with it, or the hole comes back.
 */
function disqualifying(photo: PhotoSubject): string[] {
  return [...qualifying(photo), photo.description ?? ''];
}

/**
 * What can *qualify* a file: what Commons filed it as, and what its uploader named it. Free text
 * is deliberately excluded — "Bus stop on a hill in Albertville" is a bus stop, and a description
 * mentioning a landform in passing is not evidence that the landform is the subject.
 */
function qualifying(photo: PhotoSubject): string[] {
  return [...(photo.categories ?? []), nameOf(photo)];
}

/**
 * Why this file is not a photograph of the trail's surroundings, or null when it is.
 *
 * A reason rather than a boolean so a drop can be counted and read back; "it returned false" is
 * what made the previous filter's total ineffectiveness invisible for 997 jobs.
 *
 * Ordered so the reason names the strongest evidence. The subject rules run after the outdoor test
 * because they exist to overturn outdoor evidence, not to stand in for its absence — `Knitted
 * objects` wears the same shape as `Crotalus horridus`, and reporting a cowl as a species would be
 * a true verdict for a false reason.
 */
export function offSubjectReason(photo: PhotoSubject): string | null {
  const fields = disqualifying(photo);

  const above = fields.find((field) => FROM_ABOVE.test(field));
  if (above) return `imagery from above (${above.slice(0, 60)})`;

  /*
   * A convenience, not a control. The operator list is unbounded — Satellogic, BlackSky, ICEYE,
   * Capella and every operator founded next year are absent from it — so the category test above
   * is what actually has to catch imagery from orbit. This only shortens the reason when the
   * credit happens to say so.
   */
  if (photo.attribution && ORBITAL_OPERATOR.test(photo.attribution)) {
    return 'credited to a spacecraft operator';
  }

  if (!qualifying(photo).some((field) => OUTDOOR.test(field))) {
    return 'nothing names a landform, a place type or an outdoor setting';
  }

  const subject = disqualifying(photo);

  const wildlife = subject.find((field) => WILDLIFE.test(field));
  if (wildlife) return `subject is wildlife (${wildlife.slice(0, 60)})`;

  const taxon = subject.find(namesATaxon);
  if (taxon) return `subject is a species (${taxon.slice(0, 60)})`;

  const person = subject.find((field) => PEOPLE.test(field));
  if (person) return `subject is a person (${person.slice(0, 60)})`;

  const closeUp = CLOSE_UP_SUBJECT.exec(nameOf(photo));
  if (closeUp) return `subject is a close-up of ${closeUp[0]}`;

  return null;
}
