import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { offSubjectReason, subjectFields } from '../src/photo-subject';
import type { PhotoSubject } from '../src/photo-subject';

/**
 * 123 real Commons geosearch records, collected over production trail centroids on 2026-08-10.
 * Real payloads on purpose: the filter this replaces was tested only against credits containing
 * its own regex literals, which is why it passed CI while keeping 13 of 19 satellite operators.
 */
const CORPUS = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('./fixtures/commons-geosearch.json', import.meta.url)),
    'utf8',
  ),
) as PhotoSubject[];

const find = (needle: string): PhotoSubject => {
  const hit = CORPUS.find((item) => item.title.includes(needle));
  if (!hit) throw new Error(`fixture has no record matching ${needle}`);
  return hit;
};

describe('what reaches a trail gallery', () => {
  it('keeps a photograph of the landform the trail crosses', () => {
    expect(offSubjectReason(find('Doubtful Lake 1'))).toBeNull();
    expect(offSubjectReason(find('The Triplets from Sahale Arm.jpg'))).toBeNull();
    expect(offSubjectReason(find('Alpes 2017-07-28 (36747626604)'))).toBeNull();
  });

  /*
   * The category is only the commune. Commons files a great deal of genuine outdoor photography
   * under nothing but a place name, so the file name and description have to count as evidence
   * or the filter costs more good photographs than it saves.
   */
  it('keeps a photograph whose only category is a commune, on its own description', () => {
    expect(offSubjectReason(find('Ruisseau du Castran'))).toBeNull();
    expect(offSubjectReason(find('Forêt @ Frangy'))).toBeNull();
  });

  it('drops the three subjects that shipped to production', () => {
    // A knitted cowl, boundary markers and a mushroom, all live on trail pages before this.
    expect(
      offSubjectReason({
        title: 'File:Mosaic knit cowl.jpg',
        description: 'This cowl was knit using alternating panels of garter stitch.',
        attribution: 'Heddles',
        categories: ['Knitted objects', 'Knitting stitches', 'Knitwear'],
      }),
    ).toMatch(/landform/);
    expect(offSubjectReason(find('BorNE.GORG.a-01'))).toMatch(/landform/);
    expect(
      offSubjectReason({
        title: 'File:Shaggy-top mushroom (22420985899).jpg',
        description: 'Shaggy-top mushroom',
        attribution: 'Peter Stevens from Seattle',
        categories: ['Fungi in November', 'Unidentified Agaricomycetes'],
      }),
    ).toMatch(/landform/);
  });
});

describe('imagery taken from above', () => {
  /*
   * The operator list is unbounded, so the category is what has to carry this. Commons files an
   * astronaut frame under `ISS Expedition NN Crew Earth Observations` whoever flew it.
   */
  it('drops astronaut photography on its category, not on its credit', () => {
    const iss = find('ISS043-E-93500');
    expect(iss.categories).toContain('ISS Expedition 43 Crew Earth Observations (dump)');
    expect(offSubjectReason(iss)).toMatch(/from above/);
    expect(offSubjectReason({ ...iss, attribution: null })).toMatch(/from above/);
  });

  /*
   * The record that proves the point. Credited to Axelspace Corporation — no space agency
   * acronym anywhere in it — and the previous filter kept it as a trail photograph.
   */
  it('drops a commercial satellite scene whose credit names no agency', () => {
    const etna: PhotoSubject = {
      title: 'File:Mt. Etna, Italy.jpg',
      description: 'Mt. Etna, Italy, as viewed by Hodoyoshi-1 satellite.',
      attribution: 'Axelspace Corporation',
      categories: [
        'Hodoyoshi-1 images',
        'Metropolitan city of Catania',
        'Satellite pictures of Etna in 2016',
        'Satellite pictures of Sicily',
      ],
    };
    expect(offSubjectReason(etna)).toMatch(/from above/);
    // Still caught with the credit stripped, which is what makes it a category test.
    expect(offSubjectReason({ ...etna, attribution: null })).toMatch(/from above/);
  });

  /*
   * Operators absent from `ORBITAL_OPERATOR`'s alternation, on purpose. Feeding that regex its own
   * literals proves only that a list contains what was put in it — the construction that let the
   * previous filter ship. The category is the control being tested; the credit list is a
   * convenience that cannot be completed, and these nine are the proof of that.
   */
  it('drops an operator its credit list has never heard of, on the category', () => {
    for (const operator of [
      'Satellogic',
      'BlackSky',
      'ICEYE',
      'Capella Space',
      'GeoEye',
      'SPOT Image',
      'Deimos Imaging',
      'Nearmap',
      'Vexcel Imaging',
    ]) {
      expect(
        offSubjectReason({
          title: 'File:A place from orbit.jpg',
          attribution: operator,
          categories: ['Satellite pictures of Sicily', 'Mountains of Sicily'],
        }),
      ).toMatch(/from above/);
    }
  });

  it('drops an aerial photograph on its description alone', () => {
    expect(offSubjectReason(find('Puplinge-aerial-3'))).toMatch(/from above/);
  });
});

