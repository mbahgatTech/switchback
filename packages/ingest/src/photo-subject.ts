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
 * `Genus species`, optionally qualified — Commons files a photograph of a species under it.
 * Two words only: allowing a third matched `Fluvial sediment transport`, and allowing a trailing
 * ` in <place>` matched `Low tide in Canada`. Both cost real landscape photographs.
 */
const BINOMIAL = /^[A-Z][a-z]+ (?:×\s*)?[a-z-]+(?: \(.+\))?$/;

/**
 * The noun Commons leads a wildlife category with. This is what catches an animal whose species
 * category is qualified out of the binomial shape — a coyote filed under both
 * `Canis latrans in California` and `Animals at Santa Teresa County Park`.
 */
const WILDLIFE =
  /^(?:animals|fauna|flora|birds|mammals|reptiles|amphibians|insects|arachnids|fungi|lichens|mosses)\b/i;

/** Commons files a portrait under the people in it. */
const PEOPLE =
  /^(?:husbands and wives|pioneers of|mountaineers from|portraits of|people of|men of|women of|children of|families)/i;

/**
 * A category naming a species rather than a place. The outdoor test settles the collision:
 * `Quarry lakes` and `Marine layer` wear the same two-word shape as `Crotalus horridus`, and only
 * the first is describing ground.
 */
function namesASpecies(category: string): boolean {
  return BINOMIAL.test(category) && !OUTDOOR.test(category);
}

/** The file name, which carries the subject when a file's categories are only a commune. */
function nameOf(photo: PhotoSubject): string {
  return photo.title.replace(/^File:/, '').replace(/\.[a-z0-9]+$/i, '');
}

/**
 * Everything that can *disqualify* a file. Free text counts here — "Puplinge, aerial view" is the
 * only place that aerial photograph admits what it is.
 */
function disqualifying(photo: PhotoSubject): string[] {
  return [...(photo.categories ?? []), nameOf(photo), photo.description ?? ''];
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
 * Ordered so the reason names the strongest evidence. The species and people tests run last
 * because they exist to overturn outdoor evidence, not to stand in for its absence — `Knitted
 * objects` wears the same shape as `Crotalus horridus`, and reporting a cowl as a species would
 * be a true verdict for a false reason.
 */
export function offSubjectReason(photo: PhotoSubject): string | null {
  const above = disqualifying(photo).find((field) => FROM_ABOVE.test(field));
  if (above) return `imagery from above (${above.slice(0, 60)})`;

  if (photo.attribution && ORBITAL_OPERATOR.test(photo.attribution)) {
    return 'credited to a spacecraft operator';
  }

  if (!qualifying(photo).some((field) => OUTDOOR.test(field))) {
    return 'nothing names a landform, a place type or an outdoor setting';
  }

  const categories = photo.categories ?? [];

  const wildlife = categories.find((category) => WILDLIFE.test(category));
  if (wildlife) return `subject is wildlife (${wildlife})`;

  const species = categories.find(namesASpecies);
  if (species) return `subject is a species (${species})`;

  const person = categories.find((category) => PEOPLE.test(category));
  if (person) return `subject is a person (${person})`;

  return null;
}
