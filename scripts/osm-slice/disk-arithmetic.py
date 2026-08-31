"""Disk arithmetic for the P4 kill gate. Every input is a measured figure; nothing is estimated.

Superseded by `disk-widened.py`. The sizes below carry a duplicated GiST index on every geometry
table — osm2pgsql creates one and `measure-extract.sh` created a second — so each overstates its
slice, by 94 MB of 1,056 MB on northern California. Kept as the record of what the first gate
measured; use the widened script for figures.
"""

GIB = 1024**3

# pg_total_relation_size, measured after VACUUM ANALYZE and index creation.
IDAHO = {"trail_way": 145_580_032, "trail_relation": 1_933_312, "network_way": 238_403_584}
NORCAL = {"trail_way": 361_545_728, "trail_relation": 12_271_616, "network_way": 673_808_384}

# ST_Area(geography) over the Geofabrik .poly, km2.
IDAHO_KM2 = 217_780
NORCAL_KM2 = 420_222  # includes ocean, so norcal densities understate land density

# Per fixture tile: overhead-corrected bytes and tile area, from slice-bytes.sql.
SPARSE = {"km2": 2770.9, "trail_way": 1_004_530, "trail_relation": 91_299, "network_way": 3_620_975}
DENSE = {"km2": 3855.4, "trail_way": 50_993_609, "trail_relation": 991_897, "network_way": 90_375_450}

# Tuned trail slice: named ways union route-member ways only. raw pg_column_size x overhead factor.
TUNED_SPARSE_TRAIL_WAY = 427_618 * 1.226
TUNED_DENSE_TRAIL_WAY = 3_706_588 * 1.287

PROD_DISK = 64 * GIB
BUDGET = 0.40 * PROD_DISK / 2  # doubled for the staging-schema swap


def line(label, per_km2):
    conus = per_km2 * 8_080_000
    pct = (conus * 2) / PROD_DISK * 100
    print(
        f"{label:<46} {per_km2:>10,.0f} B/km2 | CONUS {conus/1e9:>7.2f} GB"
        f" | doubled {pct:>6.1f}% of 64GiB | {'OK' if conus <= BUDGET else 'OVER'}"
    )


print(f"budget: slice must be <= {BUDGET/1e9:.2f} GB (40% of 64GiB, halved for the staging swap)\n")

print("-- region-level density (whole extract / poly area) --")
line("Idaho  TRAIL (naive slice)", (IDAHO["trail_way"] + IDAHO["trail_relation"]) / IDAHO_KM2)
line("Idaho  NETWORK z12 foot-legal", IDAHO["network_way"] / IDAHO_KM2)
line("NorCal TRAIL (naive slice)", (NORCAL["trail_way"] + NORCAL["trail_relation"]) / NORCAL_KM2)
line("NorCal NETWORK z12 foot-legal", NORCAL["network_way"] / NORCAL_KM2)

print("\n-- per-tile density (overhead-corrected) --")
line("sparse tile TRAIL (naive)", (SPARSE["trail_way"] + SPARSE["trail_relation"]) / SPARSE["km2"])
line("sparse tile TRAIL (tuned)", (TUNED_SPARSE_TRAIL_WAY + SPARSE["trail_relation"]) / SPARSE["km2"])
line("sparse tile NETWORK z12 foot-legal", SPARSE["network_way"] / SPARSE["km2"])
line("dense tile TRAIL (naive)", (DENSE["trail_way"] + DENSE["trail_relation"]) / DENSE["km2"])
line("dense tile TRAIL (tuned)", (TUNED_DENSE_TRAIL_WAY + DENSE["trail_relation"]) / DENSE["km2"])
line("dense tile NETWORK z12 foot-legal", DENSE["network_way"] / DENSE["km2"])

print("\n-- combined trail+network --")
line("Idaho  region, both slices", (sum(IDAHO.values())) / IDAHO_KM2)
line("NorCal region, both slices", (sum(NORCAL.values())) / NORCAL_KM2)
line("dense tile, both (tuned trail)",
     (TUNED_DENSE_TRAIL_WAY + DENSE["trail_relation"] + DENSE["network_way"]) / DENSE["km2"])

print("\n-- how much ground fits in the budget --")
for label, d in [
    ("TRAIL tuned @ dense density", (TUNED_DENSE_TRAIL_WAY + DENSE["trail_relation"]) / DENSE["km2"]),
    ("TRAIL naive @ dense density", (DENSE["trail_way"] + DENSE["trail_relation"]) / DENSE["km2"]),
    ("TRAIL @ Idaho region density", (IDAHO["trail_way"] + IDAHO["trail_relation"]) / IDAHO_KM2),
    ("BOTH @ Idaho region density", sum(IDAHO.values()) / IDAHO_KM2),
    ("BOTH @ dense tile density (tuned)",
     (TUNED_DENSE_TRAIL_WAY + DENSE["trail_relation"] + DENSE["network_way"]) / DENSE["km2"]),
]:
    print(f"{label:<40} {BUDGET/d:>14,.0f} km2  (CONUS = 8,080,000 km2)")