describe('subjects that are not places', () => {
  it('drops a photograph filed under a species', () => {
    expect(offSubjectReason(find('Rattlesnake'))).not.toBeNull();
    expect(offSubjectReason(find('Cirsium hookerianum'))).not.toBeNull();
    expect(
      offSubjectReason({
        title: 'File:A thistle by the path.jpg',
        categories: ['Cirsium hookerianum', 'Trails in Montana'],
      }),
    ).toMatch(/species/);
  });

  /*
   * `Quarry lakes` wears the same `Capitalised lowercase` shape as `Crotalus horridus`. The
   * outdoor vocabulary is what tells them apart, and without that clause this photograph of a
   * lake was dropped as a species.
   */
  it('does not mistake an English category for a species name', () => {
    expect(offSubjectReason(find('Clouds over Horseshoe Lake'))).toBeNull();
  });

  it('drops a portrait filed under the people in it', () => {
    expect(offSubjectReason(find('Glee and Hazel Davis'))).toMatch(/person/);
  });

  /*
   * Both reached a live trail page in the re-seed that produced this filter's second round. The
   * bus stop qualified on a description reading "Bus stop on a hill in Albertville" — which is
   * why free text disqualifies but no longer qualifies.
   */
  it('does not let a landform mentioned in passing qualify the subject', () => {
    expect(
      offSubjectReason({
        title: 'File:Albertville - bus stop.jpg',
        description: 'Bus stop on a hill in Albertville, France.',
        categories: ['Transport in Albertville'],
      }),
    ).toMatch(/landform/);
  });

  /*
   * Its own categories, verbatim from Commons. Rejected on the outdoor test rather than on the
   * wildlife rule: `Animals at Santa Teresa County Park` states its subject before the preposition,
   * and "animals" is not outdoor vocabulary, so nothing here qualifies in the first place. The
   * wildlife rule still guards the case where something else in the record does qualify — see the
   * ducks below.
   */
  it('drops an animal filed under a subspecies as well as a species', () => {
    expect(
      offSubjectReason({
        title: 'File:Coyote in Santa Teresa County Park (26344743858).jpg',
        description: 'Coyote in Santa Teresa County Park',
        categories: [
          'Animals at Santa Teresa County Park',
          'Canis latrans in California',
          'Canis latrans ochropus',
        ],
      }),
    ).toBe('nothing names a landform, a place type or an outdoor setting');
  });

  /*
   * The wildlife rule's live case: `Alameda Creek` qualifies the record on a real landform, and
   * `Birds of California in water` overturns it. Both are this file's own Commons categories, so
   * the rule is being asked about a photograph rather than about its own alternation.
   */
  it('overturns a real landform category when the file is filed under birds', () => {
    expect(offSubjectReason(find('Ducks in Alameda Creek'))).toMatch(/wildlife/);
  });

  /*
   * The species rule has to stay narrow. Allowing a third word matched `Fluvial sediment
   * transport` and allowing a trailing ` in <place>` matched `Low tide in Canada` — both real
   * landscape photographs, dropped to catch one animal that the wildlife prefix catches anyway.
   */
  it('does not read an English phrase as a species name', () => {
    expect(offSubjectReason(find('Sinuous dunes mcr1'))).toBeNull();
    expect(offSubjectReason(find('Alpes 2017-07-28 (37199590120)'))).toBeNull();
    expect(offSubjectReason(find('Clouds over Horseshoe Lake'))).toBeNull();
  });

  it('drops the built environment that happens to sit near a path', () => {
    // A prison, road signs and a shop, all inside the search radius of a real trail.
    expect(offSubjectReason(find('Prison de Champ-Dollon 01'))).toMatch(/landform/);
    expect(offSubjectReason(find('Panneau Ballaison'))).toMatch(/landform/);
    expect(offSubjectReason(find("Mark's Work Wearhouse"))).toMatch(/landform/);
  });

  /*
   * The French region `Auvergne-Rhône-Alpes` contains `Alpes`, so a bare `alp` in the outdoor
   * vocabulary would admit anything filed under it. Asserting the exact reason is what makes this
   * a guard: `.not.toBeNull()` passed with `alp` restored, because a sibling rule answered instead.
   * This record has no sibling rule to fall back on — the region is its only would-be qualifier.
   */
  it('does not read a landform out of the name of a French region', () => {
    expect(
      offSubjectReason({
        title: 'File:Vipera aspis 146935719.jpg',
        categories: ['Vipera aspis in Auvergne-Rhône-Alpes'],
      }),
    ).toBe('nothing names a landform, a place type or an outdoor setting');
  });
});

