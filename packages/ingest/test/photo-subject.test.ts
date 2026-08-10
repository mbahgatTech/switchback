import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { offSubjectReason } from '../src/photo-subject';
import type { PhotoSubject } from '../src/photo-subject';

/**
 * 105 real Commons geosearch records, collected over production trail centroids on 2026-08-10.
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

  it('drops every commercial operator the credit-only filter kept', () => {
    // None of these appear in the previous filter's four acronyms.
    for (const operator of [
      'Planet Labs',
      'Maxar Technologies',
      'DigitalGlobe',
      'Airbus Defence and Space',
      'European Space Agency',
      'Roscosmos',
      'ISRO',
    ]) {
      expect(
        offSubjectReason({
          title: 'File:Somewhere from orbit.jpg',
          attribution: operator,
          categories: ['Mountains of somewhere'],
        }),
      ).toMatch(/spacecraft operator/);
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
    ).toMatch(/wildlife/);
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
   * vocabulary admitted three photographs of a viper. The term is gone; this holds it gone.
   */
  it('does not read a landform out of the name of a French region', () => {
    expect(offSubjectReason(find('Vipera aspis 146935719'))).not.toBeNull();
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