/**
 * The five records that reached live trail galleries because a term in the file name could
 * qualify a photograph while no rejecting rule could read that same file name. Two of them were
 * a trail's entire gallery. The invariant restored is that disqualification sees at least
 * everything qualification sees.
 */
describe('what qualification can see, disqualification can see', () => {
  it('drops a flowering tree that qualified on the word "tree" in its own name', () => {
    expect(
      offSubjectReason({
        title: 'File:Three sided pod flowering tree - panoramio.jpg',
        categories: ['Koelreuteria', 'Unidentified Sapindaceae'],
      }),
    ).toMatch(/species/);
  });

  it('drops a wallflower whose species category carries a plant-part qualifier', () => {
    expect(
      offSubjectReason({
        title: 'File:Erysimum teretifolium 2.jpg',
        categories: ['Erysimum (flowers)', 'Parks in Santa Cruz County, California'],
      }),
    ).toMatch(/species/);
  });

  it('drops a close-up the uploader named as one, whatever its categories mention', () => {
    expect(
      offSubjectReason({
        title: 'File:Fleur @ Mieussy (51091330231).jpg',
        categories: ['Nature of Mieussy'],
      }),
    ).toMatch(/close-up/);
    expect(
      offSubjectReason({
        title: 'File:Toits et clocher de Sainte-Foy-Tarentaise enneiges.JPG',
        categories: ['Church towers in Savoie', 'Snow in Savoie'],
      }),
    ).toMatch(/close-up/);
  });

  /*
   * The counterweight. `Blooming flowers with snowy mountains` is a category on a real mountain
   * photograph, so the close-up vocabulary reads the file name only — where it is the uploader's
   * own statement of subject rather than an incidental mention.
   */
  it('does not read a close-up out of a category on a landscape photograph', () => {
    expect(offSubjectReason(find('The Triplets from Sahale Arm.jpg'))).toBeNull();
  });

  it('does not mistake a disambiguated place name for a species', () => {
    // `Bonnevaux (Doubs)` is a commune and `Missionpeak (cropped)` is a crop; accepting any
    // bracketed qualifier as taxonomic dropped both.
    expect(offSubjectReason(find('Bonnevaux (Doubs) - vue générale'))).toBeNull();
    expect(offSubjectReason(find('Missionpeak (cropped)'))).toBeNull();
  });
});

/**
 * The class that reached live trail galleries after the subject filter shipped: a landform word
 * that was never the subject, reached through the locative tail of a category or through a county
 * name. Twelve of 56 live photographs, two whole galleries among them.
 *
 * Every record here is the payload Commons returns for a file that was live on a trail page, and
 * every assertion below fails if its rule is removed from `photo-subject.ts`.
 */
describe('a place a photograph was taken is not its subject', () => {
  /*
   * Both were the entire gallery of `Trail of Two Kitties`. The photograph is a macro of ice
   * filaments on rotting wood; "Island" reaches the outdoor test only as part of the county the
   * camera stood in, and again as the tail of the file's own name.
   */
  it('drops a macro whose only landform word is the county it was shot in', () => {
    for (const record of [
      'Hair ice of Whidbey Island (1 of 7)',
      'Hair ice of Whidbey Island (7 of 7)',
    ]) {
      expect(offSubjectReason(find(record))).toBe(
        'nothing names a landform, a place type or an outdoor setting',
      );
    }
  });

  /* A book box. `Lake` is in the arboretum's name, which is where the box stands. */
  it('drops an artefact whose category names the place it stands in', () => {
    expect(
      offSubjectReason(find('Little Free Library at Lake Wilderness Arboretum (2024) - 1')),
    ).toBe('nothing names a landform, a place type or an outdoor setting');
  });

  /*
   * The counterweight, and the reason the cut is not simply "take the text before the preposition".
   * `North-west side of Mont Blanc` and `Panoramics of Jura mountains` name a way of looking at a
   * mountain, so the subject is in the tail and cutting at the preposition would discard the only
   * evidence either file carries. Both are real Mont Blanc / Jura landscape photographs.
   */
  it('keeps a landscape whose category states an aspect before naming the landform', () => {
    expect(offSubjectReason(find('MassifDuMontBlanc00'))).toBeNull();
    expect(offSubjectReason(find('Pano Morez vu Dade nuageux'))).toBeNull();
  });

  /*
   * Masking a county must not cost the landform beside it. `Joseph D. Grant County Park` is a
   * park, `Grant Lake (Santa Clara County, California)` is a lake, and `Water Fall in the Desert`
   * survives on its own name alone once `Grant County, Washington` — its only category — is gone.
   */
  it('keeps a landform that shares a field with a county name', () => {
    expect(offSubjectReason(find('Joseph D. Grant Santa Clara County Park'))).toBeNull();
    expect(offSubjectReason(find('MG 1145'))).toBeNull();
    expect(offSubjectReason(find('Water Fall in the Desert'))).toBeNull();
    expect(
      offSubjectReason(find('2022-05-20, Lake Alice, King County, Washington, 01')),
    ).toBeNull();
  });

  /*
   * Still admitted, and recorded here so the residue is visible rather than assumed closed.
   * `Lake Wilderness Arboretum` carries no preposition and no county — "Lake" is simply part of a
   * proper name — so no rule in this file separates a book box shot there from a lakeside view.
   * The playground is the vocabulary's own coarseness: "park" cannot tell a municipal one from a
   * national one.
   */
  it('still admits what no rule here can separate from a genuine place name', () => {
    expect(offSubjectReason(find('2025-01-18, Lake Wilderness Arboretum, 093934'))).toBeNull();
    expect(offSubjectReason(find('Fruitland Park, 2010 Kennewick Washington'))).toBeNull();
  });
});

/**
 * The superset invariant, asserted rather than argued.
 *
 * Qualification reads a narrowed view of the fields disqualification reads, so a term can never
 * admit a photograph that no rejecting rule can see. Narrowing only ever removes words, which is
 * what this checks over every record in the corpus.
 */
describe('what qualification reads, disqualification reads', () => {
  it('never lets a qualifying field carry a word no disqualifying field carries', () => {
    const words = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
    for (const photo of CORPUS) {
      const { qualifying, disqualifying } = subjectFields(photo);
      const available = new Set(disqualifying.flatMap(words));
      for (const field of qualifying) {
        for (const word of words(field)) {
          expect(available, `${photo.title}: "${field}"`).toContain(word);
        }
      }
    }
  });
});

describe('the filter over the whole corpus', () => {
  /*
   * A filter whose job is to drop things and drops nothing is broken, and reading a 0% drop rate
   * as evidence of innocence is what let the previous one ship. This asserts the rate is real in
   * both directions rather than asserting a single verdict.
   */
  it('drops most of what geosearch returns and keeps a real share of it', () => {
    const kept = CORPUS.filter((item) => offSubjectReason(item) === null);
    expect(kept.length).toBeGreaterThan(25);
    expect(kept.length).toBeLessThan(CORPUS.length - 40);
  });

  it('lets nothing through that names a species, a person or imagery from above', () => {
    for (const item of CORPUS) {
      if (offSubjectReason(item) !== null) continue;
      const fields = [...(item.categories ?? []), item.title, item.description ?? ''].join(' ');
      expect(fields).not.toMatch(/Crew Earth Observations|Satellite pictures|aerial view/i);
    }
  });
});
